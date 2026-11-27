/**
 * The routes of the conversation inspect UI: the JSON and Server-Sent Events routes under `/api/inspect/`, on the harness
 * hosts, with those that read the asks of a parley and write the answers of the user, the browser files under
 * `/assets/`, and the pages of `harness page` under `/pages/`. `harness inspect` serves them alone, and another server,
 * such as `workflows web`, can mount them on its own port.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { connect, HostUnreachableError, request, requestEntry } from "../client/client.ts";
import { Mirror, type MirrorTarget } from "../client/mirror.ts";
import { PageAnswer, Slug } from "../protocol/asks.ts";
import { cliCaller } from "../protocol/env.ts";
import { checkHost, MAIN_HOST, readHosts } from "../protocol/hosts.ts";
import {
	addressHost,
	bodyOf,
	frameEvent,
	frameWriter,
	InputBody,
	type InspectFrame,
	type InspectRequest,
	inspectAbort,
	inspectInput,
	inspectTarget,
	invalid,
	queryOf,
	sendAsset,
	sendJson,
	TargetQuery,
} from "../protocol/http.ts";
import { childTitle } from "../protocol/labels.ts";
import { type ChildInfo, errorMessage } from "../protocol/requests.ts";
import { AGENT_HANDLE } from "../protocol/target.ts";
import { viewSummary } from "../protocol/view-state.ts";
import { addSend, PAGES, readPage } from "./pages.ts";

/** The routes of the API start with this path. */
const API = "/api/inspect/";

export type InspectOptions = {
	/** Whether a stream, an input and an abort start the host when none runs. Default true. */
	readonly start?: boolean | undefined;
};

/** Serves a request of the inspect UI, and tells whether it was one. Another request is left to the caller. */
export type InspectHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

/** A target in the reply of `/api/inspect/targets`: the info of the agent, with its title, as a mirror gives it. */
export type InspectTarget = ChildInfo & { readonly title: string };

/**
 * The reply of `/api/inspect/targets`: whether the host runs, and the host agent and the children of
 * the caller of this process in it.
 */
export type InspectTargets = {
	readonly host: string;
	readonly running: boolean;
	readonly targets: readonly InspectTarget[];
};

/** The host and the parley of `/api/inspect/asks`. */
const AsksQuery = Type.Object({ host: TargetQuery.properties.host, parley: Slug });

/**
 * The body of `/api/inspect/answers`: the answers of the user to asks of the parley `parley`. Each answer names its ask
 * by `n`, its number in the parley, and has the other fields of an answer.
 */
const AnswersBody = Type.Object({
	host: TargetQuery.properties.host,
	parley: Slug,
	answers: Type.Array(PageAnswer, { minItems: 1 }),
});

/** The caller of the answers of `/api/inspect/answers`. No agent has it, so each asker gets the answers. */
const PAGE_CALLER = "page";

/** An error that the request causes, such as a refusal of the host. Its reply is 400. */
class BadRequest extends Error {}

/** The error when the host does not run and the request does not start one. */
class HostNotRunning extends Error {}

/**
 * The handler of the inspect routes. The routes of `/api/inspect/` and `/pages/` refuse a `Host` header that is not an IP
 * address or `localhost` with 403, so that a DNS rebinding cannot reach them, and the POST routes take only
 * `application/json`, so that a form of another site cannot post to them.
 */
export function createInspectHandler(options: InspectOptions = {}): InspectHandler {
	const start = options.start ?? true;

	return async (req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");

		if (req.method === "GET" && (await sendAsset(res, url.pathname))) return true;

		const page = url.pathname.startsWith(PAGES);

		if (!page && !url.pathname.startsWith(API)) return false;

		try {
			if (!addressHost(req.headers.host)) {
				sendJson(res, 403, { error: "The Host header must be an IP address or localhost" });
			} else if (page) {
				await servePage(req, res, url);
			} else {
				await serveApi(req, res, url, start);
			}
		} catch (error) {
			if (res.headersSent) res.destroy();
			else sendJson(res, 500, { error: errorMessage(error) });
		}

		return true;
	};
}

