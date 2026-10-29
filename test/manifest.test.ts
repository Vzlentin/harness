import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultPackageManager, loadSkills, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const Root = Type.Object({ version: Type.String() });
const Agents = Type.Object({ dependencies: Type.Object({ "@vzlentin/harness": Type.String() }) });
const ExtraFile = Type.Object({ type: Type.String(), path: Type.String(), jsonpath: Type.String() });
const Config = Type.Object({ packages: Type.Object({ ".": Type.Object({ "extra-files": Type.Array(ExtraFile) }) }) });

/** The text of the file at `path` in the repository. */
function text(path: string): string {
	return readFileSync(join(repo, path), "utf8");
}

describe("the manifests", () => {
	it("give the Pi package a harness dependency at the version of the release, which release-please moves", () => {
		const { version } = Value.Parse(Root, JSON.parse(text("package.json")));
		const { dependencies } = Value.Parse(Agents, JSON.parse(text("pi/package.json")));
		const extraFiles = Value.Parse(Config, JSON.parse(text("release-please-config.json"))).packages["."]["extra-files"];

		expect(dependencies["@vzlentin/harness"]).toBe(version);

		expect(extraFiles).toContainEqual({
			type: "json",
			path: "pi/package.json",
			jsonpath: "$.dependencies['@vzlentin/harness']",
		});
	});

	it("make Pi load the extension once and the subagent skill from the Pi package", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "harness-manifest-"));

		try {
			const settingsManager = SettingsManager.inMemory();
			const agentDir = join(cwd, "agent");
			const packages = new DefaultPackageManager({ cwd, agentDir, settingsManager });
			const resolved = await packages.resolveExtensionSources([join(repo, "pi")], { temporary: true });
			const skillPaths = resolved.skills.filter(({ enabled }) => enabled).map(({ path }) => path);

			expect(resolved.extensions.map(({ path }) => path)).toEqual([join(repo, "pi", "index.ts")]);
			expect(skillPaths).toEqual([join(repo, "pi", "skills", "subagent", "SKILL.md")]);

			const { skills, diagnostics } = loadSkills({ cwd, agentDir, skillPaths, includeDefaults: false });

			expect(skills.map(({ name }) => name)).toEqual(["subagent"]);
			expect(diagnostics).toEqual([]);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
