/**
 * A JSON file that several processes change, such as `entries.json`. It is synchronous and uses only Node's own modules
 * and typebox, so the Pi extension can load it, and a caller such as workflows can set an entry without `await`.
 */
import { randomUUID } from "node:crypto";
import {
	closeSync,
	fstatSync,
	linkSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

/** How long a process waits for a lock that a live process holds. */
const WAIT_MS = 5000;
const RETRY_MS = 10;

const JsonObject = Type.Record(Type.String(), Type.Unknown());

/**
 * The JSON object in the file `path`: empty when the file does not exist, and undefined when the file has JSON that is
 * not an object.
 */
export function readJsonFile(path: string): Static<typeof JsonObject> | undefined {
	let text: string;

	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if (hasCode(error, "ENOENT")) return {};
		throw error;
	}

	const value: unknown = JSON.parse(text);

	return Value.Check(JsonObject, value) ? value : undefined;
}

/**
 * Changes the file `path` under its lock: `change` gets the value that `read` gives now, and gives the new value, or
 * undefined for no change. It is true when it wrote the file. It makes the directory of the file.
 */
export function updateJsonFile<T>(path: string, read: () => T, change: (value: T) => T | undefined): boolean {
	mkdirSync(dirname(path), { recursive: true });

	// The lock keeps the change of another process that changes the file at the same time.
	return withFileLock(path, () => {
		const value = change(read());

		if (value === undefined) return false;
		// A temporary file, then a rename, so a stop in between does not truncate the file.
		const temporary = `${path}.${process.pid}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(value, null, "\t")}\n`);
		renameSync(temporary, path);

		return true;
	});
}

/**
 * Runs `run` while this process holds the lock of `path`, the file `<path>.lock` with the ID of the process that holds
 * it. A lock whose process does not run is removed. It throws when another process holds the lock for 5 s.
 */
function withFileLock<T>(path: string, run: () => T): T {
	const lock = `${path}.lock`;
	const deadline = Date.now() + WAIT_MS;
	let own = tryLock(lock);

	while (own === undefined) {
		const holder = holderOf(lock);

		// A lock with no process ID is not one of a live process: a lock file gets its ID before it has its name.
		if (holder !== undefined && !(Number.isInteger(holder.pid) && runs(holder.pid))) breakLock(lock, holder.ino);
		else if (holder !== undefined && Date.now() > deadline) {
			throw new Error(`Could not lock ${path}: another process holds ${lock}. Remove it if no harness command runs`);
		} else if (holder !== undefined) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RETRY_MS);

		own = tryLock(lock);
	}

	try {
		return run();
	} finally {
		// Only this process's own lock: one that another process took as stale is not removed.
		if (holderOf(lock)?.ino === own) rmSync(lock, { force: true });
	}
}

/**
 * Takes the lock file `lock`, and gives the inode of the file, or undefined when another process holds it. The file is
 * written under another name and then linked as `lock`, so the lock never exists without its process ID.
 */
function tryLock(lock: string): number | undefined {
	const temporary = `${lock}.${process.pid}.${randomUUID()}`;
	writeFileSync(temporary, String(process.pid), { mode: 0o600 });

	try {
		linkSync(temporary, lock);

		return statSync(temporary).ino;
	} catch (error) {
		if (hasCode(error, "EEXIST")) return undefined;
		throw error;
	} finally {
		rmSync(temporary, { force: true });
	}
}

/**
 * Removes the stale lock file `lock` with the inode `ino`. It moves the file away first and checks that the file it
 * moved is that one: when another process removed the stale lock and took a new one meanwhile, it puts that one back.
 */
function breakLock(lock: string, ino: number): void {
	const moved = `${lock}.stale.${process.pid}.${randomUUID()}`;

	try {
		renameSync(lock, moved);
	} catch (error) {
		if (hasCode(error, "ENOENT")) return;
		throw error;
	}

	try {
		if (statSync(moved).ino !== ino) linkSync(moved, lock);
	} catch (error) {
		// A third process took the free lock before it was put back; that process holds it now.
		if (!hasCode(error, "EEXIST")) throw error;
	} finally {
		rmSync(moved, { force: true });
	}
}

/**
 * The process ID in the lock file `lock` and the file's inode, or undefined when the file does not exist. The ID is NaN
 * when the file has none.
 */
function holderOf(lock: string): { readonly pid: number; readonly ino: number } | undefined {
	let fd: number;

	try {
		fd = openSync(lock, "r");
	} catch (error) {
		if (hasCode(error, "ENOENT")) return undefined;
		throw error;
	}

	try {
		return { pid: Number.parseInt(readFileSync(fd, "utf8"), 10), ino: fstatSync(fd).ino };
	} finally {
		closeSync(fd);
	}
}

/** Whether the process `pid` runs. A process of another user, which this process cannot signal, runs. */
function runs(pid: number): boolean {
	try {
		process.kill(pid, 0);

		return true;
	} catch (error) {
		return !hasCode(error, "ESRCH");
	}
}

/** Whether `cause` is a Node.js system error with the code `code`, such as `ENOENT`. */
function hasCode(cause: unknown, code: string): boolean {
	return cause instanceof Error && "code" in cause && cause.code === code;
}