async function serveApi(req: IncomingMessage, res: ServerResponse, url: URL, start: boolean): Promise<void> {
	switch (`${req.method} ${url.pathname}`) {
		case "GET /api/inspect/hosts":
			return answer(res, () => undefined, hostList);
		case "GET /api/inspect/targets":
			return answer(res, () => checkHost(queryOf(url).host), targetsOf);
		case "GET /api/inspect/stream":
			return stream(res, url, start);
		case "POST /api/inspect/input":
			return answer(
				res,
				async () => hostRequest(inspectInput(await bodyOf(req, InputBody))),
				(sent) => toHost(sent, start),
			);
		case "POST /api/inspect/abort":
			return answer(
				res,
				async () => hostRequest(inspectAbort(await bodyOf(req, TargetQuery))),
				(sent) => toHost(sent, start),
			);
		case "GET /api/inspect/asks":
			return answer(
				res,
				() => asksOf(url),
				({ host, parley }) =>
					refusedAsBad(
						hostReply(requestEntry({ type: "parley", action: "read", slug: parley }, { start, host }), host),
					),
			);
		case "POST /api/inspect/answers":
			return answer(
				res,
				() => answersOf(req),
				({ host, answers }) =>
					refusedAsBad(
						hostReply(
							request({ type: "ask", action: "answer", caller: PAGE_CALLER, answers, user: true }, { start, host }),
							host,
						),
					),
			);
		default:
			notFound(req, res, url);
	}
}

/**
 * Serves a file of a page of `harness page`. The host of the path must be a known host, else every file gets 400. An
 * HTML file gets the script of the Send, which posts to the input route with the target of the path, and reads and
 * answers the parley of the slug of the page. Every other file goes as its bytes.
 */
async function servePage(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
	const file = req.method === "GET" ? await readPage(url.pathname) : undefined;

	if (file === undefined) {
		notFound(req, res, url);

		return;
	}

	const { host } = file;

	try {
		checkHost(host);
	} catch (error) {
		sendJson(res, 400, { error: errorMessage(error) });

		return;
	}

	const headers = { "content-type": file.type, "cache-control": "no-cache" };
	const data = file.html ? addSend(file.data.toString("utf8"), { host, ...file.ref }, file.slug) : file.data;
	res.writeHead(200, headers).end(data);
}

/**
 * Replies with the value that `act` gives for what `parse` gives: 400 with the error of `parse`, which the request
 * causes, and with a `BadRequest` of `act`, and 500 with another error of `act`, such as the refusal of the host on the
 * routes of the agent.
 */
async function answer<T, R>(
	res: ServerResponse,
	parse: () => Promise<T> | T,
	act: (parsed: T) => Promise<R> | R,
): Promise<void> {
	let parsed: T;

	try {
		parsed = await parse();
	} catch (error) {
		sendJson(res, 400, { error: errorMessage(error) });

		return;
	}

	try {
		sendJson(res, 200, await act(parsed));
	} catch (error) {
		sendJson(res, error instanceof BadRequest ? 400 : 500, { error: errorMessage(error) });
	}
}

function notFound(req: IncomingMessage, res: ServerResponse, url: URL): void {
	sendJson(res, 404, { error: `Not found: ${req.method} ${url.pathname}` });
}

/** The target of the query of `url`, or undefined after a reply of 400 for a query that is not valid. */
function queryTarget(res: ServerResponse, url: URL): MirrorTarget | undefined {
	try {
		return mirrorTarget(queryOf(url));
	} catch (error) {
		sendJson(res, 400, { error: errorMessage(error) });

		return undefined;
	}
}

/** The target of the fields of a query or a body. It throws for both `handle` and `conversation`, and for an unknown host. */
function mirrorTarget(fields: Static<typeof TargetQuery>): MirrorTarget {
	return { host: checkHost(fields.host), target: inspectTarget(fields) };
}

/** A host in the reply of `/api/inspect/hosts`. `main` has no directory. */
type InspectHost = { readonly name: string; readonly dir?: string };

/** The reply of `/api/inspect/hosts`. */
type HostList = { readonly hosts: readonly InspectHost[] };

/** The hosts, in creation order, then `main`. */
function hostList(): HostList {
	const hosts: InspectHost[] = Object.entries(readHosts()).map(([name, dir]) => ({ name, dir }));

	return { hosts: [...hosts, { name: MAIN_HOST }] };
}

