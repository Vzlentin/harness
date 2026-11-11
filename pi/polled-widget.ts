/** Widgets below the editor, such as the subagents widget and the todo widget, and the reads of their lines. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";

/** Gives the lines of a widget for the session of `ctx`, or undefined to hide it. */
type ReadLines = (ctx: ExtensionContext) => Promise<string[] | undefined>;

/**
 * A widget below the editor of a session with a UI, which shows the lines that it gets. It sets the widget again only
 * when its lines change: Pi puts the widget that was set last at the bottom, so two widgets that are set at each tick
 * would swap their places.
 */
export class LinesWidget {
	readonly key: string;
	#context: ExtensionContext | undefined;
	/** The lines that the widget shows, or undefined before the first `show()` sets them. */
	#shown: { lines: string[] | undefined } | undefined;

	constructor(key: string) {
		this.key = key;
	}

	/** Starts to show the widget in the session of `ctx`, when it has a UI. */
	start(ctx: ExtensionContext): void {
		if (ctx.hasUI) this.#context = ctx;
	}

	/** Shows `lines`, or hides the widget for undefined. It does nothing before `start()`, after `stop()` and without a UI. */
	show(lines: string[] | undefined): void {
		const context = this.#context;

		if (context === undefined) return;

		if (this.#shown !== undefined && Value.Equal(this.#shown.lines, lines)) return;
		this.#shown = { lines };
		context.ui.setWidget(this.key, lines, { placement: "belowEditor" });
	}

	/** Hides the widget at the end of the session of `ctx`, and shows nothing more until the next `start()`. */
	stop(ctx: ExtensionContext): void {
		this.#context = undefined;
		this.#shown = undefined;
		ctx.ui.setWidget(this.key, undefined);
	}
}

/**
 * A widget below the editor whose lines come from the host. It reads them at the start, every second, and at once on
 * `refresh()`. A read must not start the host, so the widget is hidden when no host runs. When a read fails, the widget
 * shows `<key>: <first line of the error>` in the error colour. A tick does not read while another read runs, and only
 * the newest read shows its lines, so a read that started before a change does not hide it.
 */
export class PolledWidget {
	/** The widget that shows the lines. It can also start without the reads, to show lines from another source. */
	readonly widget: LinesWidget;
	readonly #read: ReadLines;
	readonly #errorMessage: (cause: unknown) => string;
	#context: ExtensionContext | undefined;
	#timer: ReturnType<typeof setInterval> | undefined;
	/** How many reads started, so a read knows whether a newer one started after it. */
	#started = 0;
	/** How many reads run now. */
	#reading = 0;

	constructor(key: string, read: ReadLines, errorMessage: (cause: unknown) => string) {
		this.widget = new LinesWidget(key);
		this.#read = read;
		this.#errorMessage = errorMessage;
	}

	/** Starts to read the lines of the widget in the session of `ctx`, when it has a UI. */
	start(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		this.widget.start(ctx);
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
			const reason = this.#errorMessage(cause).split("\n", 1)[0];
			lines = [context.ui.theme.fg("error", `${this.widget.key}: ${reason}`)];
		} finally {
			this.#reading--;
		}

		if (context === this.#context && read === this.#started) this.widget.show(lines);
	}

	/** Stops reading, and stops the widget, at the end of the session of `ctx`. */
	stop(ctx: ExtensionContext): void {
		if (this.#timer) clearInterval(this.#timer);
		this.#timer = undefined;
		this.#context = undefined;
		this.widget.stop(ctx);
	}
}
