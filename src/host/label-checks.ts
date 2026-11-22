/**
 * The checks of the labels of a new worker: the check of a label kind, and the check of a list of labels with the checks
 * of the entries.
 */
import { refParts } from "../protocol/worker-labels.ts";

/** The check of the labels of one kind, which throws the reason when it refuses `label`. */
export type LabelCheck = (label: string) => Promise<void>;

/**
 * Checks each label of `labels` with the check of its kind in `checks`, in order, and throws the reason of the first
 * one that it refuses. A label of a kind with no check is refused.
 */
export async function checkLabels(checks: ReadonlyMap<string, LabelCheck>, labels: readonly string[]): Promise<void> {
	for (const label of labels) {
		const { kind } = refParts(label);
		const check = checks.get(kind);

		if (check === undefined) throw new Error(`no loaded entry checks the label kind "${kind}"`);
		await check(label);
	}
}
