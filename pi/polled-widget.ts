/** A widget below the editor whose lines come from the host, such as the subagents widget and the todo widget. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";

/** Gives the lines of a widget for the session of `ctx`, or undefined to hide it. */
type ReadLines = (ctx: ExtensionContext) => Promise<string[] | undefined>;

/**
 * A widget below the editor of a session with a UI. It reads its lines at the start, every second, and at once on
 * `refresh()`. A read must not start the host, so the widget is hidden when no host runs. When a read fails, the widget
 * shows `<key>: <first line of the error>` in the error colour. A tick does not read while another read runs, and only
 * the newest read sets the lines, so a read that started before a change does not hide it. It sets the widget again
 * only when its lines change: Pi puts the widget that was set last at the bottom, so two widgets that are set at each
 * tick would swap their places.
 */
export class PolledWidget {
	readonly #key: string;
	readonly #read: ReadLines;
	readonly #errorMessage: (cause: unknown) => string;
	#context: ExtensionContext | undefined;
	#timer: ReturnType<typeof setInterval> | undefined;
	/** How many reads started, so a read knows whether a newer one started after it. */
	#started = 0;
	/** How many reads run now. */
	#reading = 0;
	/** The lines that the widget shows, or undefined before the first read sets them. */
	#shown: { lines: string[] | undefined } | undefined;

	constructor(key: string, read: ReadLines, errorMessage: (cause: unknown) => string) {
		this.#key = key;
		this.#read = read;
		this.#errorMessage = errorMessage;
	}

	/** Starts to show the widget in the session of `ctx`, when it has a UI. */
	start(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		this.#context = ctx;
		void this.refresh();
		this.#timer = setInterval(() => {
			if (this.#reading === 0) void this.refresh();
		}, 1000);
		this.#timer.unref();
	}

	/** Reads the lines now and shows them. It does nothing before `start()`, after `stop()` and without a UI. */
	async refresh(): Promise<void> {
		const context = this.#context;

		if (context === undefined) return;
		const read = ++this.#started;
		this.#reading++;
		let lines: string[] | undefined;

		try {
			lines = await this.#read(context);
		} catch (cause) {
			lines = [context.ui.theme.fg("error", `${this.#key}: ${this.#errorMessage(cause).split("\n", 1)[0]}`)];
		} finally {
			this.#reading--;
		}

		if (context !== this.#context || read !== this.#started) return;

		if (this.#shown !== undefined && Value.Equal(this.#shown.lines, lines)) return;
		this.#shown = { lines };
		context.ui.setWidget(this.#key, lines, { placement: "belowEditor" });
	}

	/** Stops reading and hides the widget, at the end of the session of `ctx`. */
	stop(ctx: ExtensionContext): void {
		if (this.#timer) clearInterval(this.#timer);
		this.#timer = undefined;
		this.#context = undefined;
		this.#shown = undefined;
		ctx.ui.setWidget(this.#key, undefined);
	}
}
