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
	group: ["../**", "!../protocol/**", "!../children/**", "!../rlm/**", "!../tool.ts"],
	message: "host/ imports only protocol/, children/, rlm/ and tool.ts.",
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
					group: ["../dist/**", "!../dist/protocol/**", "!../dist/client/**", "!../dist/rlm/**", "!../dist/tool.js"],
					message: "pi/ loads only protocol/, client/, rlm/ and tool.ts.",
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
				["src/rlm/**"],
				{
					group: ["../**", "!../protocol/**", "!../tool.ts"],
					message: "rlm/ imports only protocol/ and tool.ts from src/.",
				},
				{
					group: ["@earendil-works/**"],
					allowTypeImports: true,
					message: "The Pi extension loads rlm/ from dist/: import the types of Pi packages only.",
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
		],
		options: { typeAware: true, typeCheck: true },
	},
	// The tests change `process.env`, such as `HOME`, so each test file runs in its own process.
	test: { pool: "forks" },
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
