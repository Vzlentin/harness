/**
 * The routes of the conversation inspect UI: the JSON and Server-Sent Events routes under `/api/inspect/`, on the hosts
 * of the projects, and the browser files under `/assets/`. `harness inspect` serves them alone, and another server,
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
import { connect, request } from "../client/client.ts";
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
import { cliCaller } from "../protocol/env.ts";
import { childTitle } from "../protocol/labels.ts";
import { checkProject, MAIN_PROJECT, readProjects } from "../protocol/projects.ts";
import { type ChildInfo, errorMessage, type Request } from "../protocol/requests.ts";
import { AGENT_HANDLE, parseTarget, targetRef } from "../protocol/target.ts";

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
	/** Whether a stream, an input and an abort start the host of the project when none runs. Default true. */
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
 * The reply of `/api/inspect/targets`: whether the host of the project runs, and the project agent and the children of
 * the caller of this process in it.
 */
export type InspectTargets = {
	readonly project: string;
	readonly running: boolean;
	readonly targets: readonly InspectTarget[];
};

/** The project and the target of a stream, an input and an abort. Without `handle` and `conversation`, the project agent. */
const TargetFields = {
	project: Type.String({ minLength: 1 }),
	handle: Type.Optional(Type.String({ minLength: 1 })),
	conversation: Type.Optional(Type.String({ minLength: 1 })),
};

const TargetQuery = Type.Object(TargetFields);

const InputBody = Type.Object({ ...TargetFields, message: Type.String(), followUp: Type.Optional(Type.Boolean()) });

/**
 * The handler of the inspect routes. The routes of `/api/inspect/` refuse a `Host` header that is not an IP address or
 * `localhost` with 403, so that a DNS rebinding cannot reach them, and the POST routes take only `application/json`, so
 * that a form of another site cannot post to them.
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

		if (!url.pathname.startsWith(API)) return false;

		try {
			await serveApi(req, res, url, start);
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
	if (!addressHost(req.headers.host)) {
		sendJson(res, 403, { error: "The Host header must be an IP address or localhost" });

		return;
	}

	switch (`${req.method} ${url.pathname}`) {
		case "GET /api/inspect/projects":
			return answer(res, () => undefined, projectList);
		case "GET /api/inspect/targets":
			return answer(res, () => checkProject(queryOf(url).project), targetsOf);
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
		default:
			sendJson(res, 404, { error: `Not found: ${req.method} ${url.pathname}` });
	}
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
 * causes, and 500 with the error of `act`, such as the refusal of the host.
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
		sendJson(res, 500, { error: errorMessage(error) });
	}
}

function sendJson<B>(res: ServerResponse, status: number, body: B): void {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	res.end(JSON.stringify(body));
}

function invalid(what: string, [error]: readonly TLocalizedValidationError[]): Error {
	return new Error(`Invalid ${what}: ${[error?.instancePath, error?.message].filter((part) => part).join(" ")}`);
}

/** The project and the target of the query of `url`. Other keys are ignored. */
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

/** The target of the fields of a query or a body. It throws for both `handle` and `conversation`, and for an unknown project. */
function mirrorTarget({ project, handle, conversation }: Static<typeof TargetQuery>): MirrorTarget {
	if (handle !== undefined && conversation !== undefined) throw new Error("Give handle or conversation, not both");
	const ref = conversation === undefined ? { handle: handle ?? AGENT_HANDLE } : { conversation };

	return { project: checkProject(project), target: parseTarget(ref) };
}

/** A project in the reply of `/api/inspect/projects`. `main` has no directory. */
type InspectProject = { readonly name: string; readonly dir?: string };

/** The reply of `/api/inspect/projects`. */
type ProjectList = { readonly projects: readonly InspectProject[] };

/** The projects, in creation order, then `main`. */
function projectList(): ProjectList {
	const projects: InspectProject[] = Object.entries(readProjects()).map(([name, dir]) => ({ name, dir }));

	return { projects: [...projects, { name: MAIN_PROJECT }] };
}

/**
 * The project agent and the children of the caller of this process in the host of `project`. They are none when the
 * host does not run: a list does not start it. The agent is left out when its watch fails, such as without a model.
 */
async function targetsOf(project: string): Promise<InspectTargets> {
	const client = await connect({ start: false, project });

	if (client === undefined) return { project, running: false, targets: [] };

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

		return { project, running: true, targets: found.map((child) => ({ ...child, title: childTitle(child) })) };
	} finally {
		client.close();
	}
}

/** A request of a POST route, for the host of `project`. */
type HostRequest = { readonly project: string; readonly request: Extract<Request, { type: "input" | "abort" }> };

async function inputOf(req: IncomingMessage): Promise<HostRequest> {
	const { message, followUp, ...fields } = await bodyOf(req, InputBody);

	if (message.trim() === "") throw new Error("The message is empty");
	const { project, target } = mirrorTarget(fields);
	const input = { type: "input", requestId: randomUUID(), message, followUp: Boolean(followUp) } as const;

	return { project, request: { ...input, ...targetRef(target) } };
}

async function abortOf(req: IncomingMessage): Promise<HostRequest> {
	const { project, target } = mirrorTarget(await bodyOf(req, TargetQuery));

	return { project, request: { type: "abort", ...targetRef(target) } };
}

/** Sends `sent` to its host. It throws when no host runs and `start` is false, and with the refusal of the host. */
async function toHost(sent: HostRequest, start: boolean): Promise<{ ok: true }> {
	const { project } = sent;

	if ((await request(sent.request, { start, project })) === undefined) {
		throw new Error(`The harness host of ${project} is not running`);
	}

	return { ok: true };
}

/**
 * Streams the frames of a mirror of the target of the query as Server-Sent Events, or replies 400 for a query that is
 * not valid. A frame goes at once, then one after each change of the mirror. When the mirror fails, the last frame has
 * the reason and the response ends. The mirror closes when the response closes.
 */
function stream(res: ServerResponse, url: URL, start: boolean): void {
	let target: MirrorTarget;

	try {
		target = mirrorTarget(queryOf(url));
	} catch (error) {
		sendJson(res, 400, { error: errorMessage(error) });

		return;
	}

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
