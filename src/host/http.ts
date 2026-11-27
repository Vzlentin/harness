/**
 * The HTTP parts of the host web server: the addresses it binds, the listen on them and the close, their URLs, the
 * `Host` header guard, the target fields, the JSON body parser and the host requests of the inspect routes, the JSON
 * replies, the browser files of the conversation pages, the content types of the served files, and the frames of the
 * inspect streams with their Server-Sent Events writer.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP, isIPv4, isIPv6 } from "node:net";
import { extname } from "node:path";
import type { ConversationView } from "@earendil-works/pi-durable";
import { type Static, type TSchema, Type } from "typebox";
import type { TLocalizedValidationError } from "typebox/error";
import { Value } from "typebox/value";
import { type ChildInfo, errorMessage, type Request } from "../protocol/requests.ts";
import { AGENT_HANDLE, parseTarget, type Target, targetRef } from "../protocol/target.ts";
import type { InspectSummary } from "../protocol/view-state.ts";

/** The address of this machine only, which each server binds. */
export const LOOPBACK = "127.0.0.1";

/** The largest body of a POST route. */
const MAX_BODY_BYTES = 1024 * 1024;

/** The browser files of the conversation pages, next to `src/` and `dist/` in the package. */
const WEB = new URL("../../web/", import.meta.url);

/** The browser files of the conversation pages, by the path that serves them. */
const ASSETS: ReadonlyMap<string, string> = new Map([
	["/assets/inspect.js", "inspect.js"],
	["/assets/inspect.css", "inspect.css"],
]);

/** The content type of a served file, by its extension. */
const TYPES: ReadonlyMap<string, string> = new Map([
	[".html", "text/html; charset=utf-8"],
	[".svg", "image/svg+xml"],
	[".css", "text/css; charset=utf-8"],
	[".js", "text/javascript; charset=utf-8"],
	[".png", "image/png"],
	[".json", "application/json; charset=utf-8"],
]);

/** The host and the target of a stream, an input and an abort. Without `handle` and `conversation`, the host agent. */
const TargetFields = {
	host: Type.String({ minLength: 1 }),
	handle: Type.Optional(Type.String({ minLength: 1 })),
	conversation: Type.Optional(Type.String({ minLength: 1 })),
};

/** The query of a stream and the body of an abort of the inspect routes. */
export const TargetQuery = Type.Object(TargetFields);

/** The body of an input of the inspect routes. */
export const InputBody = Type.Object({
	...TargetFields,
	message: Type.String(),
	followUp: Type.Optional(Type.Boolean()),
});

/** The address of a listening server. */
const ListenAddress = Type.Object({ port: Type.Integer() });

/** The servers that listen, one for each address, and their port. */
export type Listening = { readonly servers: readonly Server[]; readonly port: number };

/**
 * Listens on `port` of each of `hosts`, with one server for each. The first address takes the port, which the system
 * picks for 0, and the others listen on the same one. When an address fails, the servers that listen close.
 */
export async function listenAll(
	hosts: readonly string[],
	port: number,
	listener: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<Listening> {
	const servers: Server[] = [];
	let bound = port;

	try {
		for (const host of hosts) {
			const server = createServer(listener);
			servers.push(server);
			bound = await listen(server, host, bound);
		}
	} catch (error) {
		await closeAll(servers);
		throw error;
	}

	return { servers, port: bound };
}

/** Listens on `port` of `host`, and gives the port, which the system picks for 0. */
function listen(server: Server, host: string, port: number): Promise<number> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => {
			server.off("error", reject);
			resolve(Value.Parse(ListenAddress, server.address()).port);
		});
	});
}

/** Stops each of `servers` and closes every connection. */
export function closeAll(servers: readonly Server[]): Promise<void> {
	return Promise.all(
		servers.map(
			(server) =>
				new Promise<void>((resolve) => {
					// A server that did not listen calls back with an error, and has nothing to close.
					server.close(() => resolve());
					server.closeAllConnections();
				}),
		),
	).then(() => undefined);
}

/** The URL of `path`, which starts with `/`, on `port` of `host`, with an IPv6 address in brackets. */
export function serverUrl(host: string, port: number, path: string): string {
	return `http://${isIPv6(host) ? `[${host}]` : host}:${port}${path}`;
}

/** The host and the target of the query of `url`. Other keys are ignored. */
export function queryOf(url: URL): Static<typeof TargetQuery> {
	const query = Object.fromEntries(url.searchParams);

	if (!Value.Check(TargetQuery, query)) throw invalid("query", Value.Errors(TargetQuery, query));

	return query;
}

/** The target of the fields of a query or a body. It throws for both `handle` and `conversation`. */
export function inspectTarget({ handle, conversation }: Static<typeof TargetQuery>): Target {
	if (handle !== undefined && conversation !== undefined) throw new Error("Give handle or conversation, not both");

	return parseTarget(conversation === undefined ? { handle: handle ?? AGENT_HANDLE } : { conversation });
}

/** An input or an abort of the inspect routes, for the host `host`. */
export type InspectRequest = {
	readonly host: string;
	readonly request: Extract<Request, { type: "input" | "abort" }>;
};

