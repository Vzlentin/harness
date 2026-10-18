/** A `piDurable` entry of the old shape: it reads only `durable` and gives no tasks. */
import type * as Durable from "@earendil-works/pi-durable";

export default function oldEntry({ durable }: { readonly durable: typeof Durable }) {
	if (!(durable.defineExtension instanceof Function)) throw new Error("no pi-durable");

	return { extensions: [], close: async () => {} };
}
