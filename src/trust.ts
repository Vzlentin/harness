/** Pi's project trust, apart from the rest of the context, so that a Pi extension can read it without pi-durable. */
import {
	getAgentDir,
	hasTrustRequiringProjectResources,
	ProjectTrustStore,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

/**
 * Whether Pi trusts the project in `cwd` with no one to ask: a directory without project resources is trusted, then a
 * decision saved with `/trust` counts, then the `defaultProjectTrust` setting, where `ask` means not trusted.
 */
export function savedTrust(cwd: string): boolean {
	if (!hasTrustRequiringProjectResources(cwd)) return true;
	const agentDir = getAgentDir();
	const decision = new ProjectTrustStore(agentDir).get(cwd);

	if (decision !== null) return decision;

	return SettingsManager.create(cwd, agentDir, { projectTrusted: false }).getDefaultProjectTrust() === "always";
}
