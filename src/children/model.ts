import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { clampThinkingLevel, getSupportedThinkingLevels, type Models } from "@earendil-works/pi-ai/models";
import { MODEL_THINKING_LEVELS } from "@earendil-works/pi-ai/providers/model-schema";
import type { Agent, ModelRef } from "@earendil-works/pi-durable";

/** Whether `value` is one of pi-ai's thinking levels. */
export function isThinkingLevel(value: string): value is ModelThinkingLevel {
	return MODEL_THINKING_LEVELS.some((level) => level === value);
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
