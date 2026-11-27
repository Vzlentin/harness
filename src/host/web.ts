/**
 * The web server of the host: the inspect UI of its conversations, the folders that its callers serve, and the Send of
 * their pages, which queues a delivery to the caller. It listens on one port of each bound address, and keeps the port
 * in `<state dir>/web.json`, so the links stay valid after a restart.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationView } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
	addressHost,
	bodyOf,
	closeAll,
	frameEvent,
	frameWriter,
	InputBody,
	type InspectRequest,
	inspectAbort,
	inspectInput,
	inspectTarget,
	type Listening,
	listenAll,
	queryOf,
	sendAsset,
	sendJson,
	serverUrl,
	TargetQuery,
} from "../protocol/http.ts";
import { readJsonFile, writeJsonFile } from "../protocol/json-file.ts";
import { childTitle } from "../protocol/labels.ts";
import { type ChildInfo, errorMessage, type Replies } from "../protocol/requests.ts";
import { scriptLiteral } from "../protocol/send-script.ts";
import { AGENT_HANDLE, type Target } from "../protocol/target.ts";
import { applyChange } from "../protocol/view-change.ts";
import { viewSummary } from "../protocol/view-state.ts";
import type { Base } from "./dispatch.ts";
import type { EntryDelivery } from "./entries.ts";
import { addFolderSend, findFolder, folderPath, readFolderFile } from "./folders.ts";
import { callerHandle, ChildRecords, recordsByAge } from "./records.ts";
import { serveWatch, type WatchSink } from "./watch.ts";

const context = BACKGROUND_CONTEXT;

/** The port that `web.json` keeps. */
const WebState = Type.Object({ port: Type.Integer({ minimum: 1, maximum: 65535 }) });

/** The body of the Send of a page of a folder. */
const SendBody = Type.Object({ message: Type.String(), key: Type.String({ minLength: 1 }) });

export type WebOptions = {
	readonly base: Base;
	/** The state directory of the host, which holds `web.json`. */
	readonly stateDir: string;
	/** The addresses to listen on. */
	readonly hosts: readonly string[];
	/** Serves an input or an abort in the host process. */
	readonly send: (request: InspectRequest["request"], signal: AbortSignal) => Promise<Replies["input" | "abort"]>;
	/** Queues a delivery, and gives whether it queued it (see `queueDelivery`). */
	readonly deliver: (delivery: EntryDelivery) => Promise<boolean>;
	/** Runs at each request, which counts as activity for the idle exit. */
	readonly activity: () => void;
	/** Keeps the promise of a request, which the close of the host awaits. */
	readonly track: (promise: Promise<unknown>) => void;
};

export type Web = {
	/** The links of `path` on each address, in the order of the addresses. */
	links(path: string): string[];
	/** Whether a stream is open. */
	busy(): boolean;
	/** Stops listening, ends the streams and closes every connection. */
	close(): Promise<void>;
};

/**
 * Starts the web server of the host on each address of `hosts`. It takes the port of `web.json` again when it can, else
 * a free port, which it writes to `web.json`. Every route refuses a `Host` header that is not an IP address or
 * `localhost` with 403, so that a DNS rebinding cannot reach it.
 */
export async function startWeb(options: WebOptions): Promise<Web> {
	const { stateDir, hosts, activity, track } = options;
	const closing = new AbortController();
	const streams = new Set<ServerResponse>();

	const listener = (req: IncomingMessage, res: ServerResponse) => {
		activity();

		const served = route(options, req, res, { streams, signal: closing.signal }).catch((cause: unknown) => {
			if (res.headersSent) res.destroy();
			else sendJson(res, 500, { error: errorMessage(cause) });
		});

		track(served);
	};

	const file = join(stateDir, "web.json");
	const saved = savedPort(file);
	let listening: Listening;

	try {
		listening = await listenAll(hosts, saved ?? 0, listener);
	} catch (error) {
		if (saved === undefined) throw error;
		listening = await listenAll(hosts, 0, listener);
	}

	const { servers, port } = listening;

	if (port !== saved) writeJsonFile(file, { port });

	return {
		links: (path) => hosts.map((host) => serverUrl(host, port, path)),
		busy: () => streams.size > 0,
		close: () => {
			closing.abort();

			return closeAll(servers);
		},
	};
}

