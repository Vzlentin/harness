import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = fileURLToPath(new URL("src", import.meta.url));

// The tests change `process.env`, such as `HOME`, so each test file runs in its own process. The files in `pi/` import
// the built `dist/`, and the tests give them the sources instead, so they need no build.
export default defineConfig({
	resolve: { alias: [{ find: /^\.\.\/dist\/(.+)\.js$/, replacement: `${src}/$1.ts` }] },
	test: { pool: "forks" },
});
