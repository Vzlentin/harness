// Registers `pi/` in Pi after a global install. Plain JavaScript, since Node does not strip types under node_modules.
// Other installs do nothing, and a Pi failure must not fail the npm install.
import { spawnSync } from "node:child_process";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const extension = fileURLToPath(new URL("../pi", import.meta.url));

// npm puts node_modules/.bin first on PATH, and pi-coding-agent there has its own `pi`. Use the user's Pi only.
const userPath = (process.env.PATH ?? "")
	.split(delimiter)
	.filter((entry) => !entry.endsWith(join("node_modules", ".bin")))
	.join(delimiter);

if (process.env.npm_config_global === "true") registerExtension();

function registerExtension() {
	const later = `To get the subagent tool in Pi, run: pi install ${extension}`;

	const result = spawnSync("pi", ["install", extension], {
		env: { ...process.env, PATH: userPath },
		stdio: "inherit",
		timeout: 120_000,
	});

	if (result.error?.code === "ENOENT") {
		console.warn(`harness: pi is not on PATH. ${later}`);
	} else if (result.error || result.status !== 0) {
		console.warn(`harness: pi install failed (${result.error?.message ?? `exit ${result.status}`}). ${later}`);
	}
}
