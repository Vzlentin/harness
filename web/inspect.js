/**
 * The browser side of harness inspect, with no dependencies. `mountInspect` draws one conversation of a harness host,
 * live, with a form that sends to it. `mountPage` is the page of `harness inspect`: the target of its query, or the
 * picker of the projects and their targets. Both need the routes of `createInspectHandler` on the same origin.
 *
 * Every text goes into the page with `textContent`: the transcript is the output of agents, so it is never HTML.
 */

const API = "/api/inspect";

/** The keys that name a target, in the query of the page and in the routes. */
const TARGET_KEYS = ["project", "handle", "conversation"];

/** The block of diagnostics that pi-durable adds to a tool result for the model, such as `[error] Command exited`. */
const DIAGNOSTICS = /^<harness>\n([\s\S]*)\n<\/harness>$/;

/** The key of the streamed answer in the drawn parts, and the owner of its calls. */
const STREAMING = "streaming";

/** The labels of the passive entries that are not Pi's own. */
const NOTE_LABELS = new Map([
	["harness.note", "note"],
	["harness.catchup", "catch-up"],
]);

/** A new element with the class `className`, and the text `text` when it is given. */
function el(tag, className, text) {
	const node = document.createElement(tag);

	if (className) node.className = className;

	if (text !== undefined) node.textContent = text;

	return node;
}

/** The target in `values`: its project, and the handle or the conversation, without the keys that are empty. */
function targetOf(values) {
	const target = {};

	for (const key of TARGET_KEYS) {
		const value = values.get(key);

		if (value) target[key] = value;
	}

	return target;
}

function targetQuery(target) {
	const query = new URLSearchParams();

	for (const key of TARGET_KEYS) if (target[key]) query.set(key, target[key]);

	return query;
}

function errorText(error) {
	return error instanceof Error ? error.message : String(error);
}

/** The JSON of a route, as `{ ok: true, value }`, or `{ ok: false, error }` with the error of the route. */
async function call(path, init) {
	try {
		const response = await fetch(`${API}/${path}`, init);
		const value = await response.json();

		return response.ok ? { ok: true, value } : { ok: false, error: value.error ?? response.statusText };
	} catch (error) {
		return { ok: false, error: errorText(error) };
	}
}

