import { defineConfig } from "vitest/config";

// The tests change `process.env`, such as `HOME`, so each test file runs in its own process.
export default defineConfig({ test: { pool: "forks" } });
