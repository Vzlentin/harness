/**
 * The entries that the host loads, by name. A package such as workflows sets its entry before it starts a task, so the
 * host does not depend on Pi's package settings.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";

const Entries = Type.Record(Type.String(), Type.String());

/** The file of the entries: `$XDG_CONFIG_HOME/harness/entries.json`, default `~/.config/harness/entries.json`. */
export function entriesPath(): string {
	return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "harness", "entries.json");
}

/** The entries, name to absolute module path. It is empty when the file does not exist. */
export function readEntries(): Record<string, string> {
	const path = entriesPath();
	let text: string;

	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
		throw error;
	}

	const entries: unknown = JSON.parse(text);

	if (!Value.Check(Entries, entries) || !Object.values(entries).every((module) => isAbsolute(module))) {
		throw new Error(`${path} is not an object of entry names to absolute module paths`);
	}

	return entries;
}

/**
 * Sets the module of the entry `name` to the absolute path `module`. It is true when it changed the file: a host that
 * runs already loads the new module only after it starts again.
 */
export function setEntry(name: string, module: string): boolean {
	if (!isAbsolute(module)) throw new Error(`An entry module must be an absolute path: ${module}`);
	const entries = readEntries();

	if (entries[name] === module) return false;
	const path = entriesPath();
	mkdirSync(dirname(path), { recursive: true });
	// A temporary file, then a rename, so a stop in between does not truncate the entries.
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify({ ...entries, [name]: module }, null, "\t")}\n`);
	renameSync(temporary, path);

	return true;
}
