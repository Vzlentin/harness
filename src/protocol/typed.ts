/** The inputs that the user typed: their entry kind, and the text of a user message. */
import type { UserMessage } from "@earendil-works/pi-ai";

/**
 * The entry kind of an input that the user typed: the host gives it to each `input` request, and to nothing else. An
 * entry reads only these entries as the words of the user.
 */
export const TYPED_KIND = "harness.typed";

/** The text of the user message `content`: its text parts, joined. */
export function userText(content: UserMessage["content"]): string {
	if (!Array.isArray(content)) return content;

	return content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}
