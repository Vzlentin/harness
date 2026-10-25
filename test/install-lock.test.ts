import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { takeInstallLock, waitInstallLockFree } from "../pi/install-lock.ts";
import { setUp, tearDown } from "./helpers.ts";

const MODULE = join(dirname(fileURLToPath(import.meta.url)), "..", "pi", "install-lock.ts");

/** The lock folder that the spec gives for the test's `XDG_STATE_HOME`. */
function lockPath(): string {
	return join(process.env.XDG_STATE_HOME ?? "", "harness", "install.lock");
}

/** The PID of a process that has exited. */
async function deadPid(): Promise<number> {
	const child = execFile(process.execPath, ["-e", ""]);
	const pid = child.pid;
	await new Promise((resolve) => child.once("exit", resolve));

	if (pid === undefined) throw new Error("the child did not start");

	return pid;
}

/** A lock folder whose `pid` holds `pid`. */
async function writeLock(pid: number): Promise<void> {
	await mkdir(lockPath(), { recursive: true });
	await writeFile(join(lockPath(), "pid"), String(pid));
}

/** Runs a process that takes the lock 20 times and logs each enter and exit in `log`. */
function contender(log: string): Promise<void> {
	const script = [
		`import { appendFileSync } from "node:fs";`,
		`import { setTimeout } from "node:timers/promises";`,
		`const lock = await import(${JSON.stringify(MODULE)});`,
		`for (let i = 0; i < 20; i++) {`,
		`  await lock.takeInstallLock();`,
		`  appendFileSync(${JSON.stringify(log)}, "enter " + process.pid + "\\n");`,
		`  await setTimeout(20);`,
		`  appendFileSync(${JSON.stringify(log)}, "exit " + process.pid + "\\n");`,
		`  lock.releaseInstallLock();`,
		`}`,
	].join("\n");

	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "inherit" });
		child.once("error", reject);
		child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`exit code ${code}`))));
	});
}

beforeEach(async () => {
	await setUp();
});

afterEach(async () => {
	await tearDown();
});

describe("the install lock", () => {
	it("takes over a lock whose holder is dead", async () => {
		await writeLock(await deadPid());
		await takeInstallLock();

		expect(await readFile(join(lockPath(), "pid"), "utf8")).toBe(String(process.pid));
	});

	it("counts a fresh lock without pid as held", async () => {
		await mkdir(lockPath(), { recursive: true });
		let free = false;

		void waitInstallLockFree().then(() => {
			free = true;
		});

		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(free).toBe(false);
	});

	it("lets one process at a time hold the lock", async () => {
		await writeLock(await deadPid());
		const log = join(lockPath(), "..", "log");
		await Promise.all([contender(log), contender(log)]);
		const lines = (await readFile(log, "utf8")).trim().split("\n");

		expect(lines).toHaveLength(80);

		for (let i = 0; i < lines.length; i += 2) {
			const pid = lines[i]?.split(" ")[1];

			expect([lines[i], lines[i + 1]]).toEqual([`enter ${pid}`, `exit ${pid}`]);
		}
	}, 30_000);
});
