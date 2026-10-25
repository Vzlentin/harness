/**
 * The install lock of harness, `$XDG_STATE_HOME/harness/install.lock`: a folder that one process at a time holds while
 * it installs. workflows uses it too, so it keeps to the contract in `docs/spec.md`. It imports only Node modules,
 * because the extension loads it without harness.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, type Stats, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout } from "node:timers/promises";

const POLL_MS = 200;
const STALE_MS = 10_000;

/** The state folder of harness, `$XDG_STATE_HOME/harness`. */
export function stateFolder(): string {
	return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "harness");
}

/** The folder of the install lock. */
function lockPath(): string {
	return join(stateFolder(), "install.lock");
}

/** True when `mtimeMs` is older than 10 s. */
function isStale(mtimeMs: number): boolean {
	return Date.now() - mtimeMs > STALE_MS;
}

/** The stat of `path`, or undefined when it does not exist. */
function statOf(path: string): Stats | undefined {
	try {
		return statSync(path);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

/** The text of the `pid` file of the lock, or undefined when there is none. */
function readHolder(lock: string): string | undefined {
	try {
		return readFileSync(join(lock, "pid"), "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

/**
 * True when the holder `text` of a lock folder with the mtime `mtimeMs` is dead. Only ESRCH proves that a process is
 * gone. A missing or bad pid counts as held for 10 s after the mtime of the folder. A reused PID looks alive, so a lock
 * whose holder died stays held until that new process ends.
 */
function isDead(text: string | undefined, mtimeMs: number): boolean {
	const pid = text !== undefined && /^\d+$/.test(text.trim()) ? Number(text.trim()) : 0;

	if (pid <= 0) return isStale(mtimeMs);

	try {
		process.kill(pid, 0);

		return false;
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "ESRCH";
	}
}

/** Writes the pid of this process in the lock, through a temporary file and a rename. */
function writePid(lock: string): void {
	const temporary = join(lock, `pid.${process.pid}`);
	writeFileSync(temporary, String(process.pid));
	renameSync(temporary, join(lock, "pid"));
}

/**
 * Takes over the lock in place from the dead holder `seen`, under the `takeover` guard; true when it did. `before` is
 * the stat of the lock folder when `seen` was read: the guard changes the mtime of the folder, so the check after the
 * guard uses the mtime from before, and the inode shows that the folder is the same.
 */
function takeOver(lock: string, seen: string | undefined, before: Stats): boolean {
	const guard = join(lock, "takeover");

	try {
		mkdirSync(guard);
	} catch (error) {
		const code = error instanceof Error && "code" in error ? error.code : undefined;
		const guardStat = code === "EEXIST" ? statOf(guard) : undefined;

		if (guardStat !== undefined && isStale(guardStat.mtimeMs)) rmSync(guard, { recursive: true, force: true });

		if (code === "EEXIST" || code === "ENOENT") return false;
		throw error;
	}

	try {
		const now = readHolder(lock);

		if (now !== seen || statOf(lock)?.ino !== before.ino || !isDead(now, before.mtimeMs)) return false;
		writePid(lock);

		return true;
	} finally {
		rmSync(guard, { recursive: true, force: true });
	}
}

/** Takes the install lock, and waits with no timeout while a live process holds it. */
export async function takeInstallLock(): Promise<void> {
	const lock = lockPath();

	for (;;) {
		mkdirSync(dirname(lock), { recursive: true });

		try {
			mkdirSync(lock);
			writePid(lock);

			return;
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
		}

		const before = statOf(lock);
		const seen = readHolder(lock);

		if (before !== undefined && isDead(seen, before.mtimeMs) && takeOver(lock, seen, before)) return;
		await setTimeout(POLL_MS);
	}
}

/** Releases the install lock: it removes the lock folder. */
export function releaseInstallLock(): void {
	rmSync(lockPath(), { recursive: true, force: true });
}

/** Waits until the install lock is free: the folder is gone or its holder is dead. It does not take the lock. */
export async function waitInstallLockFree(): Promise<void> {
	const lock = lockPath();

	for (;;) {
		const stat = statOf(lock);

		if (stat === undefined || isDead(readHolder(lock), stat.mtimeMs)) return;
		await setTimeout(POLL_MS);
	}
}
