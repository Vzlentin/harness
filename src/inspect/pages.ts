/**
 * The pages that `harness page` copies to `$XDG_STATE_HOME/harness/pages/<slug>/`: the files of a page folder and their
 * copy, the file of a page path, and the script of the Send that the handler puts in an HTML page.
 */
import { copyFileSync, type Dirent, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { hasCode } from "../protocol/json-file.ts";
import { pageDir } from "../protocol/paths.ts";

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

/** A file of a page: its bytes, its content type, and whether it is HTML. */
export type PageFile = { readonly data: Buffer; readonly type: string; readonly html: boolean };

/**
 * The file of `pathname`, `/pages/<slug>/<file>`, where an empty file is `index.html`. It is undefined for a path with
 * more or fewer parts, a slug that is not valid, a file name with `/`, `..` or a leading `.`, and a file that it cannot
 * read.
 */
export async function readPage(pathname: string): Promise<PageFile | undefined> {
	if (!pathname.startsWith(PAGES)) return undefined;
	const parts = pathname.slice(PAGES.length).split("/");

	if (parts.length !== 2) return undefined;
	const [slug = "", file = ""] = parts;
	let name: string;

	try {
		name = decodeURIComponent(file || "index.html");
	} catch {
		return undefined;
	}

	if (name.includes("/") || name.includes("..") || name.startsWith(".")) return undefined;
	const type = TYPES.get(extname(name).toLowerCase()) ?? OTHER_TYPE;

	try {
		return { data: await readFile(join(pageDir(slug), name)), type, html: type === TYPES.get(".html") };
	} catch {
		return undefined;
	}
}

/**
 * `html` with the script of the Send before its first `</head>`, or `html` as it is without one. The script defines
 * `window.sendPrompt(text)`, which posts `{ ...fields, message: text }` to `/api/inspect/input`, and shows `sent` or
 * `not sent: <reason>` on one line of the page.
 */
export function addSend(html: string, fields: Readonly<Record<string, string>>): string {
	const head = html.search(/<\/head>/i);

	if (head === -1) return html;

	return `${html.slice(0, head)}${sendScript(fields)}${html.slice(head)}`;
}

/** The script of the Send. `<` in the fields is escaped, so a field cannot end the script. */
function sendScript(fields: Readonly<Record<string, string>>): string {
	return `<script>
(() => {
	const fields = ${JSON.stringify(fields).replaceAll("<", "\\u003c")};
	let line;
	window.sendPrompt = async (text) => {
		if (line === undefined) {
			line = document.createElement("div");
			line.className = "harness-send";
			line.style.cssText = "position:fixed;top:8px;right:8px;z-index:2147483647;padding:2px 8px;font:12px monospace;background:#222;color:#eee";
			document.body.append(line);
		}
		let reason;
		try {
			const response = await fetch("/api/inspect/input", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ ...fields, message: text }),
			});
			const body = await response.json().catch(() => ({}));
			if (!response.ok) reason = body?.error ?? response.status;
		} catch (error) {
			reason = error.message;
		}
		line.textContent = reason === undefined ? "sent" : \`not sent: \${reason}\`;
	};
})();
</script>
`;
}
