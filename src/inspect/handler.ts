/**
 * The routes of the conversation inspect UI: the JSON and Server-Sent Events routes under `/api/inspect/`, on the harness
 * hosts, with those that read the asks of a parley and write the answers of the user, the browser files under
 * `/assets/`, and the pages of `harness page` under `/pages/`. `harness inspect` serves them alone, and another server,
 * such as `workflows web`, can mount them on its own port.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import type { Usage } from "@earendil-works/pi-ai";
import type { ConversationView } from "@earendil-works/pi-durable";
import { type Static, type TSchema, Type } from "typebox";
import type { TLocalizedValidationError } from "typebox/error";
import { Value } from "typebox/value";
import { connect, HostUnreachableError, request, requestEntry } from "../client/client.ts";
import { Mirror, type MirrorStatus, type MirrorTarget } from "../client/mirror.ts";
import {
	inboxOf,
	lastAnswerUsage,
	liveOf,
	queued,
	statusText,
	type UsageTotals,
	usageTotals,
} from "../client/view-state.ts";
import { PageAnswer, Slug } from "../protocol/asks.ts";
import { cliCaller } from "../protocol/env.ts";
import { checkHost, MAIN_HOST, readHosts } from "../protocol/hosts.ts";
import { childTitle } from "../protocol/labels.ts";
import { type ChildInfo, errorMessage, type Request } from "../protocol/requests.ts";
import { AGENT_HANDLE, parseTarget, targetRef } from "../protocol/target.ts";
import { addSend, PAGES, readPage } from "./pages.ts";

/** The routes of the API start with this path. */
const API = "/api/inspect/";

/** The browser files, next to `src/` and `dist/` in the package. */
const WEB = new URL("../../web/", import.meta.url);

/** The browser files, by the path that serves them. */
const ASSETS: ReadonlyMap<string, { readonly file: string; readonly type: string }> = new Map([
	["/assets/inspect.js", { file: "inspect.js", type: "text/javascript; charset=utf-8" }],
	["/assets/inspect.css", { file: "inspect.css", type: "text/css; charset=utf-8" }],
]);

/** The largest body of a POST route. */
const MAX_BODY_BYTES = 1024 * 1024;

export type InspectOptions = {
	/** Whether a stream, an input and an abort start the host when none runs. Default true. */
	readonly start?: boolean | undefined;
};

/** Serves a request of the inspect UI, and tells whether it was one. Another request is left to the caller. */
export type InspectHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

/** What the footer of the UI shows: the work of the agent, its queued messages, and its usage. */
export type InspectSummary = {
	readonly statusText: string;
	readonly queued: { mode: "steer" | "followUp"; text: string }[];
	readonly usageTotals: UsageTotals;
	readonly lastAnswerUsage: Usage | undefined;
};

/**
 * One frame of a stream: the connection to the host, the title of the agent, its info and its conversation, and the
 * summary of the conversation. `child`, `view` and `summary` are undefined before the first connection.
 */
export type InspectFrame = {
	readonly status: MirrorStatus;
	readonly title: string;
	readonly child: ChildInfo | undefined;
	readonly view: ConversationView | undefined;
	readonly summary: InspectSummary | undefined;
};

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

/** The host and the target of a stream, an input and an abort. Without `handle` and `conversation`, the host agent. */
const TargetFields = {
	host: Type.String({ minLength: 1 }),
	handle: Type.Optional(Type.String({ minLength: 1 })),
	conversation: Type.Optional(Type.String({ minLength: 1 })),
};

const TargetQuery = Type.Object(TargetFields);

const InputBody = Type.Object({ ...TargetFields, message: Type.String(), followUp: Type.Optional(Type.Boolean()) });

/** The host and the parley of `/api/inspect/asks`. */
const AsksQuery = Type.Object({ host: TargetFields.host, parley: Slug });

/**
 * The body of `/api/inspect/answers`: the answers of the user to asks of the parley `parley`. Each answer names its ask
 * by `n`, its number in the parley, and has the other fields of an answer.
 */
