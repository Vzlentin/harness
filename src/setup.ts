/**
 * Registers the Pi extension of a globally installed package in Pi. The `postinstall` script and the CLI of the package
 * run it, since npm 12 does not run install scripts by default. workflows uses it too, as `@vzlentin/harness/setup`.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, sep } from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const PackageJson = Type.Object({ name: Type.String(), version: Type.String() });

type PackageJson = Static<typeof PackageJson>;

/** A package that setup acts on: its real directory and its `package.json`. */
type Installed = { readonly dir: string; readonly json: PackageJson };

/**
 * Registers `<packageDir>/pi` in Pi when `packageDir` is a top-level global npm install. It writes its messages to
 * stderr, and it does not throw for a Pi failure: it writes a warning with the command to run. It writes the stamp
 * that `setupOnce` reads unless `pi` failed, so the next run tries again. Without `pi` on PATH it writes the stamp, so
 * a user without Pi gets the hint once per version.
 */
export function setup(packageDir: string): void {
	const installed = readInstalled(packageDir);

	if (installed === undefined || !isTopLevelGlobal(installed)) return;

	if (registerExtension(installed)) writeStamp(installed);
}

/**
 * `setup` once per version and path of the package: it does nothing when the stamp of `setup` exists. It never
 * throws; an error is a warning.
 */
export function setupOnce(packageDir: string): void {
	try {
		const installed = readInstalled(packageDir);

		if (installed === undefined || !isTopLevelGlobal(installed) || existsSync(stampPath(installed))) return;

		if (registerExtension(installed)) writeStamp(installed);
	} catch (error) {
		process.stderr.write(`harness: setup failed: ${error instanceof Error ? error.message : String(error)}\n`);
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

/** False when `pi install` failed. */
function registerExtension({ dir, json }: Installed): boolean {
	const label = basename(json.name);
	const extension = join(dir, "pi");

	return runPi(label, ["install", extension], `To add the Pi extension of ${label}, run: pi install ${extension}`);
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

/** The `PATH` without the `node_modules/.bin` folders that npm adds: pi-coding-agent there has its own `pi`. */
function userPath(): string {
	return (process.env.PATH ?? "")
		.split(delimiter)
		.filter((entry) => !entry.endsWith(join("node_modules", ".bin")))
		.join(delimiter);
}
