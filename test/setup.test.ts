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

const pinned = "npm:@vzlentin/pi-agents@0.2.0";

/** A package `@vzlentin/harness` in `<root>/<at>`, as npm installs it. */
async function installAt(at: string, version = "0.2.0"): Promise<string> {
	const dir = join(root, at, "@vzlentin", "harness");
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "package.json"), JSON.stringify({ name: "@vzlentin/harness", version }));

	return realpathSync(dir);
}

/** Pi's global settings with these `packages`. */
async function piPackages(packages: unknown[]): Promise<void> {
	await mkdir(join(root, "agent"), { recursive: true });
	await writeFile(join(root, "agent", "settings.json"), JSON.stringify({ packages }));
}

/** A local folder `<root>/<at>` with a `package.json`. */
async function localPackage(at: string, name: string, version: string): Promise<string> {
	const dir = join(root, at);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "package.json"), JSON.stringify({ name, version }));

	return dir;
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
	it("registers the pinned Pi package for a top-level global install, once per stamp", async () => {
		const dir = await installAt("prefix/lib/node_modules");

		setup(dir, "@vzlentin/pi-agents");
		expect(piCalls()).toEqual([`install ${pinned}`]);
		expect(stamps()).toHaveLength(1);
		setupOnce(dir, "@vzlentin/pi-agents");
		expect(piCalls()).toHaveLength(1);
	});

	it("installs the pinned version over another version of the Pi package", async () => {
		const dir = await installAt("prefix/lib/node_modules");
		await piPackages(["npm:@vzlentin/pi-agents@0.1.0"]);

		setup(dir, "@vzlentin/pi-agents");
		expect(piCalls()).toEqual([`install ${pinned}`]);
	});

	it("runs no pi when Pi lists the pinned version, or a local folder of the Pi package", async () => {
		const dir = await installAt("prefix/lib/node_modules");
		await piPackages([{ source: pinned }]);
		setup(dir, "@vzlentin/pi-agents");
		expect(piCalls()).toEqual([]);
		expect(stamps()).toHaveLength(1);

		await installAt("prefix/lib/node_modules", "0.2.1");
		const absolute = await localPackage("checkout/pi", "@vzlentin/pi-agents", "9.9.9");
		await localPackage("agent/local/pi", "@vzlentin/pi-agents", "9.9.9");
		await piPackages([absolute]);
		setup(dir, "@vzlentin/pi-agents");
		await piPackages(["local/pi"]);
		setup(dir, "@vzlentin/pi-agents");
		expect(piCalls()).toEqual([]);
	});

	it("installs the Pi package when Pi lists only another package", async () => {
		const dir = await installAt("prefix/lib/node_modules");
		await piPackages(["file://host/x", "npm:@vzlentin/pi-workflows@0.2.0"]);

		setup(dir, "@vzlentin/pi-agents");
		expect(piCalls()).toEqual([`install ${pinned}`]);
	});

	it("does nothing for a copy nested in another global package, or outside lib/node_modules", async () => {
		setup(await installAt("prefix/lib/node_modules/parent-tool/node_modules"), "@vzlentin/pi-agents");
		setup(await installAt("project/node_modules"), "@vzlentin/pi-agents");
		setupOnce(await installAt("prefix/lib/node_modules/other/node_modules"), "@vzlentin/pi-agents");
		expect(piCalls()).toEqual([]);
		expect(stamps()).toEqual([]);
	});

	it("writes the command to run later when pi is not on PATH, and does not throw", async () => {
		const dir = await installAt("prefix/lib/node_modules");
		process.env.PATH = ["/usr/bin", "/bin"].join(delimiter);
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		setup(dir, "@vzlentin/pi-agents");
		expect(stderr).toHaveBeenCalledWith(
			`harness: pi is not on PATH. To add the Pi extension of harness, run: pi install ${pinned}\n`,
		);
		expect(stamps()).toHaveLength(1);
	});

	it("warns when pi install fails, and writes no stamp, so the next run tries again", async () => {
		const dir = await installAt("prefix/lib/node_modules");
		await writeFile(join(root, "bin", "pi"), "#!/bin/sh\nexit 3\n");
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

		setup(dir, "@vzlentin/pi-agents");
		expect(stderr).toHaveBeenCalledWith(
			`harness: pi install failed (exit 3). To add the Pi extension of harness, run: pi install ${pinned}\n`,
		);
		expect(stamps()).toEqual([]);
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

		expect((await run(process.execPath, [cli, "--version"])).stdout).toBe("0.2.0\n");
		expect(piCalls()).toEqual([`install ${pinned}`]);
		const { stdout } = await run(process.execPath, [cli, "projects"]);
		expect(stdout).toBe("main\n");
		expect(piCalls()).toEqual([`install ${pinned}`]);

		await installAt("prefix/lib/node_modules", "0.2.1");
		await run(process.execPath, [cli, "projects"]);
		expect(piCalls()).toHaveLength(2);
		expect(stamps()).toHaveLength(2);
	});
});