/**
 * The request of the body of an input of the inspect routes. The host of the body is left to the server to check. It
 * throws for an empty message, and as `inspectTarget` does.
 */
export function inspectInput(body: Static<typeof InputBody>): InspectRequest {
	const { message, followUp, ...fields } = body;

	if (message.trim() === "") throw new Error("The message is empty");
	const input = { type: "input", requestId: randomUUID(), message, followUp: Boolean(followUp) } as const;

	return { host: body.host, request: { ...input, ...targetRef(inspectTarget(fields)) } };
}

/**
 * The request of the body of an abort of the inspect routes. The host of the body is left to the server to check. It
 * throws as `inspectTarget` does.
 */
export function inspectAbort(body: Static<typeof TargetQuery>): InspectRequest {
	return { host: body.host, request: { type: "abort", ...targetRef(inspectTarget(body)) } };
}

/**
 * One frame of an inspect stream: open, with the title of the agent, its info, its conversation and the summary of the
 * conversation, or failed for good, with the title of the target and the reason.
 */
type InspectFrame =
	| {
			readonly status: { readonly kind: "open" };
			readonly title: string;
			readonly child: ChildInfo;
			readonly view: ConversationView;
			readonly summary: InspectSummary;
	  }
	| { readonly status: { readonly kind: "failed"; readonly reason: string }; readonly title: string };

/** The Server-Sent Event of `frame`: one `data:` line, because JSON has no raw newline. */
export function frameEvent(frame: InspectFrame): string {
	return `data: ${JSON.stringify(frame)}\n\n`;
}

/** The content type of HTML files. */
export const HTML_TYPE = "text/html; charset=utf-8";

/** The content type of a served file with another extension. */
const OTHER_TYPE = "application/octet-stream";

/** The content type of a file with the extension `extension`, such as `.html`, in any case. */
export function contentType(extension: string): string {
	return TYPES.get(extension.toLowerCase()) ?? OTHER_TYPE;
}

/**
 * `127.0.0.1` with the IPv4 addresses of `tailscale ip -4`, each once. It throws when `tailscale ip -4` fails or gives
 * no IPv4 address.
 */
export async function tailscaleAddresses(): Promise<string[]> {
	const addresses = (await tailscaleIp()).split("\n").map((line) => line.trim());
	const ipv4 = addresses.filter((address) => isIPv4(address));

	if (ipv4.length === 0) throw new Error("tailscale ip -4 gave no IPv4 address");

	return [...new Set([LOOPBACK, ...ipv4])];
}

/** The output of `tailscale ip -4`. It rejects with its stderr, or with the error of `execFile`. */
function tailscaleIp(): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("tailscale", ["ip", "-4"], (error, stdout, stderr) => {
			if (error) reject(new Error(`tailscale ip -4 failed: ${stderr.trim() || error.message}`));
			else resolve(stdout);
		});
	});
}

/** Whether `host` is an IP address or `localhost`, which no DNS name of another site can be. */
function isAddress(host: string): boolean {
	return host === "localhost" || isIP(host) !== 0;
}

/** Whether the `Host` header names an address, as `isAddress` tells, so that a DNS rebinding cannot reach a route. */
export function addressHost(header: string | undefined): boolean {
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
 * Replies with the browser file of the path `pathname`, with `no-cache`, and tells whether `pathname` is the path of one.
 * A file that it cannot read gives 500.
 */
export async function sendAsset(res: ServerResponse, pathname: string): Promise<boolean> {
	const file = ASSETS.get(pathname);

	if (file === undefined) return false;
	let text: string;

	try {
		text = await readFile(new URL(file, WEB), "utf8");
	} catch (error) {
		res.writeHead(500, { "content-type": "text/plain; charset=utf-8" }).end(`${errorMessage(error)}\n`);

		return true;
	}

	res.writeHead(200, { "content-type": contentType(extname(file)), "cache-control": "no-cache" }).end(text);

	return true;
}

export function sendJson<B>(res: ServerResponse, status: number, body: B): void {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	res.end(JSON.stringify(body));
}

/** The error of a query or a body that does not match its schema: the path and the message of its first error. */
function invalid(what: string, [error]: readonly TLocalizedValidationError[]): Error {
	return new Error(`Invalid ${what}: ${[error?.instancePath, error?.message].filter((part) => part).join(" ")}`);
}

/**
 * The JSON body of `req`, as `schema` gives it. It throws when the body is not `application/json`, so that a form of
 * another site cannot post it, is longer than 1 MiB, is not JSON, or does not match. A longer body is read to its end,
 * so that the reply can go on the connection.
 */
export async function bodyOf<T extends TSchema>(req: IncomingMessage, schema: T): Promise<Static<T>> {
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

/**
 * Writes frames to `res`. While `res` waits for its socket to drain, it keeps only the newest frame, and writes it after
 * the drain: each frame has the whole view, so the older ones are not needed.
 */
export function frameWriter(res: ServerResponse): (frame: string) => void {
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
