import { realpathSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AnswerListener, type AnswersOptions } from "../src/answers.ts";
import { connect, request } from "../src/client.ts";
import { type Host, runHost } from "../src/host.ts";
import { type ChildInfo, type Delivery, deliveryText, statePaths } from "../src/protocol.ts";
import { called, calls, cli, gates, models, root, setUp, spawnedBy, startHost, tearDown, until } from "./helpers.ts";

let host: Host | undefined;

beforeAll(async () => {
	await setUp();
	host = await startHost();
});

afterAll(async () => {
	await host?.close();
	await tearDown();
});

describe("push", { timeout: 30_000 }, () => {
	it("pushes one answer for a tree of three levels once the whole tree is quiet", async () => {
		const caller = "tree-session";
		gates.set("Task:\nTree leaf", Promise.withResolvers());
		const answers = listenAnswers(caller);

		try {
			const tree = (await spawnAs(caller, "Tree")).handle;
			await until(() => called("Task:\nTree leaf") === 1);
			const branch = spawnedBy.get("Task:\nTree") ?? "";
			await until(() => spawnedBy.has("Task:\nTree branch"));
			// Both have ended their own turn, and the busy leaf holds them.
			expect((await request({ type: "status", handle: tree }, { start: false }))?.state).toBe("busy");
			expect((await request({ type: "status", handle: branch }, { start: false }))?.state).toBe("busy");
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(answers.deliveries).toEqual([]);
			gates.get("Task:\nTree leaf")?.resolve();
			await until(() => answers.deliveries.length === 1);
			const [delivery] = answers.deliveries;
			expect(delivery?.handle).toBe(tree);
			expect(delivery?.failed).toBe(false);
			expect(delivery?.text).toContain(`Answer to subagent nested (${branch}) finished`);
			// The answer of the leaf went to the branch, and the branch's to the tree, each once. Pushes of earlier tests can
			// still come, so only the pushes of this tree count.
			const leaf = spawnedBy.get("Task:\nTree branch") ?? "";

			const pushes = () =>
				calls.filter((call) => [branch, leaf].some((handle) => call.prompt.startsWith(`subagent nested (${handle})`)));

			expect(pushes()).toHaveLength(2);
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(answers.deliveries).toHaveLength(1);
			expect(pushes()).toHaveLength(2);
		} finally {
			answers.listener.close();
		}
	});

	it("does not push nor hold the parent for a child spawned with notify false", async () => {
		const caller = "quiet-session";
		gates.set("Task:\nQuiet child", Promise.withResolvers());
		const answers = listenAnswers(caller);

		try {
			const parent = (await spawnAs(caller, "Quiet parent")).handle;
			// The parent's own answer comes while its quiet child still works.
			await until(() => answers.deliveries.length === 1);
			expect(called("Task:\nQuiet child")).toBe(1);
			expect(answers.deliveries[0]?.handle).toBe(parent);
			expect((await request({ type: "status", handle: parent }, { start: false }))?.state).toBe("idle");
			const child = spawnedBy.get("Task:\nQuiet parent") ?? "";
			gates.get("Task:\nQuiet child")?.resolve();
			await until(() => calls.some((call) => call.prompt === "Task:\nQuiet child"));

			while ((await request({ type: "status", handle: child }, { start: false }))?.state !== "idle") {
				await new Promise((resolve) => setTimeout(resolve, 20));
			}

			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(calls.some((call) => call.prompt.startsWith(`subagent nested (${child})`))).toBe(false);
			expect(answers.deliveries).toHaveLength(1);
		} finally {
			answers.listener.close();
		}
	});

	it("pushes a failed and an aborted turn with the error of wait", async () => {
		const caller = "fail-session";
		gates.set("Task:\nAbort me", Promise.withResolvers());
		const answers = listenAnswers(caller);

		try {
			const failed = (await spawnAs(caller, "Fail")).handle;
			await until(() => answers.deliveries.length === 1);
			expect(answers.deliveries[0]).toEqual({ handle: failed, text: `${failed} failed: overloaded`, failed: true });
			expect(answers.deliveries.map(deliveryText)).toEqual([
				`subagent ${failed} failed\n\n${failed} failed: overloaded`,
			]);
			const aborted = (await spawnAs(caller, "Abort me")).handle;
			await until(() => called("Task:\nAbort me") === 1);
			await request({ type: "abort", handle: aborted }, { start: false });
			await until(() => answers.deliveries.length === 2);
			expect(answers.deliveries[1]).toEqual({ handle: aborted, text: `${aborted} was aborted`, failed: true });
		} finally {
			answers.listener.close();
		}
	});

	it("keeps the answers unread when the answers request closes before they come", async () => {
		const caller = "closed-session";
		gates.set("Task:\nAfter close", Promise.withResolvers());
		const answers = listenAnswers(caller);
		const { handle } = await spawnAs(caller, "After close");
		await until(() => called("Task:\nAfter close") === 1);
		answers.listener.close();
		gates.get("Task:\nAfter close")?.resolve();
		await untilState(handle, "idle");
		// Sweeps run after the turn ends; none may mark the answer read.
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(answers.deliveries).toEqual([]);
		expect((await cli(["wait", handle])).stdout).toBe(`${handle} finished\n\nAnswer to Task:\nAfter close\n`);
	});

	it("prompts a child that only its children hold", async () => {
		const caller = "held-session";
		const before = called("Task:\nTree leaf");
		gates.set("Task:\nTree leaf", Promise.withResolvers());
		spawnedBy.clear();
		const tree = (await spawnAs(caller, "Tree")).handle;
		await until(() => called("Task:\nTree leaf") === before + 1);
		await until(() => spawnedBy.has("Task:\nTree") && spawnedBy.has("Task:\nTree branch"));
		// The tree ended its own turn, and the busy leaf holds it.
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect((await request({ type: "status", handle: tree }, { start: false }))?.state).toBe("busy");

		const send = {
			type: "send",
			requestId: "held",
			caller,
			handle: tree,
			message: "Held",
			followUp: false,
			notify: true,
		} as const;

		expect((await request(send, { start: false }))?.verb).toBe("Prompted");
		gates.get("Task:\nTree leaf")?.resolve();
		await untilState(tree, "idle");
	});

	it("reports a delivery that fails, and gives the next ones", async () => {
		const caller = "failing-session";

		const answers = listenAnswers(caller, { start: false }, () => {
			if (answers.deliveries.length === 1) throw new Error("The message did not show");
		});

		try {
			const first = await spawnAs(caller, "Failed show");
			await until(() => answers.deliveries.length === 1);
			const second = await spawnAs(caller, "Shown");
			await until(() => answers.deliveries.length === 2);
			expect(answers.deliveries.map((delivery) => delivery.handle)).toEqual([first.handle, second.handle]);
			expect(answers.errors).toEqual([new Error("The message did not show")]);
		} finally {
			answers.listener.close();
		}
	});

	it("gets the answers again after the host restarts", async () => {
		const caller = "restart-session";
		const answers = listenAnswers(caller, { start: false, retryDelaysMs: [0, 200, 500, 1000, 2000] });

		try {
			await new Promise((resolve) => setTimeout(resolve, 300));
			await host?.close();
			host = await startHost();
			const { handle } = await spawnAs(caller, "After restart");
			await until(() => answers.deliveries.length === 1);
			expect(answers.deliveries[0]?.handle).toBe(handle);
		} finally {
			answers.listener.close();
		}
	});

	it("keeps trying to connect while no host runs, and gets the answers once one starts", async () => {
		const caller = "late-host-session";
		await host?.close();
		const answers = listenAnswers(caller, { start: false, retryDelaysMs: [200] });

		try {
			await new Promise((resolve) => setTimeout(resolve, 600));
			host = await startHost();
			const { handle } = await spawnAs(caller, "Late host");
			await until(() => answers.deliveries.length === 1);
			expect(answers.deliveries[0]?.handle).toBe(handle);
		} finally {
			answers.listener.close();
		}
	});

	it("exits when idle with only an answers request open", async () => {
		const dir = realpathSync(await mkdtemp(join(root, "idle-")));
		expect((await cli(["create", "idle", "--cwd", dir])).code).toBe(0);

		const idle = await runHost({
			stateDir: statePaths("idle").dir,
			project: "idle",
			cwd: dir,
			models,
			idleExitMs: 100,
		});

		if (idle === undefined) throw new Error("no host");

		const client = await connect({ start: false, project: "idle" });

		try {
			if (client === undefined) throw new Error("no host");
			const pending = client.request({ type: "answers", caller: "idle-session" });
			await idle.closed;
			await expect(pending).rejects.toThrow("The harness host closed the connection");
		} finally {
			client?.close();
			await idle.close();
		}
	});
});