function post(route, body) {
	return call(route, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

/** The text of the content of a message: a string, or text blocks, with `[image]` for an image. */
function contentText(content) {
	if (!Array.isArray(content)) return content ?? "";

	return content
		.map((block) => (block.type === "text" ? block.text : block.type === "image" ? "[image]" : ""))
		.join("");
}

/** The text of a tool result, with the block of its diagnostics as plain lines, as in Pi. */
function resultText(result) {
	if (!Array.isArray(result.content)) return contentText(result.content);

	return result.content
		.map((block) => {
			const match = block.type === "text" ? DIAGNOSTICS.exec(block.text) : null;

			if (!match) return contentText([block]);
			const lines = match[1].split("\n").map((line) => line.replace(/^\[(error|warning|info)\] /, ""));

			return `\n${lines.join("\n")}`;
		})
		.join("");
}

/** A token count as Pi's footer gives it: `999`, `1.2k`, `12k`, `1.2M`. */
function tokens(count) {
	if (count < 1000) return String(count);

	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;

	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;

	return `${(count / 1_000_000).toFixed(1)}M`;
}

/** The usage of the footer: the sums of the conversation, then the context of the last answer. */
function usageLine(summary) {
	const totals = summary.usageTotals;

	const parts = [
		totals.input ? `↑${tokens(totals.input)}` : "",
		totals.output ? `↓${tokens(totals.output)}` : "",
		totals.cacheRead ? `R${tokens(totals.cacheRead)}` : "",
		totals.cacheWrite ? `W${tokens(totals.cacheWrite)}` : "",
		totals.cost ? `$${totals.cost.toFixed(3)}` : "",
	];

	const last = summary.lastAnswerUsage;

	if (last) {
		const context = last.totalTokens || last.input + last.output + last.cacheRead + last.cacheWrite;
		parts.push(`ctx ${tokens(context)}`);
	}

	return parts.filter((part) => part).join(" ");
}

function firstLine(text) {
	return text.split("\n", 1)[0] ?? "";
}

/** The model of an agent, as the header and the picker show it: `<provider>/<model> • <thinking>`, and its kind. */
function modelText(child) {
	return [`${child.provider}/${child.model}`, child.thinking, child.kind].filter((part) => part).join(" • ");
}

/** The key of the call `callId` of the answer of `owner`: the ID of its entry, or `STREAMING` for the streamed answer. */
function callKey(owner, callId) {
	return `${owner}:${callId}`;
}

/**
 * `calls`, the result and the slot of each call of `entries` and of the `streaming` answer, as `{ result?, slot? }` by
 * the key of the call, and `paired`, the IDs of the result entries that the card of a call shows. Providers can use a
 * call ID again in a later turn: a result goes to the newest call with its ID before it, as in Pi, and a slot of
 * `tools` to the newest call with its ID.
 */
function pairCalls(entries, streaming, tools) {
	const newest = new Map();
	const calls = new Map();
	const paired = new Set();

	const addCalls = (owner, message) => {
		for (const block of message.content ?? []) {
			if (block.type !== "toolCall") continue;
			const key = callKey(owner, block.id);
			newest.set(block.id, key);
			calls.set(key, {});
		}
	};

	for (const entry of entries) {
		const message = entry.model?.[0];

		if (entry.kind === "pi.assistant" && message?.role === "assistant") addCalls(entry.id, message);

		if (entry.kind === "pi.tool-result" && message?.role === "toolResult") {
			const key = newest.get(message.toolCallId);

			if (key === undefined) continue;
			calls.get(key).result = message;
			paired.add(entry.id);
		}
	}

	// The streamed answer comes after every entry, so no result is its own yet.
	if (streaming) addCalls(STREAMING, streaming);

	for (const slot of tools) {
		const key = newest.get(slot.callId);

		if (key !== undefined) calls.get(key).slot = slot;
	}

	return { calls, paired };
}

/**
 * Draws the conversation of `target`, `{ project, handle?, conversation? }`, in `container`, and follows it until
 * `close()`. Without `handle` and `conversation`, the target is the project agent. `onTitle` gets the title of the
 * agent each time that it changes. Esc in the view calls `interrupt()`, which stops the turn while the agent works.
 */
export function mountInspect(container, target, { onTitle } = {}) {
	const root = el("div", "inspect");
	// A click in the transcript gives the focus to the view, so that Esc reaches it on a page that mounts the view.
	root.tabIndex = -1;
	const header = el("header", "inspect-header");
	const title = el("span", "inspect-title");
	const model = el("span", "inspect-model");
	const state = el("span", "badge");
	const connection = el("span", "inspect-connection");
	header.append(title, model, state, connection);

	const transcript = el("div", "inspect-transcript");
	const footer = el("footer", "inspect-footer");
	const work = el("div", "inspect-status");
	const queue = el("div", "inspect-queued");
	const usage = el("div", "inspect-usage");
	const notice = el("div", "inspect-notice");
	const form = el("form", "inspect-form");
	const input = el("textarea");
	input.rows = 2;
	const buttons = el("div", "inspect-buttons");
	const send = el("button", "", "Send");
	const steer = el("button", "", "Steer");
	const followUp = el("button", "", "Follow-up");
	const stop = el("button", "stop", "Stop");
	send.type = "submit";
	steer.type = "submit";
	followUp.type = "button";
	stop.type = "button";
	buttons.append(send, steer, followUp, stop);
	form.append(input, buttons);
	footer.append(work, queue, usage, notice, form);
	root.append(header, transcript, footer);
	container.replaceChildren(root);

	const isConversation = Boolean(target.conversation);
	/** The keys of the `<details>` that the reader opened, so that a new draw keeps them open. */
	const opened = new Set();
	/** The drawn node of each transcript part, with the JSON it was drawn from. */
	let drawn = new Map();
	let frame;
	let scheduled = false;
	let busy = false;
	let sending = false;

	function details(key, label, className, text, open = false) {
		const node = el("details", className);
		node.append(el("summary", "", label), el("pre", "", text));
		node.open = open || opened.has(key);
		node.addEventListener("toggle", () => {
			if (node.open) opened.add(key);
			else opened.delete(key);
		});

		return node;
	}

	/** The card of a tool call, with its result, or its output while it runs. */
	function toolNode(key, toolCall, result, slot, ran) {
		const args = JSON.stringify(toolCall.arguments ?? {}, null, 2);
		const node = el("div", "tool");
		const head = el("div", "tool-head");
		head.append(el("span", "tool-name", toolCall.name), el("span", "tool-args", firstLine(args.replace(/\s+/g, " "))));
		node.append(head, details(`${key}:args`, "arguments", "tool-arguments", args));

		if (result) {
			node.classList.add(result.isError ? "failed" : "done");
			node.append(details(`${key}:result`, result.isError ? "error" : "result", "tool-result", resultText(result)));
		} else if (slot?.status === "running") {
			node.classList.add("running");
			node.append(details(`${key}:output`, "running", "tool-result", slot.output ?? "", true));
		} else if (!ran) {
			node.classList.add("failed");
			node.append(el("div", "tool-note", "Not run: the answer was interrupted."));
		}

		return node;
	}

	/** An answer of `owner`, as `callKey` names it: its thinking, its text and its tool calls, in order. */
	function assistantNode(message, owner, calls) {
		const streaming = owner === STREAMING;
		const key = `a${message.timestamp}`;
		const node = el("div", streaming ? "message assistant streaming" : "message assistant");
		const ran = streaming || message.stopReason === "toolUse";

		(message.content ?? []).forEach((block, index) => {
			if (block.type === "thinking" && block.thinking) {
				node.append(details(`${key}:${index}`, "thinking", "thinking", block.thinking));
			} else if (block.type === "text" && block.text) {
				node.append(el("div", "text", block.text));
			} else if (block.type === "toolCall") {
				const call = calls.get(callKey(owner, block.id));
				node.append(toolNode(`${key}:${block.id}`, block, call.result, call.slot, ran));
			}
		});

		if (message.stopReason === "error") node.append(el("div", "error-line", message.errorMessage || "Error"));

		if (message.stopReason === "aborted") node.append(el("div", "muted-line", "Aborted"));

		return node;
	}

	/** The node of one entry, or undefined for an entry that the transcript does not show. */
	function entryNode(entry, { calls, paired }) {
		const message = entry.model?.[0];

		if (entry.kind === "pi.user" && message?.role === "user") {
			return el("div", "message user", contentText(message.content));
		}

		if (entry.kind === "pi.assistant" && message?.role === "assistant") {
			return assistantNode(message, entry.id, calls);
		}

		if (entry.kind === "pi.tool-result" && message?.role === "toolResult") {
			// The card of the call shows the result, when the call is in the window.
			if (paired.has(entry.id)) return undefined;

			const call = { name: message.toolName, arguments: {} };

			return toolNode(`r${entry.id}`, call, message, undefined, true);
		}

		if (entry.kind === "pi.compaction") {
			const node = el("div", "marker", "[compaction]");

			if (message?.role === "user") node.append(details(`c${entry.id}`, "summary", "", contentText(message.content)));

			return node;
		}

		if (entry.kind === "pi.reset") return el("div", "marker", "[new context]");

		if (message?.role === "user") {
			const node = el("div", "message note");
			node.append(
				el("span", "note-label", NOTE_LABELS.get(entry.kind) ?? entry.kind),
				el("div", "text", contentText(message.content)),
			);

			return node;
		}

		return undefined;
	}

	/** The node of `key` from the last draw when `parts` did not change, else a new one from `build`. */
	function reuse(next, key, parts, build) {
		const json = JSON.stringify(parts);
		const old = drawn.get(key);
		const node = old?.json === json ? old.node : build();

		if (node) next.set(key, { json, node });

		return node;
	}

	function drawTranscript(view) {
		const atEnd = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 48;
		const live = view.docs["pi.live"] ?? {};
		const streamed = live.generation?.message;
		const answered = view.entries.some((entry) => entry.model?.[0]?.timestamp === streamed?.timestamp);
		const streaming = answered ? undefined : streamed;
		const pairs = pairCalls(view.entries, streaming, live.tools ?? []);

		/** The results and slots of the calls of the answer of `owner`, which its node shows. */
		const related = (owner, message) =>
			(message.content ?? [])
				.filter((block) => block.type === "toolCall")
				.map((block) => pairs.calls.get(callKey(owner, block.id)));

		const next = new Map();
		const nodes = [];

		for (const entry of view.entries) {
			const message = entry.model?.[0];
			const shown = message?.role === "assistant" ? related(entry.id, message) : pairs.paired.has(entry.id);
			const node = reuse(next, entry.id, [entry, shown], () => entryNode(entry, pairs));

			if (node) nodes.push(node);
		}

		if (streaming) {
			const parts = [streaming, related(STREAMING, streaming)];
			const build = () => assistantNode(streaming, STREAMING, pairs.calls);
			nodes.push(reuse(next, STREAMING, parts, build));
		}

		drawn = next;
		transcript.replaceChildren(...nodes);

		if (atEnd) transcript.scrollTop = transcript.scrollHeight;
	}

	function drawFooter(child, summary, open) {
		busy = open && child?.state === "busy";
		work.textContent = summary?.statusText ?? "";

		queue.replaceChildren(
			...(summary?.queued ?? []).map((item) =>
				el("div", "", `${item.mode === "steer" ? "Steer" : "Follow-up"}: ${firstLine(item.text)}`),
			),
		);

		usage.textContent = summary ? usageLine(summary) : "";
		// A conversation of the children library takes input only while it works, always as a steer.
		const takes = child !== undefined && child.state !== "closed" && (busy || !isConversation);
		input.disabled = !takes;
		input.placeholder = takes ? "Message" : isConversation ? "A conversation takes input only while it works" : "";
		send.hidden = busy || isConversation;
		steer.hidden = !busy;
		followUp.hidden = !busy || isConversation;
		stop.hidden = !busy;

		for (const button of [send, steer, followUp]) button.disabled = !takes || sending;
	}

	function draw() {
		scheduled = false;
		const { status, child, view, summary } = frame;

		if (title.textContent !== frame.title) {
			title.textContent = frame.title;
			onTitle?.(frame.title);
		}

		model.textContent = child ? modelText(child) : "";
		state.textContent = child?.state ?? "";
		state.className = `badge ${child?.state ?? ""}`;
		connection.textContent = status.kind === "failed" ? `failed: ${status.reason}` : status.kind;
		connection.className = `inspect-connection ${status.kind}`;

		if (view) drawTranscript(view);
		drawFooter(child, summary, status.kind === "open");
	}

	function schedule() {
		if (scheduled || frame === undefined) return;
		scheduled = true;
		requestAnimationFrame(draw);
	}

	async function submit(asFollowUp) {
		const message = input.value;

		if (!message.trim() || sending) return;
		sending = true;
		notice.textContent = "";
		schedule();
		const reply = await post("input", { ...target, message, followUp: asFollowUp });
		sending = false;

		if (reply.ok) {
			if (input.value === message) input.value = "";
		} else {
			notice.textContent = `not sent: ${reply.error}`;
		}

		schedule();
	}

	async function abort() {
		const reply = await post("abort", target);

		if (!reply.ok) notice.textContent = `not stopped: ${reply.error}`;
	}

	/** Stops the turn while the agent works, as Esc does in Pi, and tells whether it did. */
	function interrupt() {
		if (!busy) return false;
		void abort();

		return true;
	}

	form.addEventListener("submit", (event) => {
		event.preventDefault();
		void submit(false);
	});
	followUp.addEventListener("click", () => void submit(true));
	stop.addEventListener("click", () => void abort());

	input.addEventListener("keydown", (event) => {
		if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
		event.preventDefault();
		void submit(event.altKey && busy && !isConversation);
	});

	// Only the view listens, so the page around it keeps its keys.
	root.addEventListener("keydown", (event) => {
		if (event.key === "Escape" && interrupt()) event.preventDefault();
	});

	const streamPath = `stream?${targetQuery(target)}`;
	const events = new EventSource(`${API}/${streamPath}`);

	events.addEventListener("message", (event) => {
		frame = JSON.parse(event.data);

		// The stream ends after a failed frame: a new one would only fail again.
		if (frame.status.kind === "failed") events.close();
		schedule();
	});

	events.addEventListener("error", () => {
		if (events.readyState === EventSource.CONNECTING) {
			connection.textContent = "the inspect server is not reachable";

			return;
		}

		// EventSource gives up after a reply that is not a stream, such as the 400 of an unknown project: show its error.
		connection.className = "inspect-connection failed";
		void call(streamPath).then((reply) => {
			connection.textContent = `failed: ${reply.ok ? "the stream ended" : reply.error}`;
		});
	});

	return {
		interrupt,
		close() {
			events.close();
			root.remove();
		},
	};
}

/** The list of the targets of `project` in `list`: the project agent and the children, when the host runs. */
async function listTargets(project, list) {
	const reply = await call(`targets?${targetQuery({ project })}`);

	if (!reply.ok) {
		list.append(el("li", "error-line", reply.error));

		return;
	}

	const { running, targets } = reply.value;

	if (!running) {
		const item = el("li");
		const link = el("a", "", "agent");
		link.href = `?${targetQuery({ project })}`;
		item.append(link, el("span", "muted-line", " the host is not running: opening it starts the host"));
		list.append(item);

		return;
	}

	if (targets.length === 0) list.append(el("li", "muted-line", "the host runs, with no target to show"));

	for (const child of targets) {
		const item = el("li");
		const link = el("a", "", child.title);
		link.href = `?${targetQuery({ project, handle: child.handle })}`;
		item.append(link, el("span", `badge ${child.state}`, ` ${child.state}`));
		item.append(el("span", "inspect-model", ` ${modelText(child)}`));
		list.append(item);
	}
}

/** The picker: each project, with its directory, and the list of its targets. */
async function listProjects(root) {
	const reply = await call("projects");

	if (!reply.ok) {
		root.append(el("p", "error-line", reply.error));

		return;
	}

	for (const project of reply.value.projects) {
		const section = el("section", "inspect-project");
		const head = el("h2", "", project.name);

		if (project.dir) head.append(el("span", "muted-line", ` ${project.dir}`));
		const list = el("ul");
		section.append(head, list);
		root.append(section);
		void listTargets(project.name, list);
	}
}

/**
 * The page of `harness inspect` in `container`: the target of the query of the page, `project` with `handle` or
 * `conversation`, or the picker of the projects and their targets without `project`.
 */
export function mountPage(container) {
	const target = targetOf(new URLSearchParams(location.search));

	if (target.project) {
		const back = el("a", "inspect-back", "← projects");
		back.href = location.pathname;
		const body = el("div", "inspect-body");
		container.replaceChildren(back, body);

		const view = mountInspect(body, target, {
			onTitle: (title) => {
				document.title = `${title} · harness inspect`;
			},
		});

		// The page is the view, so Esc works wherever the focus is, also on the body after a clicked button is disabled.
		const onKey = (event) => {
			if (event.key === "Escape" && !event.defaultPrevented) view.interrupt();
		};

		document.addEventListener("keydown", onKey);

		return {
			close() {
				document.removeEventListener("keydown", onKey);
				view.close();
			},
		};
	}

	const root = el("div", "inspect-picker");
	root.append(el("h1", "", "harness inspect"));
	container.replaceChildren(root);
	void listProjects(root);

	return {
		close() {
			root.remove();
		},
	};
}
