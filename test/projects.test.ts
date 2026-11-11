import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { connect } from "../src/client/client.ts";
import { statePaths } from "../src/protocol/paths.ts";
import { addProject, projectsPath, resolveProject } from "../src/protocol/projects.ts";
import {
	cli,
	fakePi,
	handleOf,
	logLines,
	root,
	setUp,
	startHost,
	startHostProcess,
	tearDown,
	until,
} from "./helpers.ts";

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

	it("prints the version of the package", async () => {
		const { version } = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
		expect(await cli(["--version"])).toEqual({ code: 0, stdout: `${version}\n`, stderr: "" });
	});

	it("refuses a project with the name of a command", () => {
		expect(() => addProject("spawn", dirA)).toThrow("A project cannot have the name spawn");
		expect(existsSync(projectsPath())).toBe(false);
	});

	it("creates a project and lists the projects", async () => {
		const failures: [string[], string][] = [
			[["create", "Bad", "--cwd", dirA], "A project name has 1 to 32 characters"],
			[["create", "main", "--cwd", dirA], "A project cannot have the name main"],
			[["create", "spawn", "--cwd", dirA], "A project cannot have the name spawn"],
			[["create", "todo", "--cwd", dirA], "A project cannot have the name todo"],
			[["create", "page", "--cwd", dirA], "A project cannot have the name page"],
			[["create", "tree", "--cwd", dirA], "A project cannot have the name tree"],
			[["create", "missing", "--cwd", join(root, "missing")], `No such directory: ${join(root, "missing")}`],
		];

		const results = await Promise.all(failures.map(([args]) => cli(args)));
		expect(results).toEqual(
			failures.map(([, error]) => expect.objectContaining({ code: 1, stderr: expect.stringContaining(error) })),
		);
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

		const [duplicate, created] = await Promise.all([
			cli(["create", "a", "--cwd", dirB]),
			cli(["create", "b", "--cwd", dirB]),
		]);

		expect(duplicate.code).toBe(1);
		expect(duplicate.stderr).toContain(`The project a exists (${real})`);
		expect(created.code).toBe(0);
		expect((await cli(["projects"])).stdout).toBe(`a  ${real}\nb  ${realpathSync(dirB)}\nmain\n`);
	});

	it("routes each command to the host of its project", async () => {
		const hostA = await startHost("a");
		const hostB = await startHost("b");

		try {
			const [spawnA, spawnB] = await Promise.all([
				cli(["spawn", "--prompt", "In a"], {}, dirA),
				cli(["spawn", "--prompt", "Environment"], {}, dirB),
			]);

			const childA = handleOf(spawnA);
			const childB = handleOf(spawnB);
			const [, waitB] = await Promise.all([cli(["wait", childA], {}, dirA), cli(["wait", childB], {}, dirB)]);
			expect(waitB.stdout).toMatch(/Tool said: \S+ faux faux-1 medium b\n/);

			const [listA, listB, listByEnv, listByOption, optionAfter, unknown] = await Promise.all([
				cli(["list"], {}, dirA),
				cli(["list"], {}, dirB),
				// --project wins over HARNESS_PROJECT, which wins over the cwd.
				cli(["list"], { HARNESS_PROJECT: "b" }, dirA),
				cli(["--project", "a", "list"], { HARNESS_PROJECT: "b" }, dirB),
				// After the command, --project is an argument of that command, not the project.
				cli(["list", "--project", "a"], {}, dirB),
				cli(["--project", "nope", "list"]),
			]);

			expect(listA.stdout).toContain(childA);
			expect(listA.stdout).not.toContain(childB);
			expect(listB.stdout).toContain(childB);
			expect(listB.stdout).not.toContain(childA);
			expect(listByEnv.stdout).toBe(listB.stdout);
			expect(listByOption.stdout).toBe(listA.stdout);
			expect(optionAfter.code).toBe(1);
			expect(unknown.code).toBe(1);
			expect(unknown.stderr).toBe("Unknown harness project: nope\n");
		} finally {
			await hostA?.close();
			await hostB?.close();
		}
	});

	it("opens Pi on the --project of attach, and does not pass that project to Pi in HARNESS_PROJECT", async () => {
		const hostA = await startHost("a");
		const pi = await fakePi();

		try {
			const handle = handleOf(await cli(["spawn", "--prompt", "Attach in a"], {}, dirA));
			expect(await cli(["--project", "a", "attach", handle], pi.env, dirB)).toMatchObject({ code: 3, stderr: "" });
			expect(logLines(pi.log)).toEqual([`--harness a --harness-child ${handle} HARNESS_PROJECT=`]);
		} finally {
			await hostA?.close();
		}
	});

	it("starts one host process for each project", async () => {
		const pids = new Map<string, number>();

		try {
			const [clientA, clientB] = await Promise.all([startHostProcess("a"), startHostProcess("b")]);
			pids.set("a", clientA.pid);
			pids.set("b", clientB.pid);
			clientA.close();
			clientB.close();
			expect(clientA.pid).toBeGreaterThan(0);
			expect(clientA.pid).not.toBe(process.pid);
			expect(clientB.pid).not.toBe(process.pid);
			expect(clientB.pid).not.toBe(clientA.pid);

			// The project option wins over HARNESS_PROJECT.
			const routes: [string, string][] = [
				["a", "b"],
				["b", "a"],
			];

			for (const [project, other] of routes) {
				process.env.HARNESS_PROJECT = other;
				const client = await connect({ start: false, project });
				client?.close();
				expect(client?.pid).toBe(pids.get(project));
				expect(existsSync(join(statePaths(project).dir, "durable.sqlite"))).toBe(true);
			}
		} finally {
			delete process.env.HARNESS_PROJECT;

			// A host of this process, such as one of a test that timed out and has not closed its hosts yet, is not stopped.
			for (const pid of pids.values()) if (pid > 0 && pid !== process.pid) process.kill(pid, "SIGTERM");
		}

		await until(() => !existsSync(statePaths("a").socket) && !existsSync(statePaths("b").socket));
	});

	it("refuses a projects file with an invalid project", async () => {
		const valid = readFileSync(projectsPath(), "utf8");

		try {
			for (const projects of [{ "../up": realpathSync(dirA) }, { c: "relative" }, { c: 1 }]) {
				writeFileSync(projectsPath(), JSON.stringify(projects));
				const result = await cli(["projects"]);
				expect(result.code).toBe(1);
				expect(result.stderr).toContain(`${projectsPath()} has an invalid project:`);
			}
		} finally {
			writeFileSync(projectsPath(), valid);
		}
	});
});
