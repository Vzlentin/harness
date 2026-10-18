import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setup, setupOnce } from "../src/setup.ts";

const run = promisify(execFile);
const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const environment = { ...process.env };
let root: string;

/** The commands that the fake `pi` got, one line each. */
function piCalls(): string[] {
	const log = join(root, "pi.log");

	return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
}

/** A package `@vzlentin/harness` with a `pi/` folder in `<root>/<at>`, as npm installs it. */
async function installAt(at: string, version = "0.2.0"): Promise<string> {
	const dir = join(root, at, "@vzlentin", "harness");
	await mkdir(join(dir, "pi"), { recursive: true });
	const json = { name: "@vzlentin/harness", version, retiredPiPackages: ["npm:@vzlentin/pi-subagent"] };
	await writeFile(join(dir, "package.json"), JSON.stringify(json));

	return realpathSync(dir);
}

async function fakePi(dir: string, tag: string): Promise<void> {
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "pi"), `#!/bin/sh\necho "${tag}$*" >> "${join(root, "pi.log")}"\n`);
	await chmod(join(dir, "pi"), 0o755);
}

function stamps(): string[] {
	const dir = join(root, "state", "harness", ".setup");

	return existsSync(dir) ? readdirSync(dir) : [];
}

beforeEach(async () => {
	root = realpathSync(await mkdtemp(join(tmpdir(), "harness-setup-")));
	await fakePi(join(root, "bin"), "");
	// npm puts node_modules/.bin first, and the `pi` there must not run.
	await fakePi(join(root, "node_modules", ".bin"), "wrong ");
	process.env.HOME = join(root, "home");
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	process.env.XDG_STATE_HOME = join(root, "state");
	process.env.XDG_CONFIG_HOME = join(root, "config");
	process.env.PATH = [join(root, "node_modules", ".bin"), join(root, "bin"), "/usr/bin", "/bin"].join(delimiter);
});

afterEach(async () => {
	process.env = { ...environment };
	vi.restoreAllMocks();
	await rm(root, { recursive: true, force: true });
});

describe("setup", () => {
	it("registers pi/ of a top-level global install, once per stamp", async () => {
		const dir = await installAt("prefix/lib/node_modules");

		setup(dir);
		expect(piCalls()).toEqual([`install ${join(dir, "pi")}`]);
		expect(stamps()).toHaveLength(1);
		setupOnce(dir);
		expect(piCalls()).toHaveLength(1);
	});

	it("does nothing for a copy nested in another global package, or outside lib/node_modules", async () => {
		setup(await installAt("prefix/lib/node_modules/parent-tool/node_modules"));
		setup(await installAt("project/node_modules"));
		setupOnce(await installAt("prefix/lib/node_modules/other/node_modules"));
		expect(piCalls()).toEqual([]);
		expect(stamps()).toEqual([]);
	});

	it("removes the retired pi-subagent from Pi before it installs", async () => {
		const dir = await installAt("prefix/lib/node_modules");
		await mkdir(join(root, "agent"));
		const packages = ["npm:@vzlentin/pi-subagent@0.1.0", { source: "npm:other" }, "npm:@vzlentin/pi-subagent-x"];
		await writeFile(join(root, "agent", "settings.json"), JSON.stringify({ packages }));
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		setup(dir);
		expect(piCalls()).toEqual(["remove npm:@vzlentin/pi-subagent@0.1.0", `install ${join(dir, "pi")}`]);
		expect(stderr).toHaveBeenCalledWith(
			"harness: removing npm:@vzlentin/pi-subagent@0.1.0 from Pi, which @vzlentin/harness replaces\n",
		);
	});

	it("writes the command to run later when pi is not on PATH, and does not throw", async () => {
		const dir = await installAt("prefix/lib/node_modules");
		process.env.PATH = ["/usr/bin", "/bin"].join(delimiter);
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		setup(dir);
		expect(stderr).toHaveBeenCalledWith(
			`harness: pi is not on PATH. To add the Pi extension of harness, run: pi install ${join(dir, "pi")}\n`,
		);
		expect(stamps()).toHaveLength(1);
	});

	it("warns when pi install fails", async () => {
		const dir = await installAt("prefix/lib/node_modules");
		await writeFile(join(root, "bin", "pi"), "#!/bin/sh\nexit 3\n");
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		setup(dir);
		expect(stderr).toHaveBeenCalledWith(
			`harness: pi install failed (exit 3). To add the Pi extension of harness, run: pi install ${join(dir, "pi")}\n`,
		);
	});
});

describe("the installed CLI", () => {
	it("runs setup once per version, and the checkout's CLI never does", { timeout: 60_000 }, async () => {
		const dir = await installAt("prefix/lib/node_modules");
		const tsc = join(repo, "node_modules", "typescript", "bin", "tsc");
		await run(process.execPath, [tsc, "-p", "tsconfig.build.json", "--outDir", join(dir, "dist")], { cwd: repo });
		await symlink(join(repo, "node_modules"), join(dir, "node_modules"));
		const cli = join(dir, "dist", "cli.js");

		await run(process.execPath, [join(repo, "src", "cli.ts"), "projects"]);
		expect(piCalls()).toEqual([]);

		await run(process.execPath, [cli, "projects"]);
		const { stdout } = await run(process.execPath, [cli, "projects"]);
		expect(stdout).toBe("main\n");
		expect(piCalls()).toEqual([`install ${join(dir, "pi")}`]);

		await installAt("prefix/lib/node_modules", "0.2.1");
		await run(process.execPath, [cli, "projects"]);
		expect(piCalls()).toHaveLength(2);
		expect(stamps()).toHaveLength(2);
	});
});
