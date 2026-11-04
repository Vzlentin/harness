import type { UsageState } from "@earendil-works/pi-durable";

/** Adds every counter of `state` to `sum`. A counter that one side leaves out counts as 0. */
export function addUsageState(sum: UsageState, state: Readonly<UsageState>): void {
	for (const bucket of ["models", "tools"] as const) {
		const totals = sum[bucket];

		for (const [key, usage] of Object.entries(state[bucket])) {
			const total = Object.hasOwn(totals, key) ? totals[key] : undefined;

			if (total === undefined) {
				// Define rather than assign: assigning a tool named `__proto__` would set the prototype.
				Object.defineProperty(totals, key, { value: structuredClone(usage), enumerable: true, writable: true });
				continue;
			}

			total.input += usage.input;
			total.output += usage.output;
			total.cacheRead += usage.cacheRead;
			total.cacheWrite += usage.cacheWrite;
			total.totalTokens += usage.totalTokens;

			if (usage.cacheWrite1h !== undefined) total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h;

			if (usage.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
			total.cost.input += usage.cost.input;
			total.cost.output += usage.cost.output;
			total.cost.cacheRead += usage.cost.cacheRead;
			total.cost.cacheWrite += usage.cost.cacheWrite;
			total.cost.total += usage.cost.total;
		}
	}
}
