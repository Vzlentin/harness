/**
 * The standalone server of the inspect UI: the page at `/` and the routes of `createInspectHandler`, on one port of each
 * bound address.
 */
import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIPv4, isIPv6 } from "node:net";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { MirrorTarget } from "../client/mirror.ts";
import { targetRef } from "../protocol/target.ts";
import { createInspectHandler, type InspectHandler, isAddress } from "./handler.ts";

/** The address of the server without `--host` and `--tailscale`: this machine only. */
const LOOPBACK = "127.0.0.1";

/** The port of the server without `--port`. */
const DEFAULT_PORT = 7501;

/** The page of `/`: the picker of the projects and their targets, or the target of its query. */
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

/** The address of a listening server. */
const ListenAddress = Type.Object({ port: Type.Integer() });

export type InspectServerOptions = {
	/** The addresses to listen on. Default `127.0.0.1`. */
	readonly hosts?: readonly string[] | undefined;
	/** The port of every address. 0 takes a free port, the same one on every address. Default 7501. */
	readonly port?: number | undefined;
	/** Whether a stream, an input and an abort start the host of the project when none runs. Default true. */
	readonly start?: boolean | undefined;
};

export type InspectServer = {
	/** The URL of the page on each address, in the order of the addresses. */
	readonly urls: readonly string[];
	/** Stops listening and closes every connection, which closes the mirrors of the streams. */
	close(): Promise<void>;
};

/**
 * The addresses of the server: `127.0.0.1` by default, `host` alone with `host`, and `127.0.0.1` with the IPv4
 * addresses of `tailscale ip -4` with `tailscale`. It binds `0.0.0.0` only when `host` is `0.0.0.0`.
 */
export async function resolveBindHosts(options: {
	readonly host?: string | undefined;
	readonly tailscale?: boolean | undefined;
}): Promise<string[]> {
	const { host, tailscale = false } = options;

	if (host !== undefined && tailscale) throw new Error("Use --host or --tailscale, not both");

	if (host !== undefined) return [host];

	if (!tailscale) return [LOOPBACK];
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

/**
 * Serves the page and the inspect routes on each address of `hosts`, with one server for each. The first address takes
 * the port, and the others listen on the same one. When an address fails, the servers that listen close. It refuses a
 * host that is not an IP address or `localhost`, because the routes refuse its name in the `Host` header.
 */
export async function startInspectServer(options: InspectServerOptions = {}): Promise<InspectServer> {
	const hosts = options.hosts ?? [LOOPBACK];
	const name = hosts.find((host) => !isAddress(host));

	if (name !== undefined) throw new Error(`The host must be an IP address or localhost: ${name}`);
	const handler = createInspectHandler({ start: options.start });
	const servers: Server[] = [];
	let port = options.port ?? DEFAULT_PORT;

	try {
		for (const host of hosts) {
			const server = createServer((req, res) => void serve(handler, req, res).catch(() => res.destroy()));
			servers.push(server);
			port = await listen(server, host, port);
		}
	} catch (error) {
		await closeAll(servers);
		throw error;
	}

	return {
		urls: hosts.map((host) => `http://${isIPv6(host) ? `[${host}]` : host}:${port}/`),
		close: () => closeAll(servers),
	};
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

function closeAll(servers: readonly Server[]): Promise<void> {
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

/** The query of the page that opens `target`: the project alone for its agent, else with the target's reference. */
export function pageQuery({ project, target }: MirrorTarget): string {
	const fields = target.kind === "agent" ? { project } : { project, ...targetRef(target) };

	return `?${new URLSearchParams(fields)}`;
}
