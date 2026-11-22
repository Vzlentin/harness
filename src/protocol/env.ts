/**
 * The names of the environment variables that the host sets in a conversation shell and that the CLI reads, and the
 * caller of a command that comes from them.
 */

/** The conversation of the shell: the caller of a CLI command that runs in it. */
export const PI_SESSION_ID = "PI_SESSION_ID";

/** The caller of a command from a terminal that is not an agent: `PI_SESSION_ID` is not set. */
export const CLI_CALLER = "cli";

/** The caller of a command with the environment `env`: `PI_SESSION_ID`, or `CLI_CALLER` when it is not set. */
export function cliCaller(env: NodeJS.ProcessEnv): string {
	return env[PI_SESSION_ID] || CLI_CALLER;
}

/** The provider of the conversation's model: the default provider of a spawn. */
export const PI_PROVIDER = "PI_PROVIDER";

/** The ID of the conversation's model: the default model of a spawn. */
export const PI_MODEL = "PI_MODEL";

/** The thinking level of the conversation: the default thinking level of a spawn. */
export const PI_REASONING_LEVEL = "PI_REASONING_LEVEL";

/** The host of a command, before the host of the current directory. */
export const HARNESS_HOST = "HARNESS_HOST";

/** The memory folder of the host, for the `memo` tool. */
export const MEMORY_DIR = "MEMORY_DIR";

/** The port of `harness inspect` and `harness page` without `--port`, before 7501. */
export const HARNESS_INSPECT_PORT = "HARNESS_INSPECT_PORT";
