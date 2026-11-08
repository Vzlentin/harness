/** The `@vzlentin/harness/inspect` entry: the conversation inspect UI, served alone or mounted in another server. */
export {
	createInspectHandler,
	type InspectFrame,
	type InspectHandler,
	type InspectOptions,
	type InspectSummary,
	type InspectTarget,
	type InspectTargets,
} from "./handler.ts";

export { type InspectServer, type InspectServerOptions, resolveBindHosts, startInspectServer } from "./server.ts";
