/**
 * The state of the agent of a mirror session for the terminal, with the Program Status Protocol (OSC 7501): `working`
 * while it works, `error` when its last request failed, and `idle` in all other cases.
 */
import type { ProgramStatus, Terminal } from "@earendil-works/pi-tui";
import { type Mirror, targetTitle } from "../dist/mirror.js";
import { childTitle } from "../dist/protocol.js";

/** The program name of each report. */
const APP = "harness";

type Mirrored = Pick<Mirror, "target" | "status" | "child" | "view" | "busy">;

/** The title of the agent of `mirror`. */
function title({ target, child }: Pick<Mirrored, "target" | "child">): string {
	return child === undefined ? targetTitle(target) : childTitle(child);
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

/** The state of the agent of `mirror`. */
function programStatus(mirror: Mirrored): ProgramStatus {
	if (mirror.busy) return { state: "working", app: APP, message: title(mirror) };

	if (mirror.status.kind === "open" && mirror.child?.state === "error") {
		return { state: "error", app: APP, message: errorLine(mirror) };
	}

	return { state: "idle", app: APP, message: title(mirror) };
}

export class ProgramStatusReport {
	readonly #terminal: Pick<Terminal, "setProgramStatus">;
	/** The state and the message of the last report. */
	#last: string | undefined;

	constructor(terminal: Pick<Terminal, "setProgramStatus">) {
		this.#terminal = terminal;
	}

	/** Reports the state of the agent of `mirror` when its state or its message changed since the last report. */
	update(mirror: Mirrored): void {
		const report = programStatus(mirror);
		const key = `${report.state}\n${report.message}`;

		if (key === this.#last) return;
		this.#last = key;
		this.#terminal.setProgramStatus(report);
	}

	/** Reports `idle` one more time, when Pi leaves the session of `mirror`. */
	leave(mirror: Pick<Mirrored, "target" | "child">): void {
		this.#terminal.setProgramStatus({ state: "idle", app: APP, message: title(mirror) });
	}
}
