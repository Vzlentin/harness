/**
 * An entry that serves the parley asks in place of the host: a round with a parley frame, and the answers of the asks
 * that `id`, or `slug` and `n`, name. It writes the asks through the `asks` handle of the host, each with its parley as
 * data, and keeps its parleys in memory. It also serves `parley` `read`: a parley and its asks.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "typebox";
import type { AskAnswer, AskHandler, EntryAsks, EntryOpen } from "../../src/host/entries.ts";
import type { AnswerInput, Ask, Parley, ParleyAsks, ParleyFrame } from "../../src/protocol/asks.ts";
import { askGroup } from "../../src/protocol/requests.ts";

export default function parleyAsksEntry({ asks }: { readonly asks: EntryAsks }) {
	const parleys: Parley[] = [];
	let opened: EntryOpen | undefined;

	/** The parley `slug`. An unknown slug fails. */
	function parleyOf(slug: string): Parley {
		const parley = parleys.find((each) => each.slug === slug);

		if (parley === undefined) throw new Error(`Unknown parley: ${slug}`);

		return parley;
	}

	/** The parley of `frame`, which a new slug makes, for the caller `by` at `at`. */
	function framedParley(frame: ParleyFrame, by: string, at: number): Parley {
		const known = parleys.find((each) => each.slug === frame.slug);

		if (known !== undefined) return known;
		const title = frame.title ?? frame.slug;

		const parley: Parley = {
			id: parleys.length + 1,
			slug: frame.slug,
			title,
			goal: frame.goal ?? title,
			status: "open",
			at,
			by,
		};

		parleys.push(parley);

		return parley;
	}

	/** The ID of the ask `n` of the parley `slug` in `all`. An unknown ask fails. */
	function numbered(slug: string, n: number, all: readonly Ask[]): number {
		const { id } = parleyOf(slug);
		const found = all.find((ask) => ask.parley?.id === id && ask.parley.n === n);

		if (found === undefined) throw new Error(`Unknown ask: ${slug} ${n}`);

		return found.id;
	}

	/** The answer `input`, with the ID of its ask in `all`. */
	function byId(input: AnswerInput, all: readonly Ask[]): AskAnswer {
		const id = input.id === undefined ? numbered(input.slug, input.n, all) : input.id;
		const { slug: _slug, n: _n, ...answer } = input;

		return { ...answer, id };
	}

	const ask: AskHandler = async (request, { author }) => {
		if (opened === undefined) throw new Error("The host is not open yet");
		const { harness, root } = opened;

		switch (request.action) {
			case "round": {
				if (request.parley === undefined) throw new Error("The fixture serves only a round with a parley");
				const at = Date.now();
				const parley = framedParley(request.parley, request.caller, at);

				await harness.commit(async (tx) => {
					const count = (await asks.inCommit(tx)).filter((each) => each.parley?.id === parley.id).length;
					const inputs = request.asks.map((input, i) => ({ input, parley: { id: parley.id, n: count + i + 1 } }));
					await asks.add(tx, inputs, request.caller, at);
				}, BACKGROUND_CONTEXT);

				return { parleys: [withAsks(parley, (await asks.read(harness, BACKGROUND_CONTEXT)).asks)], asks: [] };
			}

			case "answer": {
				const by = await author(request);

				const answered = await harness.commit(async (tx) => {
					const all = await asks.inCommit(tx);
					const answers = request.answers.map((input) => byId(input, all));

					return asks.answer(tx, answers, new Set(), request.caller, by, root.id, (list) => list.map(askGroup));
				}, BACKGROUND_CONTEXT);

				return { parleys: [], asks: answered };
			}

			default:
				throw new Error(`The fixture serves no ask ${request.action}`);
		}
	};

	const read = {
		type: "parley",
		schema: Type.Object({ type: Type.Literal("parley"), action: Type.Literal("read"), slug: Type.String() }),
		passive: () => true,
		handle: async ({ slug }: { readonly slug: string }) => {
			if (opened === undefined) throw new Error("The host is not open yet");
			const parley = parleyOf(slug);

			return withAsks(parley, (await asks.read(opened.harness, BACKGROUND_CONTEXT)).asks);
		},
	};

	return {
		extensions: [],
		requests: [read],
		ask,
		open: async (open: EntryOpen) => {
			opened = open;
		},
		close: async () => {},
	};
}

/** `parley` and its asks in `all`. */
function withAsks(parley: Parley, all: readonly Ask[]): ParleyAsks {
	return { parley, asks: all.filter((ask) => ask.parley?.id === parley.id) };
}
