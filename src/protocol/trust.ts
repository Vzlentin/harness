/**
 * Pi's project trust. The host (`PI_TRUST` in children/context.ts, with this install's pi-coding-agent) and the Pi
 * extension (with Pi's own modules) share it. It takes Pi's functions as a parameter and has no runtime import.
 */
import type * as pi from "@earendil-works/pi-coding-agent";

/** The functions of pi-coding-agent that the trust uses. */
export type TrustApi = Pick<
	typeof pi,
	"getAgentDir" | "hasTrustRequiringProjectResources" | "ProjectTrustStore" | "SettingsManager"
>;

/**
 * Whether Pi trusts the project in `cwd` with no one to ask: a directory without project resources is trusted, then a
 * decision saved with `/trust` counts, then the `defaultProjectTrust` setting, where `ask` means not trusted.
 */
export function savedTrust(cwd: string, api: TrustApi): boolean {
	if (!api.hasTrustRequiringProjectResources(cwd)) return true;
	const agentDir = api.getAgentDir();
	const decision = new api.ProjectTrustStore(agentDir).get(cwd);

	if (decision !== null) return decision;

	return api.SettingsManager.create(cwd, agentDir, { projectTrusted: false }).getDefaultProjectTrust() === "always";
}
