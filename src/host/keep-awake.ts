/**
 * The hold that keeps the Mac awake on AC power while the host has active work.
 */
import { spawn } from "node:child_process";

/** How long the hold stays after the last tick with active work. */
export const RELEASE_DELAY_MS = 30_000;

/** How often the hold reads whether work is active. */
export const AWAKE_POLL_MS = 5_000;

/** What the hold uses of a child process. */
export type AwakeChild = {
	kill(): void;
	once(event: "error", listener: (error: Error) => void): void;
	once(event: "exit", listener: () => void): void;
};

/** The hold of a host, which `close()` releases for good. */
export type AwakeHold = { close(): void };

/** What the hold takes from the system. Tests give their own, so they start no program and use a manual clock. */
export type AwakeSystem = {
	readonly platform: NodeJS.Platform;
	readonly spawn: (command: string, args: readonly string[]) => AwakeChild;
	readonly now: () => number;
	/** Calls `tick` every `ms`, and gives the function that stops it. */
	readonly every: (ms: number, tick: () => void) => () => void;
};

/** The system of this process: Node's platform and clock, and real programs that do not keep the process alive. */
export const NODE_AWAKE_SYSTEM: AwakeSystem = {
	platform: process.platform,
	spawn: (command, args) => {
		const child = spawn(command, args, { stdio: "ignore" });
		child.unref();

		return child;
	},
	now: Date.now,
	every: (ms, tick) => {
		const timer = setInterval(tick, ms);
		timer.unref();

		return () => clearInterval(timer);
	},
};

/**
 * Holds the Mac awake with `caffeinate -s -w <pid>` while `active()` is true, and releases the hold
 * `RELEASE_DELAY_MS` after the last tick with active work. An `active()` that throws counts as inactive. A hold that
 * cannot start writes one warning, and no hold starts after it. Other systems get no hold.
 */
export function keepAwake(options: {
	readonly active: () => boolean;
	readonly warn: (cause: unknown) => void;
	readonly system: AwakeSystem;
}): AwakeHold {
	const { active, warn, system } = options;

	if (system.platform !== "darwin") return { close: () => undefined };

	let hold: AwakeChild | undefined;
	let lastActive = 0;
	let failed = false;

	const isActive = () => {
		try {
			return active();
		} catch {
			return false;
		}
	};

	const release = () => {
		const held = hold;
		hold = undefined;
		held?.kill();
	};

	const tick = () => {
		if (isActive()) {
			lastActive = system.now();

			if (hold !== undefined || failed) return;
			const child = system.spawn("caffeinate", ["-s", "-w", String(process.pid)]);
			hold = child;
			child.once("error", (error) => {
				if (hold === child) hold = undefined;

				if (failed) return;
				failed = true;
				warn(new Error(`caffeinate cannot start: ${error.message}`));
			});
			child.once("exit", () => {
				if (hold === child) hold = undefined;
			});
		} else if (hold !== undefined && system.now() - lastActive >= RELEASE_DELAY_MS) {
			release();
		}
	};

	const stop = system.every(AWAKE_POLL_MS, tick);

	return {
		close: () => {
			stop();
			release();
		},
	};
}
