import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vite-plus/test";

const execProgram = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VP = join(ROOT, "node_modules", "vite-plus", "bin", "vp");
const TEST_FILE = "test/git-environment.test.ts";

/** Set in the nested test run: the folder where it makes its repository and writes `result.json`. */
const MARKER = "HARNESS_TEST_GIT_FOLDER";
const childFolder = process.env[MARKER];

const ChildResult = Type.Object({ repo: Type.String(), sha: Type.String() });

/** Runs Git in `cwd` and gives its trimmed output. */
async function git(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await execProgram("git", args, { cwd });

	return stdout.trim();
}

/** The state of `repo` that a stray Git command would change. */
async function snapshot(repo: string): Promise<string[]> {
	return [
		await git(repo, ["rev-parse", "HEAD"]),
		await git(repo, ["rev-list", "--count", "--all"]),
		await git(repo, ["branch", "--format=%(refname) %(objectname)"]),
		await git(repo, ["config", "--get", "core.bare"]),
	];
}

/** Makes a repository with one commit in `repo`. */
async function makeRepo(repo: string): Promise<void> {
	await mkdir(repo);
	await git(repo, ["init", "--quiet"]);
	await git(repo, ["commit", "--quiet", "--allow-empty", "-m", "first"]);
}

describe("the Git environment of the tests", () => {
	it.runIf(childFolder !== undefined)("runs Git in its own repository", async () => {
		if (childFolder === undefined) throw new Error(`${MARKER} is not set`);

		const repo = join(childFolder, "child");
		await makeRepo(repo);
		const sha = await git(repo, ["rev-parse", "HEAD"]);
		await writeFile(join(childFolder, "result.json"), JSON.stringify({ repo, sha }));
	});

	it.runIf(childFolder === undefined)(
		"does not touch the repository in the caller's GIT_DIR",
		async () => {
			const folder = await mkdtemp(join(tmpdir(), "harness-git-"));

			try {
				const victim = join(folder, "repo");
				await makeRepo(victim);
				const before = await snapshot(victim);

				const environment: NodeJS.ProcessEnv = {
					...process.env,
					GIT_DIR: join(victim, ".git"),
					GIT_WORK_TREE: victim,
					GIT_INDEX_FILE: join(victim, ".git", "index"),
					[MARKER]: folder,
				};

				await execProgram(process.execPath, [VP, "test", "--run", TEST_FILE], { cwd: ROOT, env: environment });
				expect(await snapshot(victim)).toEqual(before);

				const reported = Value.Parse(ChildResult, JSON.parse(await readFile(join(folder, "result.json"), "utf8")));
				expect(reported.repo).not.toBe(victim);
				expect(await git(reported.repo, ["rev-parse", "HEAD"])).toBe(reported.sha);
			} finally {
				await rm(folder, { recursive: true, force: true });
			}
		},
		60_000,
	);
});
