/**
 * The pages that `harness page` copies to `$XDG_STATE_HOME/harness/pages/<slug>/`: the files of a page folder and their
 * copy, the path of a page for a target, the file and the target of such a path, and the script of the Send that the
 * handler puts in an HTML page, which also reads the asks of the parley of the page and writes the answers of the user.
 */
import { copyFileSync, type Dirent, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import type { MirrorTarget } from "../client/mirror.ts";
import { hasCode } from "../protocol/json-file.ts";
import { pageDir } from "../protocol/paths.ts";
import { AGENT_HANDLE, type TargetRef } from "../protocol/target.ts";

/** The routes of the pages start with this path. */
export const PAGES = "/pages/";

/** The content type of a page file, by its extension. */
const TYPES: ReadonlyMap<string, string> = new Map([
	[".html", "text/html; charset=utf-8"],
	[".svg", "image/svg+xml"],
	[".css", "text/css; charset=utf-8"],
	[".js", "text/javascript; charset=utf-8"],
	[".png", "image/png"],
	[".json", "application/json; charset=utf-8"],
]);

/** The content type of a page file with another extension. */
const OTHER_TYPE = "application/octet-stream";

/**
 * The names of the files of the page in `folder`: the regular files at its top level whose names do not start with `.`.
 * It skips folders and symbolic links. It throws `No index.html in <folder>` when they have no `index.html`, and when
 * `folder` does not exist or is not a folder.
 */
export function pageFiles(folder: string): string[] {
	const missing = `No index.html in ${folder}`;
	let entries: Dirent[];

	try {
		entries = readdirSync(folder, { withFileTypes: true });
	} catch (error) {
		if (hasCode(error, "ENOENT") || hasCode(error, "ENOTDIR")) throw new Error(missing);

		throw error;
	}

	const files = entries.flatMap((entry) => (entry.isFile() && !entry.name.startsWith(".") ? [entry.name] : []));

	if (!files.includes("index.html")) throw new Error(missing);

	return files;
}

/**
 * Replaces the copy at `dest` with the files of `folder` that `pageFiles` gives. It copies them to the temporary folder
 * `<dest>.<pid>.tmp`, then renames that folder to `dest`, so a copy that fails keeps the earlier copy, and `folder` can
 * be `dest`. A slug has no dot, so the temporary folder is never a page.
 */
export function writePage(dest: string, folder: string, files: readonly string[]): void {
	mkdirSync(dirname(dest), { recursive: true });
	const temporary = `${dest}.${process.pid}.tmp`;
	rmSync(temporary, { recursive: true, force: true });
	mkdirSync(temporary);

	try {
		for (const name of files) copyFileSync(join(folder, name), join(temporary, name));

		rmSync(dest, { recursive: true, force: true });
		renameSync(temporary, dest);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}

/**
 * The path of the page `slug` that opens `target`: `/pages/<host>/<slug>/` for the host agent,
 * `/pages/<host>/child/<handle>/<slug>/` for a child, and `/pages/<host>/conversation/<id>/<slug>/` for a conversation,
 * with each segment percent-encoded. `readPage` reads the same forms.
 */
export function pagePath({ host, target }: MirrorTarget, slug: string): string {
	const ref =
		target.kind === "agent" ? [] : target.kind === "child" ? ["child", target.handle] : ["conversation", target.id];

	return `${PAGES}${[host, ...ref, slug].map((segment) => `${encodeURIComponent(segment)}/`).join("")}`;
}

/**
 * A file of a page: its bytes, its content type, whether it is HTML, the slug of its page, and the host and the target
 * reference of its path, as the path gives them.
 */
export type PageFile = {
	readonly data: Buffer;
	readonly type: string;
	readonly html: boolean;
	readonly slug: string;
	readonly host: string;
	readonly ref: TargetRef;
};

/**
 * The file, the host and the target reference of `pathname`, a path that `pagePath` gives followed by the file:
 * `/pages/<host>/<slug>/<file>`, `/pages/<host>/child/<handle>/<slug>/<file>` or
 * `/pages/<host>/conversation/<id>/<slug>/<file>`, where an empty file is `index.html`. The number of segments selects
 * the form. It is undefined for another path, an empty host, handle, conversation or slug, a segment that does not
 * percent-decode, a slug that is not valid, a file name with `/`, `..` or a leading `.`, and a file that it cannot read.
 */
export async function readPage(pathname: string): Promise<PageFile | undefined> {
	if (!pathname.startsWith(PAGES)) return undefined;
	let parts: string[];

	try {
		parts = pathname.slice(PAGES.length).split("/").map(decodeURIComponent);
	} catch {
		return undefined;
	}

	if (parts.slice(0, -1).includes("")) return undefined;
	const found = pageParts(parts);

	if (found === undefined) return undefined;
	const { host, ref, slug, file } = found;
	const name = file || "index.html";

	if (name.includes("/") || name.includes("..") || name.startsWith(".")) return undefined;
	const type = TYPES.get(extname(name).toLowerCase()) ?? OTHER_TYPE;

	try {
		const data = await readFile(join(pageDir(slug), name));

		return { data, type, html: type === TYPES.get(".html"), slug, host, ref };
	} catch {
		return undefined;
	}
}

/** The host, the target reference, the slug and the file of the decoded segments of a page path, or undefined. */
function pageParts(parts: readonly string[]): { host: string; ref: TargetRef; slug: string; file: string } | undefined {
	if (parts.length === 3) {
		const [host = "", slug = "", file = ""] = parts;

		return { host, ref: { handle: AGENT_HANDLE }, slug, file };
	}

	if (parts.length !== 5) return undefined;
	const [host = "", kind, id = "", slug = "", file = ""] = parts;

	if (kind === "child") return { host, ref: { handle: id }, slug, file };

	return kind === "conversation" ? { host, ref: { conversation: id }, slug, file } : undefined;
}

/**
 * `html` with the script of the Send before its first `</head>`, or `html` as it is without one. The script defines three
 * calls of the page, for the target `fields` and the parley `parley`, the slug of the page:
 *
 * - `window.sendPrompt(text)` posts `{ ...fields, message: text }` to `/api/inspect/input`.
 * - `window.sendAnswers(answers)` posts `{ host, parley, answers }` to `/api/inspect/answers`, where each answer is
 *   `{ n, answer, label?, words? }`, and resolves to the write of the host, or to undefined when it is not sent.
 * - `window.readAsks()` gets `/api/inspect/asks` and resolves to `{ parley, asks }`, or rejects with the error.
 *
 * During a post, a dim layer covers the page and blocks clicks, and a line at the top shows `sending…`; other posts do
 * nothing. The line then shows `sent ✓` or `not sent: <reason>`. A post with the text, or the JSON text of the answers,
 * of the last success posts nothing, shows `already sent ✓`, and resolves as that success did.
 */
export function addSend(html: string, fields: Readonly<Record<string, string>>, parley: string): string {
	const head = html.search(/<\/head>/i);

	if (head === -1) return html;

	return `${html.slice(0, head)}${sendScript(fields, parley)}${html.slice(head)}`;
}

/** A value as a script literal, with `<` escaped, so that it cannot end the script. */
function literal(value: Readonly<Record<string, string>> | string): string {
	return JSON.stringify(value).replaceAll("<", "\\u003c");
}

/** The script of the Send. */
function sendScript(fields: Readonly<Record<string, string>>, parley: string): string {
	return `<script>
(() => {
	const fields = ${literal(fields)};
	const parley = ${literal(parley)};
	const call = async (path, init) => {
		try {
			const response = await fetch(path, init);
			const body = await response.json().catch(() => ({}));
			return response.ok ? { body } : { reason: body?.error ?? response.status };
		} catch (error) {
			return { reason: error.message };
		}
	};
	const post = (path, body) =>
		call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	let line;
	let layer;
	let lastSent;
	let lastValue;
	const send = async (key, path, body) => {
		if (layer !== undefined) return undefined;
		if (line === undefined) {
			line = document.createElement("div");
			line.className = "harness-send";
			line.style.cssText = "position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:2147483647;padding:4px 12px;font:16px monospace;background:#222;color:#eee";
			document.body.append(line);
		}
		if (key === lastSent) {
			line.textContent = "already sent \\u2713";
			return lastValue;
		}
		layer = document.createElement("div");
		layer.className = "harness-send-layer";
		layer.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.08);z-index:2147483646";
		document.body.append(layer);
		line.textContent = "sending\\u2026";
		const [result] = await Promise.all([post(path, body), new Promise((resolve) => setTimeout(resolve, 400))]);
		layer.remove();
		layer = undefined;
		if ("reason" in result) {
			line.textContent = \`not sent: \${result.reason}\`;
			return undefined;
		}
		line.textContent = "sent \\u2713";
		lastSent = key;
		lastValue = result.body;
		return lastValue;
	};
	window.sendPrompt = async (text) => {
		await send(\`prompt \${text}\`, "/api/inspect/input", { ...fields, message: text });
	};
	window.sendAnswers = (answers) => {
		const body = { host: fields.host, parley, answers };
		return send(\`answers \${JSON.stringify(answers)}\`, "/api/inspect/answers", body);
	};
	window.readAsks = async () => {
		const query = \`host=\${encodeURIComponent(fields.host)}&parley=\${encodeURIComponent(parley)}\`;
		const result = await call(\`/api/inspect/asks?\${query}\`);
		if ("reason" in result) throw new Error(String(result.reason));
		return result.body;
	};
})();
</script>
`;
}
