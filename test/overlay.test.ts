import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import * as durable from "@earendil-works/pi-durable";
import { Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createChildren, type Owner, type Place } from "../src/children.ts";
import { request } from "../src/client.ts";
import { ChildContext } from "../src/context.ts";
import { setEntry } from "../src/entries.ts";
import type { Host } from "../src/host.ts";
import { overlayDoc } from "../src/overlay.ts";
import { models, requests, root, setUp, startHost, tearDown } from "./helpers.ts";

const library = createChildren(durable);
const faux = { provider: "faux", model: "faux-1" } as const;

let harness: Harness;
let place: Place;
let owner: Owner;
let project: string;
let host: Host | undefined;

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "tasks", "ask.ts");

/** The overlay that the host tests give a fixture child, by path relative to the project. */
const hostOverlay = { "AGENTS.md": "Host overlay rules.", "prompts/p.md": "Overlay prompt.", "prompts/gone.md": null };

/** Starts a fixture task of `key` whose child gets `overlay`, waits until it ends, and gives the child's conversation ID. */
async function fixtureChild(key: string, overlay?: typeof hostOverlay): Promise<string> {
	const idFile = join(root, `${key}.ids.json`);
	const input = { cwd: project, prompt: `Fixture ${key}`, limit: 3, idFile };

	const reply = await request(
		{ type: "start", kind: "fixture.ask", key, input: overlay === undefined ? input : { ...input, overlay } },
		{ start: false },
	);

	if (reply === undefined) throw new Error("no host");
	await request({ type: "wait-task", key }, { start: false });

	return JSON.parse(await readFile(idFile, "utf8")).child;
}

/** Spawns a child of `caller` through the host socket with `prompt`, and gives its answer. */
async function spawnUnder(caller: string, prompt: string): Promise<string> {
	const spawned = await request(
		{
			type: "spawn",
			requestId: `under:${prompt}`,
			caller,
			notify: false,
			provider: "faux",
			model: "faux-1",
			callerThinking: "medium",
			cwd: project,
			prompt,
		},
		{ start: false },
	);

	if (spawned === undefined) throw new Error("no host");
	const waited = await request({ type: "wait", handle: spawned.handle, timeout: 20 }, { start: false });

	return waited?.answer ?? "";
}

