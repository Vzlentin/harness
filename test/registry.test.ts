import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readEntries } from "../src/entries.ts";
import { readProjects } from "../src/projects.ts";
import { root, setUp, tearDown } from "./helpers.ts";

const WORKERS = 4;
const WRITES = 25;

beforeAll(async () => {
	await setUp();
});

afterAll(async () => {
	await tearDown();
});

/** Runs `code` as an ES module in `WORKERS` processes at the same time, with `WORKER` set to the number of each. */
async function inWorkers(code: string): Promise<void> {
	await Promise.all(
		Array.from(
			{ length: WORKERS },
			(_, worker) =>
				new Promise<void>((resolve, reject) => {
					execFile(
						process.execPath,
						["--input-type=module", "--eval", code],
						{ env: { ...process.env, WORKER: String(worker) } },
						(error, _stdout, stderr) => (error === null ? resolve() : reject(new Error(stderr))),
					);
				}),
		),
	);
}

/** The module `src/<name>.ts` as an import specifier. */
function source(name: string): string {
	return JSON.stringify(pathToFileURL(join(import.meta.dirname, "..", "src", `${name}.ts`)).href);
}

describe("registry files", { timeout: 30_000 }, () => {
	it("keeps every entry that processes set at the same time", async () => {
		await inWorkers(
			`import { setEntry } from ${source("entries")};
			for (let i = 0; i < ${WRITES}; i++) setEntry(\`w\${process.env.WORKER}-\${i}\`, \`/modules/\${i}.ts\`);`,
		);
		expect(Object.keys(readEntries())).toHaveLength(WORKERS * WRITES);
	});

	it("keeps every project that processes add at the same time", async () => {
		const dirs = join(root, "dirs");

		for (let worker = 0; worker < WORKERS; worker++) {
			for (let i = 0; i < WRITES; i++) await mkdir(join(dirs, `${worker}-${i}`), { recursive: true });
		}

		await inWorkers(
			`import { addProject } from ${source("projects")};
			for (let i = 0; i < ${WRITES}; i++) addProject(\`w\${process.env.WORKER}-\${i}\`, ${JSON.stringify(dirs)} + \`/\${process.env.WORKER}-\${i}\`);`,
		);
		expect(Object.keys(readProjects())).toHaveLength(WORKERS * WRITES);
	});
});
