import { defineConfig } from "vite-plus";
import type { OxlintOverride } from "vite-plus/lint";

/** A `no-restricted-imports` pattern: the import paths that match `group` or `regex`. */
type ImportPattern = { message: string; allowTypeImports?: boolean } & ({ group: string[] } | { regex: string });

/** An override that refuses, in `files`, the imports that match one of `patterns`. */
function restrictImports(files: string[], ...patterns: ImportPattern[]): OxlintOverride {
	return { files, rules: { "no-restricted-imports": ["error", { patterns }] } };
}

// An override replaces the options of a rule, so `src/host/durable-entry.ts` repeats the pattern of `src/host/**`.
const hostImports: ImportPattern = {
	group: [
		"../**",
		"!../protocol/**",
		"!../children/**",
		"!../bridge/**",
		"!../tool.ts",
		"!../project-tool.ts",
		"!../memory-tool.ts",
	],
	message: "host/ imports only protocol/, children/, bridge/, tool.ts, project-tool.ts and memory-tool.ts.",
};

export default defineConfig({
	fmt: {
		useTabs: true,
		printWidth: 120,
		singleQuote: false,
		sortImports: { newlinesBetween: false },
		ignorePatterns: [
			"dist/**",
			"tools/oxlint/anti-slop/**",
			".release-please-manifest.json",
			"CHANGELOG.md",
			// A copy of the cases of the gate spike, kept as it was recorded.
			"test/fixtures/gate-cases.json",
		],
	},
	lint: {
		ignorePatterns: [
			".agent/**",
			".agents/**",
			".claude/**",
			".codex/**",
			".continue/**",
			".cursor/**",
			".gemini/**",
			".opencode/**",
			".pi/**",
			".roo/**",
			".windsurf/**",
			"tools/oxlint/anti-slop/**",
			"dist/**",
		],
		jsPlugins: [{ name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" }],
		rules: {
			"oxc/no-accumulating-spread": "error",
			"anti-slop/no-array-filter-map": "error",
			"anti-slop/no-reduce-accumulator-copy": "error",
			"anti-slop/no-chained-type-assertions": "error",
			"anti-slop/no-conditional-empty-object-spread": "error",
			"anti-slop/no-known-value-widening": "error",
			"anti-slop/no-module-mocking": "error",
			"anti-slop/no-object-parameters": "error",
			"anti-slop/no-reflect-apply": "error",
			"anti-slop/no-reflect-get": "error",
			"anti-slop/no-runtime-typeof": "error",
			"anti-slop/no-shape-in-symbol-names": "error",
			"anti-slop/no-unknown-parameters": "error",
			"anti-slop/no-unknown-returns": "error",
			"anti-slop/no-unknown-type-aliases": "error",
			"anti-slop/no-unsafe-dictionary-type": "error",
			"anti-slop/no-widen-then-assert": "error",
			"anti-slop/require-readable-spacing": "error",
			"anti-slop/require-safety-comment-for-type-assertion": "error",
		},
		overrides: [
			restrictImports(
				["pi/**"],
				{
					regex: "^\\.\\./dist/",
					allowTypeImports: true,
					message:
						"pi/ is published without dist/: import its types only, and take the modules from the Harness object.",
				},
				{
					group: [
						"../dist/**",
						"!../dist/protocol/**",
						"!../dist/client/**",
						"!../dist/bridge/**",
						"!../dist/tool.js",
						"!../dist/project-tool.js",
						"!../dist/memory-tool.js",
					],
					message: "pi/ loads only protocol/, client/, bridge/, tool.ts, project-tool.ts and memory-tool.ts.",
				},
			),
			restrictImports(["src/protocol/**"], { group: ["../**"], message: "protocol/ imports nothing else from src/." }),
			restrictImports(["src/children/**"], {
				group: ["../**", "!../protocol/**"],
				message: "children/ imports only protocol/ from src/.",
			}),
			restrictImports(["src/client/**"], {
				group: ["../**", "!../protocol/**"],
				message: "client/ imports only protocol/ from src/.",
			}),
			restrictImports(["src/inspect/**"], {
				group: ["../**", "!../protocol/**", "!../client/**"],
				message: "inspect/ imports only protocol/ and client/ from src/.",
			}),
			restrictImports(
				["src/bridge/**"],
				{
					group: ["../**", "!../protocol/**"],
					message: "bridge/ imports only protocol/ from src/.",
				},
				{
					group: ["@earendil-works/**"],
					allowTypeImports: true,
					message: "The Pi extension loads bridge/ from dist/: import the types of Pi packages only.",
				},
			),
			restrictImports(["src/host/**"], hostImports),
			restrictImports(["src/host/durable-entry.ts"], hostImports, {
				group: ["@earendil-works/*"],
				allowTypeImports: true,
				message:
					"The durable entry runs on the host's pi-durable and pi-ai: import their types only, and take the modules from the options.",
			}),
			restrictImports(["src/tool.ts"], {
				group: ["./**", "../**", "!./protocol/**", "!./client/**"],
				message: "tool.ts imports only protocol/ and client/.",
			}),
			restrictImports(["src/project-tool.ts"], {
				group: ["./**", "../**", "!./protocol/**", "!./client/**", "!./tool.ts"],
				message: "project-tool.ts imports only protocol/, client/ and tool.ts.",
			}),
			restrictImports(
				["src/memory-tool.ts"],
				{
					group: ["./**", "../**", "!./protocol/**", "!./tool.ts"],
					message: "memory-tool.ts imports only protocol/ and tool.ts.",
				},
				{
					group: ["@earendil-works/**"],
					allowTypeImports: true,
					message: "The Pi extension loads memory-tool.ts from dist/: import the types of Pi packages only.",
				},
			),
		],
		options: { typeAware: true, typeCheck: true },
	},
	// The tests change `process.env`, such as `HOME`, so each test file runs in its own process.
	// `test/setup.ts` clears the caller's `GIT_*` variables in each of these processes.
	test: { pool: "forks", setupFiles: ["test/setup.ts"] },
	pack: {
		entry: ["src/**/*.ts"],
		outDir: "dist",
		format: ["esm"],
		platform: "node",
		unbundle: true,
		fixedExtension: false,
		dts: true,
		deps: { neverBundle: true },
	},
});
