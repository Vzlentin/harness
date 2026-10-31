/**
 * The runtime view of a child's overlay: the resources that the sections show, and the `read` tool, with the overlay
 * contents in place of the disk. `overlay.ts` has the doc and the key resolution.
 */
import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { Context } from "@earendil-works/chord";
import {
	createSyntheticSourceInfo,
	type loadSkills,
	parseFrontmatter,
	type SourceInfo,
} from "@earendil-works/pi-coding-agent";
import {
	type DocumentReader,
	defineDoc,
	defineTool,
	type PromptInput,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import {
	type BinaryReader,
	type ExecutionEnv,
	err,
	FileError,
	type FileInfo,
	type LineScan,
	LineScanner,
	ok,
	type Result,
} from "@earendil-works/pi-durable/env";
import { createReadTool } from "@earendil-works/pi-durable/tools";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { type Overlay, overlayDoc } from "./overlay.ts";

const OverlayDoc = overlayDoc({ defineDoc });

type Skill = ReturnType<typeof loadSkills>["skills"][number];

/** The project instructions and skills that a conversation sees. */
export type Resources = {
	readonly context: readonly { readonly path: string; readonly content: string }[];
	readonly skills: Skill[];
};

/** The overlay of the conversation `id`; undefined for a conversation opened without one. */
export async function overlayOf(read: DocumentReader, id: PromptInput["conversationId"], context: Context) {
	return (await read.snapshot(OverlayDoc, id, context))?.files;
}

/** What the overlay `files` has at `path`: undefined when it does not change the file. */
function overlaid(files: Overlay, path: string): string | null | undefined {
	return Object.hasOwn(files, path) ? files[path] : undefined;
}

/**
 * `loaded` with the overlay `files`: a file that Pi loaded gets its overlay content, or goes away for null. A `SKILL.md`
 * of the overlay that is not on disk adds a skill. A skill whose content has no description is not loaded, as in Pi,
 * and the first skill of a name wins.
 */
export function withOverlay(loaded: Resources, files: Overlay): Resources {
	const context = loaded.context.flatMap((file) => {
		const content = overlaid(files, file.path);

		if (content === undefined) return [file];

		return content === null ? [] : [{ path: file.path, content }];
	});

	const known = new Set(loaded.skills.map(({ filePath }) => filePath));
	const names = new Set<string>();
	const skills: Skill[] = [];

	const candidates = [
		...loaded.skills.map((skill) => {
			const content = overlaid(files, skill.filePath);

			if (content === undefined) return skill;

			return content === null ? undefined : overlaySkill(skill.filePath, content, skill.sourceInfo);
		}),
		...Object.entries(files).flatMap(([path, content]) => {
			if (content === null || basename(path) !== "SKILL.md" || known.has(path) || existsSync(path)) return [];
			const sourceInfo = createSyntheticSourceInfo(path, { source: "overlay", baseDir: dirname(path) });

			return [overlaySkill(path, content, sourceInfo)];
		}),
	];

	for (const skill of candidates) {
		if (skill === undefined || names.has(skill.name)) continue;
		names.add(skill.name);
		skills.push(skill);
	}

	return { context, skills };
}

const SkillFrontmatter = Type.Object({
	name: Type.Optional(Type.String()),
	description: Type.String({ pattern: "\\S" }),
	"disable-model-invocation": Type.Optional(Type.Boolean()),
});

/** The skill of the `SKILL.md` content at `filePath`, as Pi loads it; undefined without a description. */
function overlaySkill(filePath: string, content: string, sourceInfo: SourceInfo): Skill | undefined {
	let frontmatter;

	try {
		({ frontmatter } = parseFrontmatter(content));
	} catch {
		return undefined;
	}

	if (!Value.Check(SkillFrontmatter, frontmatter)) return undefined;
	const baseDir = dirname(filePath);

	return {
		name: frontmatter.name || basename(baseDir),
		description: frontmatter.description,
		filePath,
		baseDir,
		sourceInfo,
		disableModelInvocation: frontmatter["disable-model-invocation"] === true,
	};
}

/** A reader of `bytes`, the overlay content of `path`. */
function memoryReader(path: string, bytes: Uint8Array): BinaryReader {
	return {
		info: async (): Promise<Result<FileInfo, FileError>> =>
			ok({ name: basename(path), path, kind: "file", size: bytes.length, mtimeMs: 0 }),
		read: async (offset, length): Promise<Result<Uint8Array, FileError>> => ok(bytes.subarray(offset, offset + length)),
		scanLines: async ({ startLine, endLine }): Promise<Result<LineScan, FileError>> => {
			let scanner: LineScanner;

			try {
				scanner = new LineScanner(startLine, endLine);
			} catch {
				return err(new FileError("invalid", "Invalid line range", path));
			}

			scanner.push(bytes);

			return ok(scanner.finish());
		},
		close: async () => undefined,
	};
}

/** `env` with the overlay `files` in place of the disk for `exists` and `openBinaryReader`, which `read` uses. */
function overlayEnv(env: ExecutionEnv, files: Overlay): ExecutionEnv {
	const exists: ExecutionEnv["exists"] = async (path, context) => {
		const content = overlaid(files, path);

		return content === undefined ? env.exists(path, context) : ok(content !== null);
	};

	const openBinaryReader: ExecutionEnv["openBinaryReader"] = async (path, options, context) => {
		const content = overlaid(files, path);

		if (content === undefined) return env.openBinaryReader(path, options, context);

		if (content === null) {
			return err(new FileError("not_found", `ENOENT: no such file or directory, open '${path}'`, path));
		}

		return ok(memoryReader(path, new TextEncoder().encode(content)));
	};

	return new Proxy(env, {
		get(target, key) {
			if (key === "exists") return exists;

			if (key === "openBinaryReader") return openBinaryReader;
			// SAFETY: a Proxy of an ExecutionEnv gets only the keys of its users, which are ExecutionEnv keys.
			const value = target[key as keyof ExecutionEnv];

			// Methods run on the environment itself, which can keep private fields.
			return value instanceof Function ? value.bind(target) : value;
		},
	});
}

/** Pi's `read` tool, which sees the conversation's overlay in place of the disk. */
export function overlayRead(): ToolRegistration {
	const read = createReadTool();

	return defineTool({
		...read,
		execute: async (args, api, context) => {
			const files = await overlayOf(api, api.conversationId, context);

			if (files === undefined || api.env === undefined) return read.execute(args, api, context);

			return read.execute(args, { ...api, env: overlayEnv(api.env, files) }, context);
		},
	});
}
