/**
 * The model of a background call of the host, such as a query or a compression of the memory, from a key of Pi's
 * settings.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai/models";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { parseModelSetting, subagentModel } from "../children/model.ts";

/**
 * The model of the setting `key` of Pi's effective settings, read again at each call, else `subagentModel`, else Pi's
 * default model. An unknown model, and a provider with no credential, fail. `purpose` names the call in the errors,
 * such as `a query`.
 */
export async function settingModel(
	settings: SettingsManager,
	models: Models,
	key: string,
	purpose: string,
): Promise<Model<Api>> {
	await settings.reload();
	const effective = settings.getSettings();
	const setting = Type.Object({ [key]: Type.String() });
	const text = Value.Check(setting, effective) ? effective[key] : undefined;
	const set = text === undefined ? undefined : parseModelSetting(text);
	const provider = settings.getDefaultProvider();
	const modelId = settings.getDefaultModel();

	const chosen =
		set ??
		subagentModel(settings) ??
		(provider === undefined || modelId === undefined ? undefined : { provider, model: modelId });

	if (chosen === undefined) {
		throw new Error(`No model for ${purpose}: set ${key}, subagentModel or a default model in Pi`);
	}

	const model = models.getModel(chosen.provider, chosen.model);

	if (model === undefined) throw new Error(`Unknown model: ${chosen.provider}/${chosen.model}`);

	if (!(await models.getAvailable(chosen.provider)).some((found) => found.id === model.id)) {
		throw new Error(`No credential for ${chosen.provider}: log in to ${chosen.provider} or set ${key}`);
	}

	return model;
}
