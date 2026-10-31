import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import * as durable from "@earendil-works/pi-durable";
import { Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createChildren, type Owner, type Place } from "../src/children.ts";
import { ChildContext } from "../src/context.ts";
import { models, requests, root, setUp, tearDown } from "./helpers.ts";

const library = createChildren(durable);
const faux = { provider: "faux", model: "faux-1" } as const;

let harness: Harness;
let place: Place;
let owner: Owner;
let project: string;

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
});

afterAll(async () => {
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

	it("refuses a relative overlay key for a child without a working directory", async () => {
		const spec = { root: "test", ...faux, overlay: { "AGENTS.md": "x" } };

		await expect(library.open(place, owner, "o:relative", spec, context)).rejects.toThrow(
			"The overlay key AGENTS.md is relative, and the child has no working directory",
		);
		expect(await library.find(place, owner, { key: "o:relative" }, context)).toBeUndefined();
	});
});