const skill = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\nDo it.\n`;

/** The files of the project on disk, by path relative to the project. */
const disk = {
	"AGENTS.md": "Disk rules.",
	"prompts/p.md": "Disk prompt.",
	"prompts/gone.md": "Disk gone.",
	".pi/skills/a/SKILL.md": skill("a", "Disk a."),
	".pi/skills/b/SKILL.md": skill("b", "Disk b."),
	".pi/skills/c/SKILL.md": skill("c", "Disk c."),
} satisfies Record<string, string>;

beforeAll(async () => {
	await setUp();
	project = join(root, "project");

	for (const [path, content] of Object.entries(disk)) {
		await mkdir(dirname(join(project, path)), { recursive: true });
		await writeFile(join(project, path), content);
	}

	new ProjectTrustStore(join(root, "agent")).set(project, true);

	const registry = durable.createRegistry();
	registry.install(ChildContext);
	registry.install(library.extension);
	registry.install(library.answerExtension);

	harness = await Harness.open(
		await openNodeSqliteStorage(join(root, "overlay.sqlite")),
		{
			models,
			registry,
			settings: { extensions: [ChildContext] },
			env: ({ cwd }) => (cwd === undefined ? undefined : new NodeExecutionEnv({ cwd })),
		},
		context,
	);

	harness.resume();
	place = { store: harness, models, registry: registry.snapshot() };
	owner = { kind: "detached", root: await harness.root(context) };
	setEntry("fixture", FIXTURE);
	host = await startHost();
});

afterAll(async () => {
	await host?.close();
	await harness.close(context);
	await tearDown();
});

describe("overlay", { timeout: 30_000 }, () => {
	it("gives a child the overlay in place of the disk, in its instructions, its skills and its read tool", async () => {
		const overlay = {
			"AGENTS.md": "Overlay rules.",
			".pi/skills/a/SKILL.md": skill("a", "Overlay a."),
			".pi/skills/b/SKILL.md": null,
			".pi/skills/d/SKILL.md": skill("d", "Overlay d."),
			"prompts/p.md": "Overlay prompt.",
			"prompts/gone.md": null,
		};

		const child = await library.open(
			place,
			owner,
			"o:overlay",
			{ root: "test", ...faux, cwd: project, overlay },
			context,
		);

		await child.ask({ type: "input", content: "Overlay context", requestId: "r1" }, context);
		const system = requests.get("Overlay context")?.system;
		expect(system).toContain(
			`<project_instructions path="${join(project, "AGENTS.md")}">\nOverlay rules.\n</project_instructions>`,
		);
		expect(system).not.toContain("Disk rules.");
		expect(system).toContain("<description>Overlay a.</description>");
		expect(system).not.toContain("Disk a.");
		expect(system).not.toContain("<name>b</name>");
		expect(system).toContain("<description>Disk c.</description>");
		expect(system).toContain(`<location>${join(project, ".pi", "skills", "d", "SKILL.md")}</location>`);

		const prompt = await child.ask({ type: "input", content: "Read prompts/p.md", requestId: "r2" }, context);
		expect(prompt).toMatchObject({ status: "ok", text: expect.stringContaining("Overlay prompt.") });
		const gone = await child.ask({ type: "input", content: "Read prompts/gone.md", requestId: "r3" }, context);
		expect(gone).toMatchObject({ status: "ok", text: expect.stringContaining("ENOENT") });
		const added = await child.ask({ type: "input", content: "Read .pi/skills/d/SKILL.md", requestId: "r4" }, context);
		expect(added).toMatchObject({ status: "ok", text: expect.stringContaining("Overlay d.") });

		// The disk keeps its files.
		for (const [path, content] of Object.entries(disk)) {
			expect(await readFile(join(project, path), "utf8")).toBe(content);
		}

		expect(existsSync(join(project, ".pi", "skills", "d", "SKILL.md"))).toBe(false);

		// Another child in the same directory sees the disk.
		const plain = await library.open(place, owner, "o:plain", { root: "test", ...faux, cwd: project }, context);
		await plain.ask({ type: "input", content: "Plain context", requestId: "r1" }, context);
		const seen = requests.get("Plain context")?.system;
		expect(seen).toContain("Disk rules.");
		expect(seen).toContain("<description>Disk a.</description>");
		expect(seen).toContain("<description>Disk b.</description>");
		expect(seen).toContain("<description>Disk c.</description>");
		expect(seen).not.toContain("<name>d</name>");
		const read = await plain.ask({ type: "input", content: "Read prompts/gone.md", requestId: "r2" }, context);
		expect(read).toMatchObject({ status: "ok", text: expect.stringContaining("Disk gone.") });
	});

	it("gives a nested child the overlay of its parent, with its own paths first, and none under a plain parent", async () => {
		const files = {
			[join(project, "AGENTS.md")]: "Parent rules.",
			[join(project, "prompts/p.md")]: "Parent prompt.",
			[join(project, "prompts/gone.md")]: null,
		};

		const parent = await library.open(
			place,
			owner,
			"o:parent",
			{ root: "test", ...faux, cwd: project, overlay: files },
			context,
		);

		const nested = await library.open(
			place,
			owner,
			"o:nested",
			{ parent: String(parent.id), ...faux, cwd: project, overlay: { "prompts/p.md": "Own prompt." } },
			context,
		);

		await nested.ask({ type: "input", content: "Nested context", requestId: "r1" }, context);
		expect(requests.get("Nested context")?.system).toContain("Parent rules.");
		const own = await nested.ask({ type: "input", content: "Read prompts/p.md", requestId: "r2" }, context);
		expect(own).toMatchObject({ status: "ok", text: expect.stringContaining("Own prompt.") });
		const gone = await nested.ask({ type: "input", content: "Read prompts/gone.md", requestId: "r3" }, context);
		expect(gone).toMatchObject({ status: "ok", text: expect.stringContaining("ENOENT") });

		const plain = await library.open(place, owner, "o:plain-parent", { root: "test", ...faux, cwd: project }, context);

		const plainNested = await library.open(
			place,
			owner,
			"o:plain-nested",
			{ parent: String(plain.id), ...faux, cwd: project },
			context,
		);

		expect(await harness.snapshot(overlayDoc(durable), plainNested.id, context)).toBeUndefined();
		await plainNested.ask({ type: "input", content: "Plain nested context", requestId: "r1" }, context);
		expect(requests.get("Plain nested context")?.system).toContain("Disk rules.");
	});

	it("gives the overlay to a subagent of an overlaid host child, and the disk to one of a plain child", async () => {
		const overlaid = await fixtureChild("overlaid", hostOverlay);
		expect(await spawnUnder(overlaid, "Read prompts/gone.md")).toContain("ENOENT");
		const system = requests.get("Read prompts/gone.md")?.system;
		expect(system).toContain("Host overlay rules.");
		expect(system).not.toContain("Disk rules.");

		const plain = await fixtureChild("plain");
		expect(await spawnUnder(plain, "Read prompts/p.md")).toContain("Disk prompt.");
		expect(requests.get("Read prompts/p.md")?.system).toContain("Disk rules.");
	});

	it("gives the overlay to a child that a subagent spawns with the subagent tool", async () => {
		const overlaid = await fixtureChild("nest", hostOverlay);
		expect(await spawnUnder(overlaid, "Overlay nest")).toContain("Overlay prompt.");
		expect(requests.get("Task:\nRead prompts/p.md")?.system).toContain("Host overlay rules.");
	});

	it("refuses a relative overlay key for a child without a working directory", async () => {
		const spec = { root: "test", ...faux, overlay: { "AGENTS.md": "x" } };

		await expect(library.open(place, owner, "o:relative", spec, context)).rejects.toThrow(
			"The overlay key AGENTS.md is relative, and the child has no working directory",
		);
		expect(await library.find(place, owner, { key: "o:relative" }, context)).toBeUndefined();
	});
});
