import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

/** The project that has no directory. A cwd outside every project goes to it. */
export const MAIN_PROJECT = "main";

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
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
	const projects: unknown = JSON.parse(text);
	if (typeof projects !== "object" || projects === null || Array.isArray(projects)) {
		throw new Error(`${path} is not an object of project names to directories`);
	}
	for (const [name, dir] of Object.entries(projects)) {
		if (!NAME.test(name) || name === MAIN_PROJECT || typeof dir !== "string" || !isAbsolute(dir)) {
			throw new Error(`${path} has an invalid project: ${name}`);
		}
	}
	return projects as Record<string, string>;
}

/**
 * Adds the project `name` with the real path of `dir` to the projects, and gives that path. It throws for an invalid or
 * existing name and for a directory that does not exist.
 */
export function addProject(name: string, dir: string): string {
	if (!NAME.test(name))
		throw new Error(`A project name has 1 to 32 characters: a-z first, then a-z, 0-9 or -: ${name}`);
	if (name === MAIN_PROJECT) throw new Error(`A project cannot have the name ${name}`);
	let real: string;
	try {
		real = realpathSync(resolve(dir));
	} catch {
		throw new Error(`No such directory: ${dir}`);
	}
	if (!statSync(real).isDirectory()) throw new Error(`Not a directory: ${dir}`);
	const projects = readProjects();
	if (Object.hasOwn(projects, name)) throw new Error(`The project ${name} exists (${projects[name]})`);
	const path = projectsPath();
	mkdirSync(dirname(path), { recursive: true });
	// A temporary file, then a rename, so a stop in between does not truncate the projects.
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify({ ...projects, [name]: real }, null, "\t")}\n`);
	renameSync(temporary, path);
	return real;
}

/** `name` when it is `main` or a project. Otherwise it throws. */
export function checkProject(name: string, projects: Readonly<Record<string, string>> = readProjects()): string {
	if (name !== MAIN_PROJECT && !Object.hasOwn(projects, name)) throw new Error(`Unknown harness project: ${name}`);
	return name;
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