/** Spawns a child with the task `prompt` for `caller` through the socket, as the tool does. */
async function spawnAs(caller: string, prompt: string): Promise<ChildInfo> {
	const spawned = await request(
		{
			type: "spawn",
			requestId: `${caller}:${prompt}`,
			caller,
			notify: true,
			provider: "faux",
			model: "faux-1",
			callerThinking: "medium",
			cwd: root,
			prompt: `Task:\n${prompt}`,
		},
		{ start: false },
	);

	if (spawned === undefined) throw new Error("no host");

	return spawned;
}

/** Waits until the child `handle` of the main host has the state `state`. */
async function untilState(handle: string, state: string): Promise<void> {
	await vi.waitFor(
		async () => expect((await request({ type: "status", handle }, { start: false }))?.state).toBe(state),
		{ timeout: 10_000 },
	);
}

/** An `answers` listener, every delivery that it gave, and every error of a delivery. */
type Answers = { readonly deliveries: Delivery[]; readonly errors: Error[]; readonly listener: AnswerListener };

/**
 * The `answers` listener of `caller`, as the Pi extension opens it, with every delivery that came. `onDelivery` runs
 * after each delivery is kept.
 */
function listenAnswers(
	caller: string,
	options: Omit<AnswersOptions, "onError"> = { start: false },
	onDelivery: (delivery: Delivery) => void = () => {},
): Answers {
	const deliveries: Delivery[] = [];
	const errors: Error[] = [];

	const listener = new AnswerListener(
		caller,
		(delivery) => {
			deliveries.push(delivery);
			onDelivery(delivery);
		},
		{ ...options, onError: (error) => errors.push(error) },
	);

	return { deliveries, errors, listener };
}
