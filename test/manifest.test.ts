import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
});
