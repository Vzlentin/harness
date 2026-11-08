/** The names of the environment variables that the host sets in a conversation shell and that the CLI reads. */

/** The conversation of the shell: the caller of a CLI command that runs in it. */
export const PI_SESSION_ID = "PI_SESSION_ID";

/** The provider of the conversation's model: the default provider of a spawn. */
export const PI_PROVIDER = "PI_PROVIDER";

/** The ID of the conversation's model: the default model of a spawn. */
export const PI_MODEL = "PI_MODEL";

/** The thinking level of the conversation: the default thinking level of a spawn. */
export const PI_REASONING_LEVEL = "PI_REASONING_LEVEL";

/** The project of a command, before the project of the current directory. */
export const HARNESS_PROJECT = "HARNESS_PROJECT";

/** The memory folder of the project, for the `memo` tool. */
export const MEMORY_DIR = "MEMORY_DIR";
