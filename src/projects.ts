import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { readJsonFile, updateJsonFile } from "./json-file.ts";

/** The project that has no directory. A cwd outside every project goes to it. */
export const MAIN_PROJECT = "main";

/** The commands of the `harness` CLI, which a project cannot have as its name. */
export const COMMAND_NAMES: ReadonlySet<string> = new Set([
	"spawn",
	"status",
	"rename",
	"send",
	"wait",
	"stop",
	"list",
	"attach",
	"host",
	"create",
	"projects",
]);

const NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** The file of the projects: `$XDG_CONFIG_HOME/harness/projects.json`, default `~/.config/harness/projects.json`. */
export function projectsPath(): string {
	return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "harness", "projects.json");
}

/**
 * The projects, name to real directory, in creation order. It is empty when the file does not exist. It throws when the
 * file is not an object of valid names to absolute directories.
 */
export function readProjects(): Record<string, string> {
	const path = projectsPath();
	const projects = readJsonFile(path);

	if (!Value.Check(Type.Record(Type.String(), Type.Unknown()), projects)) {
		throw new Error(`${path} is not an object of project names to directories`);
	}

	return Object.fromEntries(
		Object.entries(projects).map(([name, dir]) => {
			if (!NAME.test(name) || name === MAIN_PROJECT || !Value.Check(Type.String(), dir) || !isAbsolute(dir)) {
				throw new Error(`${path} has an invalid project: ${name}`);
			}

			return [name, dir] as const;
		}),
	);
}

/**
 * Adds the project `name` with the real path of `dir` to the projects, and gives that path. It throws for an invalid or
 * existing name, for the name of a command and for a directory that does not exist.
 */
export function addProject(name: string, dir: string): string {
	if (!NAME.test(name))
		throw new Error(`A project name has 1 to 32 characters: a-z first, then a-z, 0-9 or -: ${name}`);

	if (name === MAIN_PROJECT || COMMAND_NAMES.has(name)) throw new Error(`A project cannot have the name ${name}`);
	let real: string;

	try {
		real = realpathSync(resolve(dir));
	} catch {
		throw new Error(`No such directory: ${dir}`);
	}

	if (!statSync(real).isDirectory()) throw new Error(`Not a directory: ${dir}`);

	updateJsonFile(projectsPath(), readProjects, (projects) => {
		if (Object.hasOwn(projects, name)) throw new Error(`The project ${name} exists (${projects[name]})`);

		return { ...projects, [name]: real };
	});

	return real;
}

/** `name` when it is `main` or a project. Otherwise it throws. */
export function checkProject(name: string, projects: Readonly<Record<string, string>> = readProjects()): string {
	if (name !== MAIN_PROJECT && !Object.hasOwn(projects, name)) throw new Error(`Unknown harness project: ${name}`);

	return name;
}

/** The directory of the project `name`: the home directory for `main`. It throws for an unknown project. */
export function projectDir(name: string, projects: Readonly<Record<string, string>> = readProjects()): string {
	// `checkProject` passes only `main`, which `projects` never has, and the names in `projects`.
	return projects[checkProject(name, projects)] ?? homedir();
}

/** The memory that the agents of the project `name` get: the `.optmem` folder in its directory `dir`, if it exists. Never for main. */
export function memoryDir(name: string, dir: string): string | undefined {
	if (name === MAIN_PROJECT) return undefined;
	const path = join(dir, ".optmem");

	return statSync(path, { throwIfNoEntry: false })?.isDirectory() === true ? path : undefined;
}

/**
 * The project of a command: `HARNESS_PROJECT` in `env`, then the project with the longest directory that is `cwd` or
 * contains it, then `main`. An unknown `HARNESS_PROJECT` is an error.
 */
export function resolveProject(
	env: NodeJS.ProcessEnv,
	cwd: string,
	projects: Readonly<Record<string, string>> = readProjects(),
): string {
	if (env.HARNESS_PROJECT) return checkProject(env.HARNESS_PROJECT, projects);
	let found = MAIN_PROJECT;
	let length = -1;

	for (const [name, dir] of Object.entries(projects)) {
		// The first project wins over a later one with the same directory.
		if (dir.length > length && (cwd === dir || cwd.startsWith(dir.endsWith(sep) ? dir : dir + sep))) {
			found = name;
			length = dir.length;
		}
	}

	return found;
}