/** The port of `web.json`, or undefined when the file does not exist or has no valid port. */
function savedPort(file: string): number | undefined {
	let state: unknown;

	try {
		state = readJsonFile(file);
	} catch {
		return undefined;
	}

	return Value.Check(WebState, state) ? state.port : undefined;
}

/** The open streams, and the signal of the close of the server. */
type Live = { readonly streams: Set<ServerResponse>; readonly signal: AbortSignal };

async function route(options: WebOptions, req: IncomingMessage, res: ServerResponse, live: Live): Promise<void> {
	const url = new URL(req.url ?? "/", "http://localhost");

	if (!addressHost(req.headers.host)) {
		sendJson(res, 403, { error: "The Host header must be an IP address or localhost" });

		return;
	}

	if (req.method === "GET" && (await sendAsset(res, url.pathname))) return;

	switch (`${req.method} ${url.pathname}`) {
		case "GET /api/inspect/stream":
			return stream(options.base, res, url, live);
		case "POST /api/inspect/input":
			return toHost(res, live.signal, options, async () =>
				hostRequest(options.base, inspectInput(await bodyOf(req, InputBody))),
			);
		case "POST /api/inspect/abort":
			return toHost(res, live.signal, options, async () =>
				hostRequest(options.base, inspectAbort(await bodyOf(req, TargetQuery))),
			);
	}

	const segments = pathSegments(url.pathname);

	if (segments?.length === 2 && segments[1] === "" && req.method === "GET") {
		return conversationPage(options.base, res, segments[0] ?? "");
	}

	if (segments !== undefined && segments.length >= 3) {
		const [caller = "", name = "", ...rest] = segments;
		const folder = await findFolder(options.base.harness, caller, name);

		if (folder !== undefined && req.method === "GET") {
			const found = await readFolderFile(folder, rest);

			if (found !== undefined) {
				const data = found.html ? addFolderSend(found.data.toString("utf8"), folderPath(caller, name)) : found.data;
				res.writeHead(200, { "content-type": found.type, "cache-control": "no-cache" }).end(data);

				return;
			}
		}

		if (folder !== undefined && req.method === "POST" && rest.length === 1 && rest[0] === "") {
			return sendToCaller(options, req, res, caller);
		}
	}

	sendJson(res, 404, { error: `Not found: ${req.method} ${url.pathname}` });
}

/** The decoded segments of `pathname` after its first `/`, or undefined when one does not percent-decode. */
function pathSegments(pathname: string): string[] | undefined {
	try {
		return pathname.slice(1).split("/").map(decodeURIComponent);
	} catch {
		return undefined;
	}
}

/** Throws when `host` is not this host. */
function checkThisHost(base: Base, host: string): void {
	if (host !== base.host) throw new Error(`This host is ${base.host}, not ${host}`);
}

/** The target of the fields of a query, whose host must be this host. */
function hostTarget(base: Base, fields: Parameters<typeof inspectTarget>[0]): Target {
	checkThisHost(base, fields.host);

	return inspectTarget(fields);
}

/** The request of an input or an abort, whose host must be this host. */
function hostRequest(base: Base, { host, request }: InspectRequest): InspectRequest["request"] {
	checkThisHost(base, host);

	return request;
}

/**
 * Serves the request that `parse` gives in the host process, and replies `{ ok: true }`: 400 for an error of `parse`,
 * and 500 for an error of the host.
 */
async function toHost(
	res: ServerResponse,
	signal: AbortSignal,
	options: WebOptions,
	parse: () => Promise<InspectRequest["request"]>,
): Promise<void> {
	let parsed: InspectRequest["request"];

	try {
		parsed = await parse();
	} catch (error) {
		sendJson(res, 400, { error: errorMessage(error) });

		return;
	}

	await options.send(parsed, signal);
	sendJson(res, 200, { ok: true });
}

/**
 * Streams the frames of the target of the query as Server-Sent Events, as the stream of `harness inspect` does: a frame
 * at once, then one after each line of the watch. When the watch fails, the one frame has the reason. The watch stops
 * when the response closes.
 */
