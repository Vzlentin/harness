import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { connect } from "../src/client/client.ts";
import { addHost, hostsPath, resolveHost } from "../src/protocol/hosts.ts";
import { statePaths } from "../src/protocol/paths.ts";
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

describe("hosts", { timeout: 30_000 }, () => {
	it("resolves the host from HARNESS_HOST, then the longest directory, then main", () => {
		const hosts = { foo: "/a/foo", "foo-bar": "/a/foo-bar", inner: "/a/foo/inner", same: "/a/foo" };

		const cases: [NodeJS.ProcessEnv, string, string][] = [
			[{}, "/a/foo", "foo"],
			[{}, "/a/foo/src", "foo"],
			[{}, "/a/foo/inner/src", "inner"],
			[{}, "/a/foo-bar/src", "foo-bar"],
			[{}, "/a/foobar", "main"],
			[{}, "/elsewhere", "main"],
			[{ HARNESS_HOST: "foo-bar" }, "/a/foo/inner", "foo-bar"],
			[{ HARNESS_HOST: "main" }, "/a/foo", "main"],
		];

		for (const [env, cwd, host] of cases) expect(resolveHost(env, cwd, hosts)).toBe(host);
		expect(() => resolveHost({ HARNESS_HOST: "nope" }, "/a/foo", hosts)).toThrow("Unknown harness host: nope");
	});

	it("compares the current directory and the host directories by their real paths", async () => {
		const base = realpathSync(root);
		const real = join(base, "real");
		const link = join(base, "real-link");
		const missing = join(base, "missing-dir");
		await mkdir(join(real, "src"), { recursive: true });
		await symlink(real, link);

		const cases: [Record<string, string>, string, string][] = [
			[{ p: link }, real, "p"],
			[{ p: link }, join(real, "src"), "p"],
			[{ p: real }, link, "p"],
			[{ p: real }, join(link, "src"), "p"],
			// The same real directory: the first one created wins, whatever the length of the written path.
			[{ first: real, second: link }, join(link, "src"), "first"],
			[{ first: link, second: real }, real, "first"],
			// A path that does not exist is compared as written.
			[{ p: missing }, join(missing, "src"), "p"],
			[{ p: missing }, real, "main"],
		];

		for (const [hosts, cwd, host] of cases) expect(resolveHost({}, cwd, hosts)).toBe(host);
	});

	it("prints the version of the package", async () => {
		const { version } = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
		expect(await cli(["--version"])).toEqual({ code: 0, stdout: `${version}\n`, stderr: "" });
	});

	it("prints the usage for item, rule, parley and store, which are not commands", async () => {
		const results = await Promise.all(
			[["item", "list"], ["rule"], ["parley", "show", "x"], ["store", "load", "f"]].map((args) => cli(args)),
		);

		expect(results).toEqual(
			results.map(() => expect.objectContaining({ code: 1, stderr: expect.stringMatching(/^Usage:/) })),
		);
	});

	it("refuses a host with the name of a command", () => {
		expect(() => addHost("spawn", dirA)).toThrow("A host cannot have the name spawn");
		expect(existsSync(hostsPath())).toBe(false);
	});

	it("creates a host and lists the hosts", async () => {
		const failures: [string[], string][] = [
			[["create", "Bad", "--cwd", dirA], "A host name has 1 to 32 characters"],
			[["create", "main", "--cwd", dirA], "A host cannot have the name main"],
			[["create", "spawn", "--cwd", dirA], "A host cannot have the name spawn"],
			[["create", "todo", "--cwd", dirA], "A host cannot have the name todo"],
			[["create", "page", "--cwd", dirA], "A host cannot have the name page"],
			[["create", "tree", "--cwd", dirA], "A host cannot have the name tree"],
			[["create", "missing", "--cwd", join(root, "missing")], `No such directory: ${join(root, "missing")}`],
		];

		const results = await Promise.all(failures.map(([args]) => cli(args)));
		expect(results).toEqual(
			failures.map(([, error]) => expect.objectContaining({ code: 1, stderr: expect.stringContaining(error) })),
		);
		expect(existsSync(hostsPath())).toBe(false);

		// A relative --cwd through a symbolic link is stored as its real path.
		await symlink(dirA, join(root, "link"));
		const real = realpathSync(dirA);
		expect(await cli(["create", "a", "--cwd", "link"])).toEqual({
			code: 0,
			stdout: `Created a (${real})\n`,
			stderr: "",
		});
		expect(JSON.parse(readFileSync(hostsPath(), "utf8"))).toEqual({ a: real });

		const [duplicate, created] = await Promise.all([
			cli(["create", "a", "--cwd", dirB]),
			cli(["create", "b", "--cwd", dirB]),
		]);

		expect(duplicate.code).toBe(1);
		expect(duplicate.stderr).toContain(`The host a exists (${real})`);
		expect(created.code).toBe(0);
		expect((await cli(["hosts"])).stdout).toBe(`a  ${real}\nb  ${realpathSync(dirB)}\nmain\n`);
	});

	it("refuses --project before the command", async () => {
		expect(await cli(["--project", "a", "list"])).toEqual({
			code: 1,
			stdout: "",
			stderr: "harness takes --host <name>, not --project\n",
		});
	});

	it("moves the projects.json of an older harness to hosts.json at the first read", async () => {
		const config = join(root, "old-config");
		const dir = join(realpathSync(root), "moved-dir");
		await mkdir(join(config, "harness"), { recursive: true });
		await mkdir(dir);
		const old = join(config, "harness", "projects.json");
		writeFileSync(old, JSON.stringify({ moved: dir }));

		try {
			expect(await cli(["--host", "moved", "list"], { XDG_CONFIG_HOME: config })).toMatchObject({ code: 0 });
			expect(JSON.parse(readFileSync(join(config, "harness", "hosts.json"), "utf8"))).toEqual({ moved: dir });
			expect(existsSync(old)).toBe(false);
		} finally {
			await stopHostProcess("moved", config);
		}
	});

	it("refuses to run when both projects.json and hosts.json exist", async () => {
		const config = join(root, "both-config");
		await mkdir(join(config, "harness"), { recursive: true });
		const old = join(config, "harness", "projects.json");
		const path = join(config, "harness", "hosts.json");
		writeFileSync(old, JSON.stringify({ a: dirA }));
		writeFileSync(path, JSON.stringify({ b: dirB }));
		const results = await Promise.all([["list"], ["hosts"]].map((args) => cli(args, { XDG_CONFIG_HOME: config })));

		expect(results).toEqual(
			results.map(() => ({
				code: 1,
				stdout: "",
				stderr: `Both ${old} and ${path} exist: keep the hosts in ${path} and remove ${old}\n`,
			})),
		);
		expect(existsSync(statePaths("main").socket)).toBe(false);
	});

	it("routes each command to its host", async () => {
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
				// --host wins over HARNESS_HOST, which wins over the cwd.
				cli(["list"], { HARNESS_HOST: "b" }, dirA),
				cli(["--host", "a", "list"], { HARNESS_HOST: "b" }, dirB),
				// After the command, --host is an argument of that command, not the host.
				cli(["list", "--host", "a"], {}, dirB),
				cli(["--host", "nope", "list"]),
			]);

			expect(listA.stdout).toContain(childA);
			expect(listA.stdout).not.toContain(childB);
			expect(listB.stdout).toContain(childB);
			expect(listB.stdout).not.toContain(childA);
			expect(listByEnv.stdout).toBe(listB.stdout);
			expect(listByOption.stdout).toBe(listA.stdout);
			expect(optionAfter.code).toBe(1);
			expect(unknown.code).toBe(1);
			expect(unknown.stderr).toBe("Unknown harness host: nope\n");
		} finally {
			await hostA?.close();
			await hostB?.close();
		}
	});

	it("opens Pi on the --host of attach, and does not pass that host to Pi in HARNESS_HOST", async () => {
		const hostA = await startHost("a");
		const pi = await fakePi();

		try {
			const handle = handleOf(await cli(["spawn", "--prompt", "Attach in a"], {}, dirA));
			expect(await cli(["--host", "a", "attach", handle], pi.env, dirB)).toMatchObject({ code: 3, stderr: "" });
			expect(logLines(pi.log)).toEqual([`--harness a --harness-child ${handle} HARNESS_HOST=`]);
		} finally {
			await hostA?.close();
		}
	});

	it("starts one host process for each host", async () => {
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

			// The host option wins over HARNESS_HOST.
			const routes: [string, string][] = [
				["a", "b"],
				["b", "a"],
			];

			for (const [host, other] of routes) {
				process.env.HARNESS_HOST = other;
				const client = await connect({ start: false, host });
				client?.close();
				expect(client?.pid).toBe(pids.get(host));
				expect(existsSync(join(statePaths(host).dir, "durable.sqlite"))).toBe(true);
			}
		} finally {
			delete process.env.HARNESS_HOST;

			// A host of this process, such as one of a test that timed out and has not closed its hosts yet, is not stopped.
			for (const pid of pids.values()) if (pid > 0 && pid !== process.pid) process.kill(pid, "SIGTERM");
		}

		await until(() => !existsSync(statePaths("a").socket) && !existsSync(statePaths("b").socket));
	});

	it("routes a command from the real directory to a host saved with a link path", async () => {
		const valid = readFileSync(hostsPath(), "utf8");
		const link = join(realpathSync(root), "a-link");
		await symlink(realpathSync(dirA), link);
		writeFileSync(hostsPath(), JSON.stringify({ a: link }));
		const hostMain = await startHost();
		const hostA = await startHost("a");

		try {
			const handle = handleOf(await cli(["--host", "a", "spawn", "--prompt", "Through a link"], {}, dirB));
			// The CLI process has the real path of dirA as its cwd.
			expect((await cli(["list"], {}, dirA)).stdout).toContain(handle);
		} finally {
			await hostA?.close();
			await hostMain?.close();
			writeFileSync(hostsPath(), valid);
		}
	});

	it("refuses a hosts file with an invalid host", async () => {
		const valid = readFileSync(hostsPath(), "utf8");

		try {
			for (const hosts of [{ "../up": realpathSync(dirA) }, { c: "relative" }, { c: 1 }]) {
				writeFileSync(hostsPath(), JSON.stringify(hosts));
				const result = await cli(["hosts"]);
				expect(result.code).toBe(1);
				expect(result.stderr).toContain(`${hostsPath()} has an invalid host:`);
			}
		} finally {
			writeFileSync(hostsPath(), valid);
		}
	});
});

/** Stops the host process `name` that a CLI started with the config folder `config`, and waits until its socket is gone. */
async function stopHostProcess(name: string, config: string): Promise<void> {
	const saved = process.env.XDG_CONFIG_HOME;
	process.env.XDG_CONFIG_HOME = config;

	try {
		const client = await connect({ start: false, host: name });
		client?.close();

		if (client !== undefined) process.kill(client.pid, "SIGTERM");
	} finally {
		process.env.XDG_CONFIG_HOME = saved;
	}

	await until(() => !existsSync(statePaths(name).socket));
}
