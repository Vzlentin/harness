import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { HARNESS_HOST } from "./env.ts";
import { readJsonFile, updateJsonFile } from "./json-file.ts";

/** The host that has no directory. A cwd outside every host goes to it. */
export const MAIN_HOST = "main";

const COMMANDS = [
	"spawn",
	"status",
	"rename",
	"send",
	"wait",
	"stop",
	"list",
	"query",
	"tree",
	"todo",
	"attach",
	"host",
	"create",
	"hosts",
	"inspect",
	"page",
	"serve",
] as const;

/** A command of the `harness` CLI. */
export type CommandName = (typeof COMMANDS)[number];

/** The commands of the `harness` CLI, which a host cannot have as its name. */
export const COMMAND_NAMES: ReadonlySet<string> = new Set(COMMANDS);

const NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** The file of the hosts: `$XDG_CONFIG_HOME/harness/hosts.json`, default `~/.config/harness/hosts.json`. */
export function hostsPath(): string {
	return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "harness", "hosts.json");
}

/**
 * The hosts, name to absolute directory, in creation order. `create` saves real paths, but a hand-written file can
 * have a path through a symbolic link. It is empty when the file does not exist. It throws when the
 * file is not an object of valid names to absolute directories.
 */
export function readHosts(): Record<string, string> {
	const path = hostsPath();
	const hosts = readJsonFile(path);

	if (!Value.Check(Type.Record(Type.String(), Type.Unknown()), hosts)) {
		throw new Error(`${path} is not an object of host names to directories`);
	}

	return Object.fromEntries(
		Object.entries(hosts).map(([name, dir]) => {
			if (!NAME.test(name) || name === MAIN_HOST || !Value.Check(Type.String(), dir) || !isAbsolute(dir)) {
				throw new Error(`${path} has an invalid host: ${name}`);
			}

			return [name, dir] as const;
		}),
	);
}

/**
 * Adds the host `name` with the real path of `dir` to the hosts, and gives that path. It throws for an invalid or
 * existing name, for the name of a command and for a directory that does not exist.
 */
export function addHost(name: string, dir: string): string {
	if (!NAME.test(name)) throw new Error(`A host name has 1 to 32 characters: a-z first, then a-z, 0-9 or -: ${name}`);

	if (name === MAIN_HOST || COMMAND_NAMES.has(name)) throw new Error(`A host cannot have the name ${name}`);
	let real: string;

	try {
		real = realpathSync(resolve(dir));
	} catch {
		throw new Error(`No such directory: ${dir}`);
	}

	if (!statSync(real).isDirectory()) throw new Error(`Not a directory: ${dir}`);

	updateJsonFile(hostsPath(), readHosts, (hosts) => {
		if (Object.hasOwn(hosts, name)) throw new Error(`The host ${name} exists (${hosts[name]})`);

		return { ...hosts, [name]: real };
	});

	return real;
}

/** `name` when it is `main` or a host. Otherwise it throws. */
export function checkHost(name: string, hosts: Readonly<Record<string, string>> = readHosts()): string {
	if (name !== MAIN_HOST && !Object.hasOwn(hosts, name)) throw new Error(`Unknown harness host: ${name}`);

	return name;
}

/** The directory of the host `name`: the home directory for `main`. It throws for an unknown host. */
export function hostDir(name: string, hosts: Readonly<Record<string, string>> = readHosts()): string {
	// `checkHost` passes only `main`, which `hosts` never has, and the names in `hosts`.
	return hosts[checkHost(name, hosts)] ?? homedir();
}

/** The memory that the agents of the host `name` get: the `.optmem` folder in its directory `dir`, if it exists. Never for main. */
export function memoryDir(name: string, dir: string): string | undefined {
	if (name === MAIN_HOST) return undefined;
	const path = join(dir, ".optmem");

	return statSync(path, { throwIfNoEntry: false })?.isDirectory() === true ? path : undefined;
}

/**
 * The host of a command: `HARNESS_HOST` in `env`, then the host with the longest directory that is `cwd` or
 * contains it, then `main`. It compares the real paths of `cwd` and of the directories (see `realOrWritten`). An unknown
 * `HARNESS_HOST` is an error.
 */
export function resolveHost(
	env: NodeJS.ProcessEnv,
	cwd: string,
	hosts: Readonly<Record<string, string>> = readHosts(),
): string {
	if (env[HARNESS_HOST]) return checkHost(env[HARNESS_HOST], hosts);
	const real = realOrWritten(cwd);
	let found = MAIN_HOST;
	let length = -1;

	for (const [name, written] of Object.entries(hosts)) {
		const dir = realOrWritten(written);

		// The first host wins over a later one with the same real directory.
		if (dir.length > length && (real === dir || real.startsWith(dir.endsWith(sep) ? dir : dir + sep))) {
			found = name;
			length = dir.length;
		}
	}

	return found;
}

/** The real path of `path`, or `path` as written when it does not exist. */
function realOrWritten(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/**
 * The host of a command with the explicit host `name`: `name` when it is given, which must be `main` or a host,
 * else the host of `env` and `cwd` (see `resolveHost`).
 */
export function hostOf(
	name: string | undefined,
	env: NodeJS.ProcessEnv,
	cwd: string,
	hosts: Readonly<Record<string, string>> = readHosts(),
): string {
	return name === undefined ? resolveHost(env, cwd, hosts) : checkHost(name, hosts);
}