async function stream(base: Base, res: ServerResponse, url: URL, live: Live): Promise<void> {
	let ref: Target;

	try {
		ref = hostTarget(base, queryOf(url));
	} catch (error) {
		sendJson(res, 400, { error: errorMessage(error) });

		return;
	}

	const closed = new AbortController();
	live.streams.add(res);

	res.on("close", () => {
		live.streams.delete(res);
		closed.abort();
	});

	const write = frameWriter(res);
	let current: { view: ConversationView; child: ChildInfo } | undefined;
	let afterReply: (() => void) | undefined;

	const sink: WatchSink = {
		get writable() {
			return !res.writableEnded && !res.destroyed;
		},
		write: ({ change, child }) => {
			if (current === undefined) return true;
			current = { view: applyChange(current.view, change), child };
			write(openFrame(current.view, child));

			return true;
		},
		drained: async () => {},
		end: () => res.end(),
		afterReply: (run) => (afterReply = run),
	};

	res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" });

	try {
		current = await serveWatch({ ...base, signal: AbortSignal.any([closed.signal, live.signal]) }, ref, sink);
	} catch (error) {
		const status = { kind: "failed", reason: errorMessage(error) } as const;
		const title = targetTitle(base.host, ref);
		res.end(frameEvent({ status, title, child: undefined, view: undefined, summary: undefined }));

		return;
	}

	write(openFrame(current.view, current.child));
	afterReply?.();
}

/** The event of the frame of an open stream, with the view and the child that the watch gave. */
function openFrame(view: ConversationView, child: ChildInfo): string {
	return frameEvent({ status: { kind: "open" }, title: childTitle(child), child, view, summary: viewSummary(view) });
}

/** The title of the agent of `ref` before the host gives its info. */
function targetTitle(host: string, ref: Target): string {
	switch (ref.kind) {
		case "agent":
			return `${host} agent`;
		case "child":
			return ref.handle;
		case "conversation":
			return ref.id;
	}
}

/**
 * The page of the conversation `id`: the inspect UI of the host agent for the root, and of the child for the
 * conversation of a child by handle. Another ID gives 404.
 */
async function conversationPage(base: Base, res: ServerResponse, id: string): Promise<void> {
	const state = await base.harness.snapshot(ChildRecords, context);
	const handle = callerHandle(base.root.id, recordsByAge(state), id);

	if (handle === undefined) {
		sendJson(res, 404, { error: `Unknown conversation: ${id}` });

		return;
	}

	const target = handle === AGENT_HANDLE ? { host: base.host } : { host: base.host, handle };
	res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" }).end(page(target));
}

/** The page that draws the conversation of `target` with `mountInspect`. Esc stops its turn. */
function page(target: Readonly<Record<string, string>>): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>harness</title>
<link rel="stylesheet" href="/assets/inspect.css">
</head>
<body class="inspect-page">
<main id="inspect"><div class="inspect-body" id="view"></div></main>
<script type="module">
import { mountInspect } from "/assets/inspect.js";
const view = mountInspect(document.getElementById("view"), ${scriptLiteral(target)}, {
	onTitle: (title) => {
		document.title = title;
	},
});
document.addEventListener("keydown", (event) => {
	if (event.key === "Escape" && !event.defaultPrevented) view.interrupt();
});
</script>
</body>
</html>
`;
}

/**
 * The Send of a page of a folder of `caller`: queues the message of the body as a delivery to `caller` with the key of
 * the body, and replies `{ ok: true, repeated }`, where `repeated` is true when the key waits or went already.
 */
async function sendToCaller(
	options: WebOptions,
	req: IncomingMessage,
	res: ServerResponse,
	caller: string,
): Promise<void> {
	let body: { message: string; key: string };

	try {
		body = await bodyOf(req, SendBody);

		if (body.message.trim() === "") throw new Error("The message is empty");
	} catch (error) {
		sendJson(res, 400, { error: errorMessage(error) });

		return;
	}

	const queued = await options.deliver({ key: body.key, to: caller, text: body.message });
	sendJson(res, 200, { ok: true, repeated: !queued });
}
