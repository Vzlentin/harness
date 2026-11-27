/**
 * The standalone server of the inspect UI: the page at `/` and the routes of `createInspectHandler`, on one port of each
 * bound address.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { connect } from "node:net";
import type { MirrorTarget } from "../client/mirror.ts";
import { checkBindHost, closeAll, listenAll, LOOPBACK, serverUrl } from "../protocol/http.ts";
import { targetRef } from "../protocol/target.ts";
import { createInspectHandler, type InspectHandler } from "./handler.ts";
import { pagePath } from "./pages.ts";

/** The port of the server without `--port`. */
export const DEFAULT_PORT = 7501;

/** How long `listens` waits for a connection. */
const PROBE_TIMEOUT_MS = 1000;

/** The page of `/`: the picker of the hosts and their targets, or the target of its query. */
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>harness inspect</title>
<link rel="stylesheet" href="/assets/inspect.css">
</head>
<body class="inspect-page">
<main id="inspect"></main>
<script type="module">
import { mountPage } from "/assets/inspect.js";
mountPage(document.getElementById("inspect"));
</script>
</body>
</html>
`;

export type InspectServerOptions = {
	/** The addresses to listen on. Default `127.0.0.1`. */
	readonly hosts?: readonly string[] | undefined;
	/** The port of every address. 0 takes a free port, the same one on every address. Default 7501. */
	readonly port?: number | undefined;
	/** Whether a stream, an input and an abort start the host when none runs. Default true. */
	readonly start?: boolean | undefined;
};

export type InspectServer = {
	/** The URL of the page on each address, in the order of the addresses. */
	readonly urls: readonly string[];
	/** Stops listening and closes every connection, which closes the mirrors of the streams. */
	close(): Promise<void>;
};

/**
 * Serves the page and the inspect routes on each address of `hosts`, with one server for each. The first address takes
 * the port, and the others listen on the same one. When an address fails, the servers that listen close. It refuses a
 * host that is not an IP address or `localhost` before it listens.
 */
export async function startInspectServer(options: InspectServerOptions = {}): Promise<InspectServer> {
	const hosts = options.hosts ?? [LOOPBACK];

	for (const host of hosts) checkBindHost(host);
	const handler = createInspectHandler({ start: options.start });

	const { servers, port } = await listenAll(hosts, options.port ?? DEFAULT_PORT, (req, res) => {
		void serve(handler, req, res).catch(() => res.destroy());
	});

	return {
		urls: hosts.map((host) => serverUrl(host, port, "/")),
		close: () => closeAll(servers),
	};
}

/** The link of the page `slug` of `harness page` on `port` of `host`, with the target of its Send in its path. */
export function pageLink(host: string, port: number, slug: string, target: MirrorTarget): string {
	return serverUrl(host, port, pagePath(target, slug));
}

/** Whether a server accepts a TCP connection on `port` of `host` within 1 s. */
export function listens(host: string, port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect({ host, port, timeout: PROBE_TIMEOUT_MS });

		const done = (open: boolean) => {
			socket.destroy();
			resolve(open);
		};

		socket.once("connect", () => done(true));
		socket.once("timeout", () => done(false));
		socket.once("error", () => done(false));
	});
}

async function serve(handler: InspectHandler, req: IncomingMessage, res: ServerResponse): Promise<void> {
	const { pathname } = new URL(req.url ?? "/", "http://localhost");

	if (req.method === "GET" && pathname === "/") {
		res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" }).end(PAGE);

		return;
	}

	if (await handler(req, res)) return;
	res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found\n");
}

/**
 * The query of the page of `harness inspect` that opens `target`: the host alone for its agent, else with the target's
 * reference.
 */
export function pageQuery({ host, target }: MirrorTarget): string {
	const fields = target.kind === "agent" ? { host } : { host, ...targetRef(target) };

	return `?${new URLSearchParams(fields).toString()}`;
}
