/**
 * The default limit of a hosted bash call: a call that sets no timeout stops after it, with a line that tells the model
 * to set a timeout. A call that sets a timeout runs with it.
 */
import { defineExtension, type Extension, wrapTool } from "@earendil-works/pi-durable";
import { createBashTool } from "@earendil-works/pi-durable/tools";
import { Type } from "typebox";
import { Value } from "typebox/value";

/** The time after which a bash call that sets no timeout stops. */
export const BASH_TIMEOUT_SECONDS = 300;

/** The part of the bash parameters that the wrapper changes: the `timeout` property. */
const BashParameters = Type.Object({ properties: Type.Object({ timeout: Type.Object({}) }) });

/** The extension that gives each bash call with no timeout a timeout of `seconds`. */
export function bashTimeoutExtension(seconds: number): Extension {
	return defineExtension({
		name: "harness-bash-timeout",
		wraps: [
			wrapTool(createBashTool(), (bash) => {
				const { parameters } = bash;

				if (!Value.Check(BashParameters, parameters)) throw new Error("The bash tool has no timeout parameter");

				const { properties } = parameters;

				const timeout = {
					...properties.timeout,
					description: `Timeout in seconds (optional, default ${seconds} seconds)`,
				};

				return {
					...bash,
					parameters: { ...parameters, properties: { ...properties, timeout } },
					execute: async (args, api, context) => {
						if (args.timeout !== undefined) return bash.execute(args, api, context);

						try {
							return await bash.execute({ ...args, timeout: seconds }, api, context);
						} catch (error) {
							if (error instanceof Error && error.message === `Command timed out after ${seconds} seconds`) {
								throw new Error(
									`Command stopped after ${seconds} seconds: it set no timeout. Set a timeout to run longer.`,
									{ cause: error },
								);
							}

							throw error;
						}
					},
				};
			}),
		],
	});
}
