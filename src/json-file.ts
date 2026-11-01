/**
 * A JSON file that several processes change, such as `entries.json`. It is synchronous and uses only `node:fs` and
 * typebox, so the Pi extension can load it, and a caller such as workflows can set an entry without `await`.
 */
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
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

	while (!tryLock(lock)) {
		const holder = holderOf(lock);

		// The holder removed the lock since the try.
		if (holder === undefined) continue;

		// A lock with no ID yet is one that its holder is writing.
		if (Number.isInteger(holder) && !runs(holder)) {
			rmSync(lock, { force: true });
			continue;
		}

		if (Date.now() > deadline) {
			throw new Error(`Could not lock ${path}: another process holds ${lock}. Remove it if no harness command runs`);
		}

		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RETRY_MS);
	}

	try {
		return run();
	} finally {
		rmSync(lock, { force: true });
	}
}

/** Whether this process made the lock file `lock`. */
function tryLock(lock: string): boolean {
	let fd: number;

	try {
		fd = openSync(lock, "wx", 0o600);
	} catch (error) {
		if (hasCode(error, "EEXIST")) return false;
		throw error;
	}

	try {
		writeSync(fd, String(process.pid));
	} finally {
		closeSync(fd);
	}

	return true;
}

/** The process ID in the lock file `lock`, NaN when it has none yet, or undefined when the file does not exist. */
function holderOf(lock: string): number | undefined {
	try {
		return Number.parseInt(readFileSync(lock, "utf8"), 10);
	} catch (error) {
		if (hasCode(error, "ENOENT")) return undefined;
		throw error;
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
