/**
 * The state of the agent of a mirror session for the terminal, with the Program Status Protocol (OSC 7501): `working`
 * while it works, `blocked` while the mirror connects again to the host, `error` when its last request failed, `done`
 * when its turn ended, until the next turn, and `idle` in all other cases.
 */
import type { ProgramStatus, Terminal } from "@earendil-works/pi-tui";
import type { Mirror, targetTitle } from "../dist/client/mirror.js";
import type { childTitle } from "../dist/protocol/index.js";

/** The program name of each report. */
const APP = "harness";

type Mirrored = Pick<Mirror, "target" | "status" | "child" | "view" | "busy">;

/** The functions of harness that give the title of an agent. */
type Titles = { readonly targetTitle: typeof targetTitle; readonly childTitle: typeof childTitle };

/** The title of the agent of `mirror`. */
function title(titles: Titles, { target, child }: Pick<Mirrored, "target" | "child">): string {
	return child === undefined ? titles.targetTitle(target) : titles.childTitle(child);
}

/** The first line of the error of the last failed request, or `Error` when there is none. */
function errorLine({ view }: Pick<Mirrored, "view">): string {
	const failed = view?.entries.findLast((entry) => {
		const message = entry.model?.[0];

		return entry.kind === "pi.assistant" && message?.role === "assistant" && message.stopReason === "error";
	})?.model?.[0];

	const text = failed?.role === "assistant" ? failed.errorMessage : undefined;

	return text?.split(/\r?\n/, 1)[0]?.trim() || "Error";
}

/** The state of the agent of `mirror`, which ran a turn since its last error, close or failure when `worked`. */
function programStatus(titles: Titles, mirror: Mirrored, worked: boolean): ProgramStatus {
	// OSC 7501 has no state for a lost connection, and `working` would claim progress.
	if (mirror.status.kind === "reconnecting") {
		return { state: "blocked", app: APP, message: `${title(titles, mirror)} (connecting again)` };
	}

	if (mirror.busy) return { state: "working", app: APP, message: title(titles, mirror) };

	if (mirror.status.kind === "open" && mirror.child?.state === "error") {
		return { state: "error", app: APP, message: errorLine(mirror) };
	}

	return { state: worked ? "done" : "idle", app: APP, message: title(titles, mirror) };
}

export class ProgramStatusReport {
	readonly #terminal: Pick<Terminal, "setProgramStatus">;
	readonly #titles: Titles;
	/** Whether the agent ran a turn in this session since its last error, close or failure. */
	#worked = false;
	/** The state and the message of the last report. */
	#last: string | undefined;

	constructor(terminal: Pick<Terminal, "setProgramStatus">, titles: Titles) {
		this.#terminal = terminal;
		this.#titles = titles;
	}

	/** Reports the state of the agent of `mirror` when its state or its message changed since the last report. */
	update(mirror: Mirrored): void {
		const { status, child } = mirror;

		if (mirror.busy) this.#worked = true;
		else if (status.kind === "failed" || child?.state === "error" || child?.state === "closed") this.#worked = false;
		const report = programStatus(this.#titles, mirror, this.#worked);
		const key = `${report.state}\n${report.message}`;

		if (key === this.#last) return;
		this.#last = key;
		this.#terminal.setProgramStatus(report);
	}

	/** Reports the state of the agent of `mirror` again, also when it did not change, such as after Pi wrote its own. */
	reportAgain(mirror: Mirrored): void {
		this.#last = undefined;
		this.update(mirror);
	}

	/** Reports `idle` one more time, when Pi leaves the session of `mirror`. */
	leave(mirror: Pick<Mirrored, "target" | "child">): void {
		this.#terminal.setProgramStatus({ state: "idle", app: APP, message: title(this.#titles, mirror) });
	}
}