/**
 * The host agent and the children of the caller of this process in the host `host`. They are none when the
 * host does not run: a list does not start it. The agent is left out when its watch fails, such as without a model.
 */
async function targetsOf(host: string): Promise<InspectTargets> {
	const client = await connect({ start: false, host });

	if (client === undefined) return { host, running: false, targets: [] };

	try {
		// The reply of the watch gives the agent's info. Its events are dropped, because the client has no `watch()`.
		const [agent, children] = await Promise.all([
			client.request({ type: "watch", handle: AGENT_HANDLE }).then(
				(reply) => reply.child,
				() => undefined,
			),
			client.request({ type: "list", caller: cliCaller(process.env) }),
		]);

		const found = agent === undefined ? children : [agent, ...children];

		return { host, running: true, targets: found.map((child) => ({ ...child, title: childTitle(child) })) };
	} finally {
		client.close();
	}
}

/** An input or an abort, whose host must be a known host. */
function hostRequest({ host, request }: InspectRequest): InspectRequest {
	return { host: checkHost(host), request };
}

/** Sends `sent` to its host. It throws as `hostReply` does. */
async function toHost(sent: InspectRequest, start: boolean): Promise<{ ok: true }> {
	await hostReply(request(sent.request, { start, host: sent.host }), sent.host);

	return { ok: true };
}

/** The host and the parley of the query of `url`. Other keys are ignored. */
function asksOf(url: URL): Static<typeof AsksQuery> {
	const query = Object.fromEntries(url.searchParams);

	if (!Value.Check(AsksQuery, query)) throw invalid("query", Value.Errors(AsksQuery, query));

	return { host: checkHost(query.host), parley: query.parley };
}

/** The host of the body of `req`, and its answers, each with the slug of the parley of the body. */
async function answersOf(req: IncomingMessage) {
	const { host, parley, answers } = await bodyOf(req, AnswersBody);

	return { host: checkHost(host), answers: answers.map((each) => ({ ...each, slug: parley })) };
}

/**
 * The reply of a host, sent to the host `host`. It throws the refusal of the host as an `Error`, a
 * `HostUnreachableError` when no host answers, and a `HostNotRunning` when no host runs and `start` was false.
 */
async function hostReply<R>(reply: Promise<R | undefined>, host: string): Promise<R> {
	const replied = await reply;

	if (replied === undefined) throw new HostNotRunning(`The harness host ${host} is not running`);

	return replied;
}

/**
 * The value of `reply`, with a refusal of the host as a `BadRequest`, so that its reply is 400. A
 * `HostUnreachableError` and a `HostNotRunning` go as they are.
 */
async function refusedAsBad<R>(reply: Promise<R>): Promise<R> {
	try {
		return await reply;
	} catch (error) {
		if (error instanceof HostUnreachableError || error instanceof HostNotRunning) throw error;

		throw new BadRequest(errorMessage(error), { cause: error });
	}
}

/**
 * Streams the frames of a mirror of the target of the query as Server-Sent Events, or replies 400 for a query that is
 * not valid. A frame goes at once, then one after each change of the mirror. When the mirror fails, the last frame has
 * the reason and the response ends. The mirror closes when the response closes.
 */
function stream(res: ServerResponse, url: URL, start: boolean): void {
	const target = queryTarget(res, url);

	if (target === undefined) return;
	res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" });
	const write = frameWriter(res);

	const mirror = new Mirror(
		target,
		() => {
			// A watch line that came before `close()` can still change the mirror.
			if (res.writableEnded || res.destroyed) return;
			const frame = eventOf(mirror);

			if (mirror.status.kind !== "failed") {
				write(frame);

				return;
			}

			res.end(frame);
			mirror.close();
		},
		{ start },
	);

	res.on("close", () => mirror.close());
	write(eventOf(mirror));
}

/** The event of the current frame of `mirror`. */
function eventOf(mirror: Mirror): string {
	return frameEvent(frameOf(mirror));
}

function frameOf(mirror: Mirror): InspectFrame {
	const { status, title, child, view } = mirror;

	return {
		status,
		title,
		child,
		view,
		summary: view === undefined ? undefined : viewSummary(view),
	};
}
