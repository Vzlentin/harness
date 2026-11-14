import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import {
	AWAKE_POLL_MS,
	type AwakeChild,
	type AwakeSystem,
	keepAwake,
	RELEASE_DELAY_MS,
} from "../src/host/keep-awake.ts";
import { runHost } from "../src/host/run.ts";
import { MAIN_PROJECT, projectDir } from "../src/protocol/projects.ts";
import { called, cli, gates, models, setUp, tearDown, until } from "./helpers.ts";

/** A child that the fake system started: its arguments, its kills, and the listeners that a test can call. */
type FakeChild = {
	readonly command: string;
	readonly args: readonly string[];
	kills: number;
	/** The listeners of the child, by event. */
	readonly listeners: Map<string, (error: Error) => void>;
};

/** A system with a manual clock and children that run no program. */
function fakeSystem(platform: NodeJS.Platform = "darwin") {
	const children: FakeChild[] = [];
	const ticks: Array<() => void> = [];
	const polls: number[] = [];
	const fake = { time: 0, children, ticks, stops: 0, polls };

	const system: AwakeSystem = {
		platform,
		spawn: (command, args) => {
			const record: FakeChild = { command, args, kills: 0, listeners: new Map() };
			children.push(record);

			const child: AwakeChild = {
				kill: () => {
					record.kills += 1;
				},
				once: (event: string, listener: (error: Error) => void) => {
					record.listeners.set(event, listener);
				},
			};

			return child;
		},
		now: () => fake.time,
		every: (ms, tick) => {
			fake.polls.push(ms);
			ticks.push(tick);

			return () => {
				fake.stops += 1;
			};
		},
	};

	/** Moves the clock to `time` and runs one tick. */
	const tickAt = (time: number) => {
		fake.time = time;

		for (const tick of ticks) tick();
	};

	return { fake, system, tickAt };
}

describe("the hold that keeps the Mac awake", () => {
	it("starts one caffeinate hold on active work and keeps it over many ticks", () => {
		const { fake, system, tickAt } = fakeSystem();
		const awake = keepAwake({ active: () => true, warn: () => undefined, system });

		expect(fake.polls).toEqual([AWAKE_POLL_MS]);
		expect(fake.children).toEqual([]);

		for (let time = 0; time < 120_000; time += AWAKE_POLL_MS) tickAt(time);

		expect(fake.children).toHaveLength(1);
		expect(fake.children[0]?.command).toBe("caffeinate");
		expect(fake.children[0]?.args).toEqual(["-s", "-w", String(process.pid)]);
		expect(fake.children[0]?.kills).toBe(0);
		awake.close();
	});

	it("releases the hold once work is inactive for the release delay", () => {
		const { fake, system, tickAt } = fakeSystem();
		let active = true;
		keepAwake({ active: () => active, warn: () => undefined, system });
		tickAt(1000);
		active = false;
		tickAt(1000 + RELEASE_DELAY_MS - 1000);

		expect(fake.children[0]?.kills).toBe(0);
		tickAt(1000 + RELEASE_DELAY_MS);

		expect(fake.children[0]?.kills).toBe(1);
		tickAt(1000 + RELEASE_DELAY_MS + AWAKE_POLL_MS);

		expect(fake.children[0]?.kills).toBe(1);
		expect(fake.children).toHaveLength(1);
	});

	it("keeps the same hold when work comes back within the delay, and starts a new one after a release", () => {
		const { fake, system, tickAt } = fakeSystem();
		let active = true;
		keepAwake({ active: () => active, warn: () => undefined, system });
		tickAt(0);
		active = false;
		tickAt(20_000);
		active = true;
		tickAt(25_000);
		active = false;
		tickAt(50_000);

		expect(fake.children).toHaveLength(1);
		expect(fake.children[0]?.kills).toBe(0);
		tickAt(55_000);

		expect(fake.children[0]?.kills).toBe(1);
		active = true;
		tickAt(60_000);

		expect(fake.children).toHaveLength(2);
	});

	it("starts a new hold after one that exits", () => {
		const { fake, system, tickAt } = fakeSystem();
		const warnings: unknown[] = [];
		keepAwake({ active: () => true, warn: (cause) => warnings.push(cause), system });
		tickAt(0);
		fake.children[0]?.listeners.get("exit")?.(new Error("exit"));
		tickAt(5000);

		expect(fake.children).toHaveLength(2);
		expect(warnings).toEqual([]);
	});

	it("counts an active check that throws as inactive, with no warning", () => {
		const { fake, system, tickAt } = fakeSystem();
		const warnings: unknown[] = [];
		keepAwake({
			active: () => {
				throw new Error("closed");
			},
			warn: (cause) => warnings.push(cause),
			system,
		});
		tickAt(0);

		expect(fake.children).toEqual([]);
		expect(warnings).toEqual([]);
	});

	it("kills the hold one time and stops the poll on close", () => {
		const { fake, system, tickAt } = fakeSystem();
		const awake = keepAwake({ active: () => true, warn: () => undefined, system });
		tickAt(0);
		awake.close();
		awake.close();

		expect(fake.children[0]?.kills).toBe(1);
		expect(fake.stops).toBeGreaterThan(0);
	});

	it("does nothing on another system", () => {
		const { fake, system, tickAt } = fakeSystem("linux");
		const awake = keepAwake({ active: () => true, warn: () => undefined, system });
		tickAt(0);
		awake.close();

		expect(fake.polls).toEqual([]);
		expect(fake.children).toEqual([]);
	});

	it("writes one warning when caffeinate cannot start, and starts no hold after it", () => {
		const { fake, system, tickAt } = fakeSystem();
		const warnings: unknown[] = [];
		keepAwake({ active: () => true, warn: (cause) => warnings.push(cause), system });
		tickAt(0);
		fake.children[0]?.listeners.get("error")?.(new Error("spawn caffeinate ENOENT"));
		tickAt(5000);
		tickAt(10_000);

		expect(fake.children).toHaveLength(1);
		expect(warnings.map(String)).toEqual(["Error: caffeinate cannot start: spawn caffeinate ENOENT"]);
	});
});

describe("the hold of a host", { timeout: 30_000 }, () => {
	beforeAll(setUp);
	afterAll(tearDown);

	it("holds the Mac awake while a child's model request runs, and releases the hold when the host closes", async () => {
		const { fake, system, tickAt } = fakeSystem();
		const host = await runHost({ project: MAIN_PROJECT, cwd: projectDir(MAIN_PROJECT), models, keepAwake: system });
		const gate = Promise.withResolvers<void>();
		gates.set("Task:\nKeep awake", gate);

		try {
			tickAt(0);

			expect(fake.children).toEqual([]);
			await cli(["spawn", "--prompt", "Keep awake"]);
			await until(() => called("Task:\nKeep awake") === 1);
			tickAt(5000);

			expect(fake.children).toHaveLength(1);
			await host?.close();

			expect(fake.children[0]?.kills).toBe(1);
		} finally {
			gate.resolve();
			await host?.close();
		}
	});
});
