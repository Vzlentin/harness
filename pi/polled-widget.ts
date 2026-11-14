/**
 * The widgets of a Pi session, such as the subagents widget below the editor and the todo widget above it, and the reads
 * of their lines.
 */
import type { ExtensionContext, WidgetPlacement } from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { Value } from "typebox/value";

/** Gives the lines of a widget for the session of `ctx`, or undefined to hide it. */
type ReadLines = (ctx: ExtensionContext) => Promise<string[] | undefined>;

/**
 * A widget set in one session: the TUI that draws its component, once Pi gives it, and the lines that it shows, or
 * undefined before the first `show()` gives them. A factory of an earlier session writes only into its own object.
 */
type WidgetSession = { tui: TUI | undefined; shown: { lines: string[] | undefined } | undefined };

/**
 * A widget of a session with a UI, at `placement`, which shows the lines that it gets. It is set one time, as a
 * component, at its start: Pi puts the widget that was set last at the end of its side, so a widget that is set again
 * moves. A change of the lines asks the TUI for a render. The component cuts each line at the width with `…`, after
 * the 1-column indent of Pi's string widgets, and draws no line when the widget shows nothing.
 */
export class LinesWidget {
	readonly key: string;
	readonly #placement: WidgetPlacement;
	/** The session where the widget is set, between `start()` and `stop()`. */
	#session: WidgetSession | undefined;

	constructor(key: string, placement: WidgetPlacement) {
		this.key = key;
		this.#placement = placement;
	}

	/** Sets the widget in the session of `ctx`, when it has a UI. */
	start(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const session: WidgetSession = { tui: undefined, shown: undefined };
		this.#session = session;

		const component: Component = {
			render: (width) => (session.shown?.lines ?? []).map((line) => truncateToWidth(` ${line}`, width, "…")),
			invalidate: () => {},
		};

		ctx.ui.setWidget(
			this.key,
			(tui) => {
				session.tui = tui;

				return component;
			},
			{ placement: this.#placement },
		);
	}

	/** Shows `lines`, or nothing for undefined. It does nothing before `start()`, after `stop()` and without a UI. */
	show(lines: string[] | undefined): void {
		const session = this.#session;

		if (session === undefined) return;

		if (session.shown !== undefined && Value.Equal(session.shown.lines, lines)) return;
		session.shown = { lines };
		session.tui?.requestRender();
	}

	/** Removes the widget at the end of the session of `ctx`, and shows nothing more until the next `start()`. */
	stop(ctx: ExtensionContext): void {
		ctx.ui.setWidget(this.key, undefined);
		this.#session = undefined;
	}
}

/**
 * A widget whose lines come from the host. It reads them at the start, every second, and at once on `refresh()`. A
 * read must not start the host, so the widget is hidden when no host runs. When a read fails, the widget shows only
 * `<key>: <first line of the error>` in the error colour, with no header. A tick does not read while another read runs, and only
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

	constructor(key: string, placement: WidgetPlacement, read: ReadLines, errorMessage: (cause: unknown) => string) {
		this.widget = new LinesWidget(key, placement);
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
