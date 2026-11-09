import { describe, expect, it } from "vite-plus/test";
import { RequestPool } from "../src/rlm/pool.ts";

/** Lets the granted requests of the pool resolve. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** The names of the requests that got a slot, in order, and their release functions by name. */
type Granted = { readonly order: string[]; readonly releases: Map<string, () => void> };

/** Asks `pool` for a slot of `tree` for the request `name` at `depth`, and keeps it in `granted` once it gets one. */
function ask(
	pool: RequestPool,
	granted: Granted,
	name: string,
	tree: string,
	depth: number,
	signal = new AbortController().signal,
) {
	return pool.acquire(tree, depth, signal).then((release) => {
		granted.order.push(name);
		granted.releases.set(name, release);
	});
}

function release(granted: Granted, name: string): void {
	const free = granted.releases.get(name);

	if (free === undefined) throw new Error(`${name} has no slot`);
	free();
}

describe("request pool", () => {
	it("gives a freed slot to the waiting request with the smallest depth, then to the oldest", async () => {
		const pool = new RequestPool(1);
		const granted: Granted = { order: [], releases: new Map() };
		void ask(pool, granted, "holder", "tree", 1);
		void ask(pool, granted, "deep old", "tree", 3);
		void ask(pool, granted, "shallow old", "tree", 2);
		void ask(pool, granted, "shallow new", "tree", 2);
		void ask(pool, granted, "deep new", "tree", 3);
		await settle();
		expect(granted.order).toEqual(["holder"]);

		for (const name of ["holder", "shallow old", "shallow new", "deep old"]) {
			release(granted, name);
			await settle();
		}

		expect(granted.order).toEqual(["holder", "shallow old", "shallow new", "deep old", "deep new"]);
	});

	it("removes a waiting request whose signal aborts, with the reason of the signal", async () => {
		const pool = new RequestPool(1);
		const granted: Granted = { order: [], releases: new Map() };
		const abort = new AbortController();
		void ask(pool, granted, "holder", "tree", 1);
		const skipped = ask(pool, granted, "aborted", "tree", 1, abort.signal);
		void ask(pool, granted, "next", "tree", 2);
		const reason = new Error("stop");
		abort.abort(reason);
		await expect(skipped).rejects.toBe(reason);
		release(granted, "holder");
		await settle();
		expect(granted.order).toEqual(["holder", "next"]);
	});

	it("gives a slot of another tree while a tree is full", async () => {
		const pool = new RequestPool(1);
		const granted: Granted = { order: [], releases: new Map() };
		void ask(pool, granted, "holder", "tree", 1);
		void ask(pool, granted, "waiter", "tree", 1);
		void ask(pool, granted, "other", "other tree", 1);
		await settle();
		expect(granted.order).toEqual(["holder", "other"]);
	});

	it("frees a slot when the signal of the request that holds it aborts", async () => {
		const pool = new RequestPool(1);
		const granted: Granted = { order: [], releases: new Map() };
		const abort = new AbortController();
		void ask(pool, granted, "holder", "tree", 1, abort.signal);
		void ask(pool, granted, "waiter", "tree", 1);
		await settle();
		abort.abort();
		await settle();
		expect(granted.order).toEqual(["holder", "waiter"]);
	});

	it("frees one slot only for a release called twice", async () => {
		const pool = new RequestPool(1);
		const granted: Granted = { order: [], releases: new Map() };
		void ask(pool, granted, "holder", "tree", 1);
		void ask(pool, granted, "first", "tree", 1);
		void ask(pool, granted, "second", "tree", 1);
		await settle();
		release(granted, "holder");
		release(granted, "holder");
		await settle();
		expect(granted.order).toEqual(["holder", "first"]);
	});
});