const AnswersBody = Type.Object({
	host: TargetFields.host,
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
		const asset = ASSETS.get(url.pathname);

		if (asset !== undefined && req.method === "GET") {
			await sendAsset(res, asset.file, asset.type);

			return true;
		}

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

async function sendAsset(res: ServerResponse, file: string, type: string): Promise<void> {
	let text: string;

	try {
		text = await readFile(new URL(file, WEB), "utf8");
	} catch (error) {
		res.writeHead(500, { "content-type": "text/plain; charset=utf-8" }).end(`${errorMessage(error)}\n`);

		return;
	}

	res.writeHead(200, { "content-type": type, "cache-control": "no-cache" }).end(text);
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
				() => inputOf(req),
				(sent) => toHost(sent, start),
			);
		case "POST /api/inspect/abort":
			return answer(
				res,
				() => abortOf(req),
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
 * Serves a file of a page of `harness page`. An HTML file whose query has a target gets the script of the Send, which
 * posts to the input route with that target, and reads and answers the parley of the slug of the page; a query that is
 * not valid gets 400. Every other file goes as its bytes.
 */
async function servePage(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
	const file = req.method === "GET" ? await readPage(url.pathname) : undefined;

	if (file === undefined) {
		notFound(req, res, url);

		return;
	}

	const headers = { "content-type": file.type, "cache-control": "no-cache" };
	const targeted = Object.keys(TargetFields).some((key) => url.searchParams.has(key));

	if (!file.html || !targeted) {
		res.writeHead(200, headers).end(file.data);

		return;
	}

	const target = queryTarget(res, url);

	if (target === undefined) return;
	const fields = { host: target.host, ...targetRef(target.target) };
	res.writeHead(200, headers).end(addSend(file.data.toString("utf8"), fields, file.slug));
}

/** Whether `host` is an IP address or `localhost`, which no DNS name of another site can be. */
export function isAddress(host: string): boolean {
	return host === "localhost" || isIP(host) !== 0;
}

/** Whether the `Host` header names an address, as `isAddress` tells. */
function addressHost(header: string | undefined): boolean {
	if (header === undefined) return false;
	let hostname: string;

	try {
		hostname = new URL(`http://${header}`).hostname;
	} catch {
		return false;
	}

	return isAddress(hostname.replace(/^\[(.*)\]$/, "$1"));
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

function sendJson<B>(res: ServerResponse, status: number, body: B): void {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	res.end(JSON.stringify(body));
}

function invalid(what: string, [error]: readonly TLocalizedValidationError[]): Error {
	return new Error(`Invalid ${what}: ${[error?.instancePath, error?.message].filter((part) => part).join(" ")}`);
}

/** The host and the target of the query of `url`. Other keys are ignored. */
function queryOf(url: URL): Static<typeof TargetQuery> {
	const query = Object.fromEntries(url.searchParams);

	if (!Value.Check(TargetQuery, query)) throw invalid("query", Value.Errors(TargetQuery, query));

	return query;
}

/**
 * The JSON body of `req`, as `schema` gives it. It throws when the body is not `application/json`, is longer than 1
 * MiB, is not JSON, or does not match. A longer body is read to its end, so that the reply can go on the connection.
 */
async function bodyOf<T extends TSchema>(req: IncomingMessage, schema: T): Promise<Static<T>> {
	const type = req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();

	if (type !== "application/json") throw new Error("The body must be application/json");
	const chunks: Buffer[] = [];
	let size = 0;

	for await (const chunk of req) {
		size += chunk.length;

		if (size <= MAX_BODY_BYTES) chunks.push(chunk);
	}

	if (size > MAX_BODY_BYTES) throw new Error("The body is longer than 1 MiB");
	let body: unknown;

	try {
		body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new Error("The body is not JSON");
	}

	if (!Value.Check(schema, body)) throw invalid("body", Value.Errors(schema, body));

	return body;
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
function mirrorTarget({ host, handle, conversation }: Static<typeof TargetQuery>): MirrorTarget {
	if (handle !== undefined && conversation !== undefined) throw new Error("Give handle or conversation, not both");
	const ref = conversation === undefined ? { handle: handle ?? AGENT_HANDLE } : { conversation };

	return { host: checkHost(host), target: parseTarget(ref) };
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

/** A request of a POST route, for the host `host`. */
type HostRequest = { readonly host: string; readonly request: Extract<Request, { type: "input" | "abort" }> };

async function inputOf(req: IncomingMessage): Promise<HostRequest> {
	const { message, followUp, ...fields } = await bodyOf(req, InputBody);

	if (message.trim() === "") throw new Error("The message is empty");
	const { host, target } = mirrorTarget(fields);
	const input = { type: "input", requestId: randomUUID(), message, followUp: Boolean(followUp) } as const;

	return { host, request: { ...input, ...targetRef(target) } };
}

async function abortOf(req: IncomingMessage): Promise<HostRequest> {
	const { host, target } = mirrorTarget(await bodyOf(req, TargetQuery));

	return { host, request: { type: "abort", ...targetRef(target) } };
}

/** Sends `sent` to its host. It throws as `hostReply` does. */
async function toHost(sent: HostRequest, start: boolean): Promise<{ ok: true }> {
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

/** The event of the current frame of `mirror`: one `data:` line, because JSON has no raw newline. */
function eventOf(mirror: Mirror): string {
	return `data: ${JSON.stringify(frameOf(mirror))}\n\n`;
}

/**
 * Writes frames to `res`. While `res` waits for its socket to drain, it keeps only the newest frame, and writes it after
 * the drain: each frame has the whole view, so the older ones are not needed.
 */
function frameWriter(res: ServerResponse): (frame: string) => void {
	let draining = false;
	let held: string | undefined;

	const write = (frame: string) => {
		if (draining) held = frame;
		else draining = !res.write(frame);
	};

	res.on("drain", () => {
		const frame = held;
		draining = false;
		held = undefined;

		if (frame !== undefined) write(frame);
	});

	return write;
}

function frameOf(mirror: Mirror): InspectFrame {
	const { status, title, child, view } = mirror;

	return {
		status,
		title,
		child,
		view,
		summary: view === undefined ? undefined : summaryOf(view),
	};
}

function summaryOf(view: ConversationView): InspectSummary {
	return {
		statusText: statusText(liveOf(view)),
		queued: queued(inboxOf(view)),
		usageTotals: usageTotals(view),
		lastAnswerUsage: lastAnswerUsage(view),
	};
}
