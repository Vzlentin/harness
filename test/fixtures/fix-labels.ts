/** An entry that checks the labels of the kind `fix`: it takes each one. */
export default function fixLabelsEntry() {
	return { extensions: [], labels: [{ kind: "fix", check: async () => {} }], close: async () => {} };
}
