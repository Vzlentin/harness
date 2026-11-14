/**
 * The kernel side of the tools bridge: the events of pi-ipython, the environment that gives the kernel its server, and
 * the startup code that binds `tools`.
 */
import { fileURLToPath } from "node:url";
import type { ConversationId } from "@earendil-works/pi-durable";
import { type Static, Type } from "typebox";

/**
 * The event that pi-ipython emits before each kernel start, restarts included: on the shared bus of the host's entries,
 * or on `pi.events` in Pi.
 */
export const KERNEL_STARTING = "ipython:kernel-starting";

/** The event that pi-ipython emits when a cell starts, with the means to run the tools of its conversation. */
export const CELL_START = "ipython:cell-start";

/** The event that pi-ipython emits when a cell ends, also when it fails. */
export const CELL_END = "ipython:cell-end";

/**
 * The payload of `KERNEL_STARTING`. pi-ipython reads `env` and `startupCode` once the promises given to `waitFor`
 * settle, so a listener can fill them inside such a promise.
 */
export const KernelStarting = Type.Object({
	env: Type.Record(Type.String(), Type.String()),
	startupCode: Type.Array(Type.String()),
	waitFor: Type.Unsafe<(promise: Promise<void>) => void>(Type.Function([Type.Unknown()], Type.Unknown())),
});

export type KernelStarting = Static<typeof KernelStarting>;

/** The payload of `KERNEL_STARTING` in the host, which also gives the conversation of the kernel. */
export const ConversationKernelStarting = Type.Object({
	...KernelStarting.properties,
	conversationId: Type.Unsafe<ConversationId>(Type.Integer()),
});

export type ConversationKernelStarting = Static<typeof ConversationKernelStarting>;

/** The warning of a `KERNEL_STARTING` event whose payload has another shape. */
export const INVALID_KERNEL_STARTING = `The ${KERNEL_STARTING} event has an invalid payload; its kernel gets no tools`;

/** The warning of a `CELL_START` event whose payload has another shape. */
export const INVALID_CELL_START = `The ${CELL_START} event has an invalid payload; its cell gets no tools`;

/** The warning of a `CELL_END` event whose payload has another shape. */
export const INVALID_CELL_END = `The ${CELL_END} event has an invalid payload; its cell keeps its tools`;

/** The path of the socket of the kernel's server. */
export const HARNESS_TOOLS_SOCKET = "HARNESS_TOOLS_SOCKET";

/** The secret token that each request of the kernel carries. */
export const HARNESS_TOOLS_TOKEN = "HARNESS_TOOLS_TOKEN";

/**
 * The folder of `harness_tools.py`: two levels up from this module, in `src/bridge/` of a checkout and `dist/bridge/` of
 * an install.
 */
const PYTHON_DIR = fileURLToPath(new URL("../../python", import.meta.url));

/** The startup code of a kernel: `python/` first on `sys.path`, because the kernel runs with `-I -S`, then `tools`. */
export const STARTUP_CODE: readonly string[] = [
	`__import__('sys').path.insert(0, ${JSON.stringify(PYTHON_DIR)})`,
	"tools = __import__('harness_tools').Tools()",
];
