/**
 * The part of the Send script that the served HTML pages share: the posts to the server, and the feedback of a post,
 * with a layer that blocks clicks and a line at the top that says what happened. Each server puts it in a script with
 * its own calls of the page on top.
 */

/**
 * The script text that defines, in the scope of the script that holds it:
 *
 * - `call(path, init)`, which fetches `path` and resolves to `{ body }`, or to `{ reason }` for an error.
 * - `post(path, body)`, which posts `body` as JSON to `path`, as `call` does.
 * - `say(text)`, which shows `text` on the line at the top of the page.
 * - `busy()`, which is true while a post of `posting` runs.
 * - `posting(path, body)`, which posts behind a dim layer that blocks clicks, with `sending…` on the line, for at least
 *   400 ms. It resolves to the result of `post`, after it shows `not sent: <reason>` for an error.
 */
export const SEND_FEEDBACK = `	const call = async (path, init) => {
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
	const say = (text) => {
		if (line === undefined) {
			line = document.createElement("div");
			line.className = "harness-send";
			line.style.cssText = "position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:2147483647;padding:4px 12px;font:16px monospace;background:#222;color:#eee";
			document.body.append(line);
		}
		line.textContent = text;
	};
	const busy = () => layer !== undefined;
	const posting = async (path, body) => {
		layer = document.createElement("div");
		layer.className = "harness-send-layer";
		layer.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.08);z-index:2147483646";
		document.body.append(layer);
		say("sending\\u2026");
		const [result] = await Promise.all([post(path, body), new Promise((resolve) => setTimeout(resolve, 400))]);
		layer.remove();
		layer = undefined;
		if ("reason" in result) say(\`not sent: \${result.reason}\`);
		return result;
	};
`;

/** A value as a script literal, with `<` escaped, so that it cannot end the script. */
export function scriptLiteral(value: Readonly<Record<string, string>> | string): string {
	return JSON.stringify(value).replaceAll("<", "\\u003c");
}

/** `html` with `script` before its first `</head>`, or `html` as it is without one. */
export function withScript(html: string, script: string): string {
	const head = html.search(/<\/head>/i);

	if (head === -1) return html;

	return `${html.slice(0, head)}${script}${html.slice(head)}`;
}
