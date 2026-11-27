/**
 * The folders that the host web server serves for its callers: the `serve` request that records a folder, the record
 * of a folder by its caller and its name, the read of a file in a folder, and the Send script of its HTML files.
 */
import { realpathSync, statSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, join, sep } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Conversation, defineDoc, type Harness } from "@earendil-works/pi-durable";
import { boundedReplay } from "../protocol/checkpoint.ts";
import { contentType, HTML_TYPE } from "../protocol/http.ts";
import { SEND_FEEDBACK, scriptLiteral, withScript } from "../protocol/send-script.ts";
import { deliveryTarget } from "./deliveries.ts";

const context = BACKGROUND_CONTEXT;

/** A folder that the host serves: its caller, its name in the links, and its real path. */
export type ServedFolder = { readonly caller: string; readonly name: string; readonly dir: string };

/** The served folders. A caller has one folder for each name. */
const Folders = defineDoc<{ folders: ServedFolder[] }>({
	kind: "harness.folders",
	version: 1,
	scope: "session",
	checkpointWhen: boundedReplay,
	initial: () => ({ folders: [] }),
});

/**
 * Records the folder `dir` of `caller` and gives its record. Its name is the base name of its real path, and it replaces
 * the folder of `caller` with that name. It throws `UnknownDeliveryTarget` when `caller` is not a target of
 * `deliveryTarget`, so that the Send of its pages can reach it, and when `dir` is not a folder or its name starts with `.`.
 */
export async function serveFolder(
	host: { readonly harness: Harness; readonly root: Conversation },
	caller: string,
	dir: string,
): Promise<ServedFolder> {
	const real = realFolder(dir);
	const name = basename(real);

	if (name === "" || name.startsWith(".")) throw new Error(`The folder name must not be empty or start with .: ${dir}`);
	const folder = { caller, name, dir: real };

	await host.harness.commit(async (tx) => {
		await deliveryTarget(tx, host.root.id, caller);
		const doc = await tx.doc(Folders);
		doc.folders = [...doc.folders.filter((each) => each.caller !== caller || each.name !== name), folder];
	}, context);

	return folder;
}

/** The real path of the folder `dir`. It throws when `dir` does not exist or is not a folder. */
function realFolder(dir: string): string {
	let real: string;

	try {
		real = realpathSync(dir);
	} catch {
		throw new Error(`No such folder: ${dir}`);
	}

	if (!statSync(real).isDirectory()) throw new Error(`Not a folder: ${dir}`);

	return real;
}

/** The path of the folder `name` of `caller` on the web server: `/<caller>/<name>/`, with each part percent-encoded. */
export function folderPath(caller: string, name: string): string {
	return `/${encodeURIComponent(caller)}/${encodeURIComponent(name)}/`;
}

/** The folder `name` of `caller`, if the host serves it. */
export async function findFolder(
	harness: Pick<Harness, "snapshot">,
	caller: string,
	name: string,
): Promise<ServedFolder | undefined> {
	const doc = await harness.snapshot(Folders, context);

	return doc?.folders.find((each) => each.caller === caller && each.name === name);
}

/** A file of a served folder: its bytes, its content type, and whether it is HTML. */
export type FolderFile = { readonly data: Buffer; readonly type: string; readonly html: boolean };

/**
 * The file at the decoded path segments `segments` in `folder`, where an empty last segment is `index.html`. It is
 * undefined for an empty segment before the last, a segment `.`, `..`, with `/` or a NUL, or that starts with `.`, and for
 * a file that is not a regular file, or whose real path is not in the real path of the folder, such as through a
 * symbolic link that leaves it. The file is read at each call, so a change shows at once.
 */
export async function readFolderFile(
	folder: ServedFolder,
	segments: readonly string[],
): Promise<FolderFile | undefined> {
	const names = segments.at(-1) === "" ? [...segments.slice(0, -1), "index.html"] : segments;

	if (names.length === 0 || !names.every(validSegment)) return undefined;

	try {
		const root = await realpath(folder.dir);
		const file = await realpath(join(root, ...names));

		if (!file.startsWith(root + sep) || !(await stat(file)).isFile()) return undefined;
		const type = contentType(extname(file));

		return { data: await readFile(file), type, html: type === HTML_TYPE };
	} catch {
		return undefined;
	}
}

/** Whether `segment` names an entry of a folder that is not hidden and does not leave the folder. */
function validSegment(segment: string): boolean {
	return segment !== "" && !segment.startsWith(".") && !segment.includes("/") && !segment.includes("\0");
}

/**
 * `html` with the Send script of the folder at `path`, such as `/<caller>/<name>/`, before its first `</head>`, or
 * `html` as it is without one. The script defines `window.sendPrompt(text)`, which posts `{ message: text, key }` to
 * `path`, with one random key for each distinct text for the life of the page, so the host takes a text once. During
 * the post, a dim layer covers the page and blocks clicks, and a line at the top shows `sending…`; other posts do
 * nothing. The line then shows `sent ✓`, `already sent ✓` when the host had the key, or `not sent: <reason>`.
 */
export function addFolderSend(html: string, path: string): string {
	return withScript(html, folderSendScript(path));
}

/**
 * The Send script of a folder. The keys come from `crypto.getRandomValues`, since a tailnet `http://` address is not a
 * secure context, where `crypto.randomUUID` is missing.
 */
function folderSendScript(path: string): string {
	return `<script>
(() => {
	const path = ${scriptLiteral(path)};
${SEND_FEEDBACK}	const keys = new Map();
	const newKey = () =>
		Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
	window.sendPrompt = async (text) => {
		if (busy()) return;
		if (!keys.has(text)) keys.set(text, newKey());
		const result = await posting(path, { message: text, key: keys.get(text) });
		if ("reason" in result) return;
		say(result.body.repeated ? "already sent \\u2713" : "sent \\u2713");
	};
})();
</script>
`;
}
