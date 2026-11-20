/** The members of a document family of the session, which the session cannot list. */
import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import type { Cursor, JsonObject, SessionDocFamilyToken, Storage } from "@earendil-works/pi-durable";

/** The number of documents that one page of the scan of a family gives. */
const PAGE = 200;

/** The keys of the current members of `family`, in the order of `storage`, the storage of the session. */
export async function familyKeys<T extends JsonObject, I extends JsonValue>(
	storage: Pick<Storage, "scanDocuments">,
	family: SessionDocFamilyToken<T, I>,
	context: Context,
): Promise<string[]> {
	const { kind, scope } = family.definition;
	const keys: string[] = [];
	let cursor: Cursor | undefined;

	do {
		const page = await storage.scanDocuments({ scope: { kind: scope }, at: "current", kind }, PAGE, cursor, context);

		for (const record of page.items) {
			if (record.key === undefined) throw new Error(`A document of ${kind} has no key: ${record.id}`);
			keys.push(record.key);
		}

		cursor = page.next;
	} while (cursor !== undefined);

	return keys;
}
