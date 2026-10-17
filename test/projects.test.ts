import { once } from "node:events";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, symlink } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, connect } from "../src/client.ts";
import { runHost } from "../src/host.ts";
import { projectsPath, resolveProject, statePaths, stateRoot } from "../src/protocol.ts";
import { cli, handleOf, models, root, setUp, startHost, tearDown, until } from "./helpers.ts";

let dirA: string;
let dirB: string;

beforeAll(async () => {
	await setUp();
	dirA = join(root, "a");
	dirB = join(root, "b");
	await mkdir(dirA);
	await mkdir(dirB);
});

afterAll(async () => {
	await tearDown();
});

describe("projects", { timeout: 30_000 }, () => {
	it("resolves the project from HARNESS_PROJECT, then the longest directory, then main", () => {
		const projects = { foo: "/a/foo", "foo-bar": "/a/foo-bar", inner: "/a/foo/inner", same: "/a/foo" };
		const cases: [NodeJS.ProcessEnv, string, string][] = [
			[{}, "/a/foo", "foo"],
			[{}, "/a/foo/src", "foo"],
			[{}, "/a/foo/inner/src", "inner"],
			[{}, "/a/foo-bar/src", "foo-bar"],
			[{}, "/a/foobar", "main"],
			[{}, "/elsewhere", "main"],
			[{ HARNESS_PROJECT: "foo-bar" }, "/a/foo/inner", "foo-bar"],
			[{ HARNESS_PROJECT: "main" }, "/a/foo", "main"],
		];
		for (const [env, cwd, project] of cases) expect(resolveProject(env, cwd, projects)).toBe(project);
		expect(() => resolveProject({ HARNESS_PROJECT: "nope" }, "/a/foo", projects)).toThrow(
			"Unknown harness project: nope",
		);
	});

	it("creates a project and lists the projects", async () => {
		const failures: [string[], string][] = [
			[["create", "Bad", "--cwd", dirA], "A project name has 1 to 32 characters"],
			[["create", "main", "--cwd", dirA], "A project cannot have the name main"],
			[["create", "spawn", "--cwd", dirA], "A project cannot have the name spawn"],
			[["create", "missing", "--cwd", join(root, "missing")], `No such directory: ${join(root, "missing")}`],
		];
		for (const [args, error] of failures) {
			const result = await cli(args);
			expect(result.code).toBe(1);
			expect(result.stderr).toContain(error);
		}
		expect(existsSync(projectsPath())).toBe(false);

		// A relative --cwd through a symbolic link is stored as its real path.
		await symlink(dirA, join(root, "link"));
		const real = realpathSync(dirA);
		expect(await cli(["create", "a", "--cwd", "link"])).toEqual({
			code: 0,
			stdout: `Created a (${real})\n`,
			stderr: "",
		});
		expect(JSON.parse(readFileSync(projectsPath(), "utf8"))).toEqual({ a: real });
		const duplicate = await cli(["create", "a", "--cwd", dirB]);
		expect(duplicate.code).toBe(1);
		expect(duplicate.stderr).toContain(`The project a exists (${real})`);
		expect((await cli(["create", "b", "--cwd", dirB])).code).toBe(0);
		expect((await cli(["projects"])).stdout).toBe(`a  ${real}\nb  ${realpathSync(dirB)}\nmain\n`);
	});

	it("routes each command to the host of its project", async () => {
		const hostA = await startHost("a");
		const hostB = await startHost("b");
		try {
			const childA = handleOf(await cli(["spawn", "--prompt", "In a"], {}, dirA));
			await cli(["wait", childA], {}, dirA);
			const childB = handleOf(await cli(["spawn", "--prompt", "Environment"], {}, dirB));
			expect((await cli(["wait", childB], {}, dirB)).stdout).toMatch(/Tool said: \S+ faux faux-1 medium b\n/);
			const listA = (await cli(["list"], {}, dirA)).stdout;
			expect(listA).toContain(childA);
			expect(listA).not.toContain(childB);
			const listB = (await cli(["list"], {}, dirB)).stdout;
			expect(listB).toContain(childB);
			expect(listB).not.toContain(childA);
			// --project wins over HARNESS_PROJECT, which wins over the cwd.
			expect((await cli(["list"], { HARNESS_PROJECT: "b" }, dirA)).stdout).toBe(listB);
			expect((await cli(["list", "--project", "a"], { HARNESS_PROJECT: "b" }, dirB)).stdout).toBe(listA);
			const unknown = await cli(["--project", "nope", "list"]);
			expect(unknown.code).toBe(1);
			expect(unknown.stderr).toBe("Unknown harness project: nope\n");
		} finally {
			await hostA?.close();
			await hostB?.close();
		}
	});

	it("starts one host process for each project", async () => {
		const pids: number[] = [];
		try {
			for (const dir of [dirA, dirB]) {
				expect((await cli(["list"], {}, dir)).code).toBe(0);
			}
			for (const project of ["a", "b"]) {
				process.env.HARNESS_PROJECT = project;
				const client = await connect({ start: false });
				client?.close();
				pids.push(client?.pid ?? 0);
				expect(existsSync(join(statePaths(project).dir, "durable.sqlite"))).toBe(true);
			}
			expect(pids[0]).toBeGreaterThan(0);
			expect(pids[1]).toBeGreaterThan(0);
			expect(pids[0]).not.toBe(pids[1]);
		} finally {
			delete process.env.HARNESS_PROJECT;
			for (const pid of pids) if (pid > 0) process.kill(pid, "SIGTERM");
		}
		await until(() => !existsSync(statePaths("a").socket) && !existsSync(statePaths("b").socket));
	});

	it("refuses a host of another project", async () => {
		process.env.XDG_STATE_HOME = join(root, "state2");
		const host = await runHost({ stateDir: statePaths("main").dir, project: "a", models });
		try {
			await expect(connect({ start: false })).rejects.toThrow(
				`The harness host (pid ${process.pid}) at ${statePaths("main").socket} runs project a, not main`,
			);
		} finally {
			await host?.close();
			process.env.XDG_STATE_HOME = join(root, "state");
		}
	});

	it("moves the store of an old host into main", async () => {
		// An old host keeps its store in the state root.
		const old = await runHost({ stateDir: stateRoot(), project: "old", models });
		const socket = createConnection(join(stateRoot(), "host.sock"));
		await once(socket, "connect");
		const client = new Client(socket);
		const child = await client.request({
			type: "spawn",
			requestId: "old-spawn",
			caller: "cli",
			provider: "faux",
			model: "faux-1",
			callerThinking: "medium",
			cwd: dirA,
			prompt: "Old child",
		});
		client.close();

		// While the old host holds its lock, the new main host does not take its store.
		await expect(startHost()).rejects.toThrow(`An older harness host runs on ${join(stateRoot(), "durable.sqlite")}`);
		await old?.close();

		const host = await startHost();
		try {
			expect(existsSync(join(stateRoot(), "durable.sqlite"))).toBe(false);
			expect((await cli(["list"])).stdout).toContain(child.handle);
		} finally {
			await host?.close();
		}
	});

	it("refuses to start main while an old host listens on the old socket", async () => {
		const path = join(stateRoot(), "host.sock");
		const server = createServer((connection) => connection.destroy());
		await new Promise<void>((resolveListen) => server.listen(path, resolveListen));
		try {
			await expect(connect({ start: true })).rejects.toThrow(
				`An older harness host listens on ${path}; stop it and run the command again`,
			);
		} finally {
			server.close();
		}
	});
});
