/**
 * The listeners of the tools bridge on the events of pi-ipython, for the host and for Pi: each side gives the shapes of
 * its payloads, and how they give the kernel and the cell.
 */
import type { EventBus } from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import {
	CELL_END,
	CELL_START,
	INVALID_CELL_END,
	INVALID_CELL_START,
	INVALID_KERNEL_STARTING,
	KERNEL_STARTING,
	type KernelStarting,
} from "./kernel.ts";
import type { Cell, KernelServers } from "./server.ts";

/** A side of the bridge, the host or Pi: the schemas of the payloads of its events, and what each payload gives. */
export type BridgeSide<Starting extends TSchema, Start extends TSchema, End extends TSchema> = {
	readonly kernelStarting: Starting;
	readonly cellStart: Start;
	readonly cellEnd: End;
	/** The kernel servers, or `undefined` while the side serves no kernel, which ignores the events. */
	servers(): KernelServers | undefined;
	/** The key of the kernel of a kernel start, and its payload. */
	kernel(starting: Static<Starting>): { readonly key: string; readonly starting: KernelStarting };
	/** The key of the kernel of a cell that starts, the ID of the cell, and the cell. */
	cell(start: Static<Start>): { readonly key: string; readonly id: string; readonly cell: Cell };
	/** The key of the kernel of a cell that ends, and the ID of the cell when the payload gives it. */
	ended(end: Static<End>): { readonly key: string; readonly id?: string };
	/** Gets the warning of a payload of another shape, which does nothing else. */
	warn(message: string): void;
};

/** Serves the kernels and the cells that pi-ipython announces on `events`, as `side` reads them. */
export function listenBridge<Starting extends TSchema, Start extends TSchema, End extends TSchema>(
	events: Pick<EventBus, "on">,
	side: BridgeSide<Starting, Start, End>,
): void {
	listen(events, side, KERNEL_STARTING, side.kernelStarting, INVALID_KERNEL_STARTING, (servers, payload) => {
		const { key, starting } = side.kernel(payload);
		// pi-ipython reads the payload once the promises of `waitFor` settle, so the change happens in one. Its rejection
		// fails the kernel start.
		starting.waitFor(servers.serve(starting, key));
	});
	listen(events, side, CELL_START, side.cellStart, INVALID_CELL_START, (servers, payload) => {
		const { key, id, cell } = side.cell(payload);
		servers.open(key, id, cell);
	});
	listen(events, side, CELL_END, side.cellEnd, INVALID_CELL_END, (servers, payload) => {
		const { key, id } = side.ended(payload);
		servers.end(key, id);
	});
}

/**
 * Runs `handle` with each payload of `channel` that has the shape `schema`, while `side` has kernel servers. A payload of
 * another shape gives the warning `invalid`.
 */
function listen<Payload extends TSchema>(
	events: Pick<EventBus, "on">,
	side: Pick<BridgeSide<TSchema, TSchema, TSchema>, "servers" | "warn">,
	channel: string,
	schema: Payload,
	invalid: string,
	handle: (servers: KernelServers, payload: Static<Payload>) => void,
): void {
	events.on(channel, (payload) => {
		const servers = side.servers();

		if (servers === undefined) return;

		if (!Value.Check(schema, payload)) {
			side.warn(invalid);

			return;
		}

		handle(servers, payload);
	});
}
