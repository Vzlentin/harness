/**
 * The projects entry: the work of a project behind the entry API of the host. It serves the persons, threads,
 * messages, rules, held actions, parleys, items, the gate, the digest, the memory of the project agent and the watch of
 * the project, the `ask` requests with their parleys, the checks of the labels `parley:<slug>` and `item:<id>`, the
 * digest before each input, the contracts of the answered read-backs, and the items that the reports of their workers
 * close, and drops the held actions of each child that ended. At the open of the host, it moves an old store to items
 * and labels, opens the index of the items, writes `store.json`, stops the workers of the work that ended, and drops
 * the held actions of the children that ended while the host was down.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { copyJson, type JsonValue } from "@earendil-works/chord/json";
import { type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import type { Entry, EntryLine, EntryOpen, EntryOptions, EntryRequest } from "../host/entries.ts";
import { projectToolsExtension } from "../project-tool.ts";
import { statePaths } from "../protocol/paths.ts";
import { memoryDir } from "../protocol/projects.ts";
import { type ProjectRequest, ProjectRequestLine, type Replies } from "../protocol/requests.ts";
import { digestHook } from "./digest.ts";
import { dropHeldOfEnded, dropHeldOfEndedAgents } from "./ended-agents.ts";
import { gateExtension } from "./gate.ts";
import { allItems } from "./item-docs.ts";
import { ItemIndex } from "./item-index.ts";
import { migrateTodos } from "./item-migration.ts";
import { itemReports } from "./item-reports.ts";
import { migrateLabels } from "./label-migration.ts";
import { Compressor, type HostMemory, memoryExtension } from "./memory.ts";
import { parleyReaction } from "./parleys.ts";
import { ProjectStore } from "./project-store.ts";
import { serveProjectWatch } from "./project-watch.ts";
import { type HandledRequest, handleProject, projectAsk, type ProjectsHost } from "./requests.ts";
import { rulesExtension } from "./rules-section.ts";
import { type StoreFilePasses, storeFilePasses } from "./store-file.ts";
import { workLabelChecks } from "./work-state.ts";
import { stopEndedWork } from "./work-workers.ts";

const context = BACKGROUND_CONTEXT;

/** The version of the protocol of the requests of the projects entry, which the `hello` reply gives. */
export const PROJECTS_PROTOCOL_VERSION = 1;

const passive = () => true;
const active = () => false;

/** Whether a request with an action is a `list` or a `read`, which a widget can poll, and not a change. */
const listOrRead = (request: EntryLine) => request.action === "list" || request.action === "read";

/** Whether a request of each type of the project does not count as activity for the idle exit. */
const PROJECT_PASSIVE = {
	"watch-project": passive,
	person: listOrRead,
	thread: listOrRead,
	rule: listOrRead,
	parley: listOrRead,
	item: listOrRead,
	message: active,
	digest: active,
	memory: active,
	gate: active,
	held: active,
} satisfies { readonly [T in ProjectRequest["type"]]: (request: EntryLine) => boolean };

/**
 * What the entry has once the host is open: the harness, the root conversation, the storage, the index of the items,
 * the project store and the passes of `store.json`.
 */
type Opened = EntryOpen & Pick<ProjectsHost, "items" | "store"> & { readonly storeFile: StoreFilePasses };

/** The projects entry, with the handles of the host in `options`. */
export default function projects(options: EntryOptions): Entry {
	const { place, warn, settings, scope, project } = options;
	// The compressions of the memory of the project agent, which run in the background.
	const compressor = new Compressor({ settings, models: place.models, warn });
	const memory: HostMemory = { compressor, dir: () => memoryDir(project, options.cwd) };
	let opened: Opened | undefined;

	const host = (): ProjectsHost => {
		if (opened === undefined) throw new Error("The host is not open yet");

		return { ...options, ...opened, models: place.models, memory };
	};

	const requests: EntryRequest[] = Object.entries(PROJECT_PASSIVE).map(([type, isPassive]) =>
		type === "watch-project"
			? {
					type,
					schema: schemaOf(type),
					passive: isPassive,
					watch: (_request, watch) => serveProjectWatch(host(), watch),
				}
			: {
					type,
					schema: schemaOf(type),
					passive: isPassive,
					handle: async (line, { signal }) => json(await handleProject(projectRequest(line), host(), signal)),
				},
	);

	return {
		extensions: [
			rulesExtension(() => host().store),
			memoryExtension(memory, scope),
			projectToolsExtension(options.durable, { Type }, scope),
			gateExtension(scope.send),
		],
		requests,
		input: digestHook(host),
		answeredAsk: (event, handlerOptions) => parleyReaction(host())(event, handlerOptions),
		reported: (event) => itemReports(host())(event),
		agentEnded: ({ conversation }) => dropHeldOfEnded(host(), conversation),
		labels: workLabelChecks(() => host().harness),
		protocol: { name: "projects", version: PROJECTS_PROTOCOL_VERSION },
		ask: (request, { author }) => projectAsk(request, host(), author),
		classifyList: async () => {
			const { harness, storage } = host();
			const items = await allItems(harness, storage, context);

			return items.map(({ id, title, state }) => ({ id, text: title, state }));
		},
		// The project store opens first. The first start moves the todos of the project to items, and the items that the
		// children of an old store served to their labels, before any reader of the items or the labels. The index of the
		// ends of the items observes the commits first, so the observers and the passes after it read it current with each
		// commit. A worker of work that ended, such as one that a message resumed, stops at each start, and a child that
		// ended while the host was down has its held actions dropped.
		open: async ({ harness, root, storage }) => {
			// The host is the only writer, so a write never waits for a lock.
			const store = ProjectStore.open(options.stateDir, 0);

			try {
				await migrateTodos(harness, options.todos, root.id);
				await migrateLabels(harness, storage, options.labelChild);
				const items = await ItemIndex.open(harness, storage);
				const path = statePaths(project).store;

				const storeFile = storeFilePasses({
					harness,
					storage,
					store,
					root,
					asks: options.asks,
					todos: options.todos,
					path,
					warn,
				});

				opened = { harness, root, storage, items, store, storeFile };
			} catch (error) {
				store.close();
				throw error;
			}

			await stopEndedWork(host());
			await dropHeldOfEndedAgents(host());
		},
		busy: () => compressor.running > 0,
		close: async () => {
			opened?.items.close();
			await opened?.storeFile.close();
			await compressor.close();
			opened?.store.close();
		},
	};
}

/** The schema of the request type `type`: the branches of `ProjectRequestLine` of that type. */
function schemaOf(type: string): TSchema {
	return Type.Union(ProjectRequestLine.anyOf.filter((branch) => Value.Check(branch.properties.type, type)));
}

/**
 * `line` as a request of the project that gets a reply: the host checked a line of the socket against the schema of
 * its type, and a tool of the host sends a typed request. The host gives the handlers no line of the watch type.
 */
function projectRequest(line: EntryLine): HandledRequest {
	// SAFETY: the host gives the handler of a type only a line of that type that its schema checked, or a typed request,
	// and gives no handler a line of the watch type.
	return line as HandledRequest;
}

/** The reply `value` as JSON, without its undefined properties. */
function json(value: Replies[HandledRequest["type"]]): JsonValue {
	return copyJson(value, { omitUndefinedProperties: true });
}
