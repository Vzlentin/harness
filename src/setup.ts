/**
 * Registers the Pi package of a globally installed package in Pi, as `npm:<piPackage>@<version>`. The `postinstall`
 * script and the CLI of the package run it, since npm 12 does not run install scripts by default. workflows uses it
 * too, as `@vzlentin/harness/setup`, with its own Pi package.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { errorMessage } from "./protocol.ts";

const PackageJson = Type.Object({ name: Type.String(), version: Type.String() });

type PackageJson = Static<typeof PackageJson>;

const PiSettings = Type.Object({
	packages: Type.Optional(Type.Array(Type.Union([Type.String(), Type.Object({ source: Type.String() })]))),
});

/** The prefixes of the Pi package sources that are not local paths, as Pi reads them. */
const REMOTE = ["npm:", "git:", "github:", "http:", "https:", "ssh:", "builtin:"];

/** A package that setup acts on: its real directory and its `package.json`. */
type Installed = { readonly dir: string; readonly json: PackageJson };

/**
 * Registers `npm:<piPackage>@<version>` in Pi when `packageDir` is a top-level global npm install, with the version of
 * `<packageDir>/package.json`. It writes its messages to stderr, and it does not throw for a Pi failure: it writes a
 * warning with the command to run. It writes the stamp that `setupOnce` reads unless `pi` failed, so the next run
 * tries again. Without `pi` on PATH it writes the stamp, so a user without Pi gets the hint once per version.
 */
export function setup(packageDir: string, piPackage: string): void {
	const installed = readInstalled(packageDir);

	if (installed === undefined || !isTopLevelGlobal(installed)) return;

	if (registerExtension(installed, piPackage)) writeStamp(installed);
}

/**
 * `setup` once per version and path of the package: it does nothing when the stamp of `setup` exists. It never
 * throws; an error is a warning.
 */
export function setupOnce(packageDir: string, piPackage: string): void {
	try {
		const installed = readInstalled(packageDir);

		if (installed === undefined || !isTopLevelGlobal(installed) || existsSync(stampPath(installed))) return;

		if (registerExtension(installed, piPackage)) writeStamp(installed);
	} catch (error) {
		process.stderr.write(`harness: setup failed: ${errorMessage(error)}\n`);
	}
}

/**
 * True when `dir` is `<global root>/<name>`: `<root>` is a `node_modules` folder in `lib` (in the prefix on Windows),
 * and has no other `node_modules` above it. A copy nested in another package is not top-level.
 */
function isTopLevelGlobal({ dir, json }: Installed): boolean {
	const name = json.name.split("/").join(sep);

	if (!dir.endsWith(`${sep}${name}`)) return false;
	const root = dir.slice(0, -name.length - 1);
	const segments = root.split(sep);

	if (segments.at(-1) !== "node_modules" || segments.indexOf("node_modules") !== segments.length - 1) return false;

	return process.platform === "win32" || segments.at(-2) === "lib";
}

function readInstalled(packageDir: string): Installed | undefined {
	const dir = realpathSync(packageDir);
	const json: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));

	return Value.Check(PackageJson, json) ? { dir, json } : undefined;
}

/** The stamp of `setup`: `$XDG_STATE_HOME/harness/.setup/<hash of path and version>`. */
function stampPath({ dir, json }: Installed): string {
	const hash = createHash("sha256").update(`${dir}\n${json.version}`).digest("hex");

	return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "harness", ".setup", hash);
}

function writeStamp(installed: Installed): void {
	const path = stampPath(installed);

	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${installed.dir}\n${installed.json.version}\n`);
}

/**
 * Runs `pi install npm:<piPackage>@<version>` unless Pi already lists it. False when `pi install` failed. Pi replaces
 * an entry with the same package name, so an older version or a range is updated in place.
 */
function registerExtension({ json }: Installed, piPackage: string): boolean {
	const label = basename(json.name);
	const source = `npm:${piPackage}@${json.version}`;

	if (piLists(piPackage, source)) return true;

	return runPi(label, ["install", source], `To add the Pi extension of ${label}, run: pi install ${source}`);
}

/** Runs `pi`, with a warning when it is missing or fails. False when it failed; true when it worked or is missing. */
function runPi(label: string, args: readonly string[], later: string): boolean {
	const result = spawnSync("pi", args, {
		env: { ...process.env, PATH: userPath() },
		stdio: ["ignore", 2, 2],
		timeout: 120_000,
	});

	if (result.error !== undefined && "code" in result.error && result.error.code === "ENOENT") {
		process.stderr.write(`${label}: pi is not on PATH. ${later}\n`);

		return true;
	}

	if (result.error !== undefined || result.status !== 0) {
		const reason = result.error?.message ?? `exit ${result.status ?? result.signal}`;
		process.stderr.write(`${label}: pi ${args[0]} failed (${reason}). ${later}\n`);

		return false;
	}

	return true;
}

/**
 * Whether the `packages` of Pi's global settings list `source` exactly, or a local folder whose `package.json` has the
 * name `piPackage`, at any version. A local path is absolute or relative to the agent directory, with `~` or as a
 * `file:` URL, as Pi resolves it. Another remote source, such as another `npm:` spec, is not listed.
 */
function piLists(piPackage: string, source: string): boolean {
	const env = process.env.PI_CODING_AGENT_DIR;
	const agentDir = env ? expandHome(env) : join(homedir(), ".pi", "agent");
	let settings: unknown;

	try {
		settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
	} catch {
		return false;
	}

	if (!Value.Check(PiSettings, settings)) return false;

	return (settings.packages ?? []).some((item) => {
		const entry = (Value.Check(Type.String(), item) ? item : item.source).trim();

		if (entry === source) return true;

		if (REMOTE.some((prefix) => entry.startsWith(prefix))) return false;

		try {
			const path = entry.startsWith("file://") ? fileURLToPath(entry) : resolve(agentDir, expandHome(entry));
			const json: unknown = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));

			return Value.Check(PackageJson, json) && json.name === piPackage;
		} catch {
			return false;
		}
	});
}

/** `path` with a leading `~` replaced by the home directory. */
function expandHome(path: string): string {
	return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

/** The `PATH` without the `node_modules/.bin` folders that npm adds: pi-coding-agent there has its own `pi`. */
export function userPath(): string {
	return (process.env.PATH ?? "")
		.split(delimiter)
		.filter((entry) => !entry.endsWith(join("node_modules", ".bin")))
		.join(delimiter);
}
