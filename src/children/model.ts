import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { clampThinkingLevel, getSupportedThinkingLevels, type Models } from "@earendil-works/pi-ai/models";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { Agent, ModelRef } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { isThinkingLevel } from "../protocol/requests.ts";

/** A provider and a model, which count as one unit. */
export type ModelChoice = { readonly provider: string; readonly model: string };

/**
 * A `provider/model` text, split at the first `/`: a model ID can contain a `/`. Undefined without a provider or a
 * model.
 */
export function parseModelSetting(text: string): ModelChoice | undefined {
	const slash = text.indexOf("/");

	if (slash <= 0 || slash === text.length - 1) return undefined;

	return { provider: text.slice(0, slash), model: text.slice(slash + 1) };
}

const ModelSetting = Type.Object({ subagentModel: Type.String() });

/**
 * The model of the `subagentModel` setting of Pi's global settings, as `settings` has them loaded. Undefined when it is
 * absent or invalid.
 */
export function subagentModel(settings: Pick<SettingsManager, "getGlobalSettings">): ModelChoice | undefined {
	const global = settings.getGlobalSettings();

	return Value.Check(ModelSetting, global) ? parseModelSetting(global.subagentModel) : undefined;
}

/** The model and the thinking level of a child. */
export type ResolvedModel = { model: ModelRef; thinkingLevel: ModelThinkingLevel };

/**
 * The model and thinking level of `request`; a field left out comes from `fallback`. An explicit `thinking` that the
 * model does not have is refused. Without it, the level is `fallbackThinking`, else the fallback's, clamped to the
 * nearest level that the model has.
 */
export function resolveModel(
	models: Models,
	fallback: Pick<Agent, "model" | "thinkingLevel"> | undefined,
	request: {
		readonly provider?: string | undefined;
		readonly model?: string | undefined;
		readonly thinking?: string | undefined;
		readonly fallbackThinking?: string | undefined;
	},
): ResolvedModel {
	const provider = request.provider ?? fallback?.model?.provider;
	const modelId = request.model ?? fallback?.model?.modelId;

	if (provider === undefined || modelId === undefined) {
		throw new Error("No model: neither the spec nor the owner's agent names one");
	}

	const model = models.getModel(provider, modelId);

	if (model === undefined) throw new Error(`Unknown model: ${provider}/${modelId}`);
	const levels = getSupportedThinkingLevels(model);

	if (request.thinking !== undefined) {
		const thinkingLevel = levels.find((level) => level === request.thinking);

		if (thinkingLevel === undefined)
			throw new Error(`${provider}/${modelId} has no thinking level ${request.thinking}`);

		return { model: { provider, modelId }, thinkingLevel };
	}

	const inherited = request.fallbackThinking ?? fallback?.thinkingLevel ?? "off";

	// `clampThinkingLevel` gives the model's first level for a name that it does not know.
	return {
		model: { provider, modelId },
		thinkingLevel: isThinkingLevel(inherited) ? clampThinkingLevel(model, inherited) : (levels[0] ?? "off"),
	};
}
