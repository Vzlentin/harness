// Registers `pi/` in Pi after a global install, with `setup` of `dist/setup.js`. Plain JavaScript, since Node does not
// strip types under node_modules. Other installs, such as `npm ci` in a checkout without `dist/`, do nothing, and an
// error must not fail the npm install.
import { fileURLToPath } from "node:url";

if (process.env.npm_config_global === "true") {
	try {
		const { setup } = await import("../dist/setup.js");
		setup(fileURLToPath(new URL("..", import.meta.url)));
	} catch (error) {
		console.warn(`harness: setup failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}
