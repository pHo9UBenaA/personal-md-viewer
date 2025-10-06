/**
 * @file Supplies markdown discovery, resolution, and rendering utilities built on functional result types.
 */

import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import {
	deriveRelativeMarkdownPath,
	parseDocumentPath,
	resolveWithinSourceRoot,
} from "./libs/markdown-path";
import { renderMarkdownSafe } from "./markdown-safe";
import type { MarkdownSources } from "./sources";
import type { MarkdownFile, MarkdownPathResult } from "./types/markdown";
import { MarkdownPathError } from "./types/markdown";
import { failure, success } from "./types/result";

const MARKDOWN_EXTENSION = ".md" as const;
const FILE_ENCODING_UTF8 = "utf-8" as const;

const fileExists = async (path: string): Promise<boolean> => {
	try {
		const details = await stat(path);
		return details.isFile();
	} catch {
		return false;
	}
};

const isMarkdownFile = (entry: Dirent): boolean =>
	entry.isFile() && entry.name.toLowerCase().endsWith(MARKDOWN_EXTENSION);

const collectMarkdownFilesFromSource = async (
	sourceKey: string,
	sourceRoot: string,
): Promise<MarkdownFile[]> => {
	const discovered: MarkdownFile[] = [];
	const stack: string[] = [sourceRoot];

	while (stack.length > 0) {
		const currentDir = stack.pop();

		if (!currentDir) {
			continue;
		}

		let entries: Dirent[];
		try {
			entries = await readdir(currentDir, { withFileTypes: true });
		} catch (error) {
			console.warn(
				`Failed to read directory ${currentDir} for source ${sourceKey}:`,
				error,
			);
			continue;
		}

		for (const entry of entries) {
			const entryPath = join(currentDir, entry.name);

			if (entry.isDirectory()) {
				stack.push(entryPath);
				continue;
			}

			if (!isMarkdownFile(entry)) {
				continue;
			}

			const absolutePath = entryPath;
			const relativePathResult = deriveRelativeMarkdownPath(
				sourceRoot,
				absolutePath,
			);

			if (!relativePathResult.ok) {
				console.warn(
					`Skipping file outside source root ${absolutePath} for source ${sourceKey}`,
				);
				continue;
			}

			discovered.push({
				sourceKey,
				relativePath: relativePathResult.value,
				absolutePath,
				urlPath: `${sourceKey}/${relativePathResult.value}`,
			});
		}
	}

	discovered.sort((left, right) =>
		left.relativePath.localeCompare(right.relativePath),
	);

	return discovered;
};

export type MarkdownLibrary = {
	readonly resolveMarkdownFile: (
		documentPath: string,
	) => Promise<MarkdownPathResult<MarkdownFile>>;
	readonly renderMarkdownToHtml: (
		documentPath: string,
	) => Promise<MarkdownPathResult<string>>;
	readonly listMarkdownFiles: () => Promise<MarkdownFile[]>;
};

export type MarkdownLibraryDeps = {
	readonly sources: MarkdownSources;
};

/**
 * Builds a markdown helper library bound to the provided source manager.
 */
export const createMarkdownLibrary = ({
	sources,
}: MarkdownLibraryDeps): MarkdownLibrary => {
	const resolveMarkdownFile = async (
		documentPath: string,
	): Promise<MarkdownPathResult<MarkdownFile>> => {
		const parsed = parseDocumentPath(documentPath);

		if (!parsed.ok) {
			return parsed;
		}

		const source = sources.getSource(parsed.value.sourceKey);

		if (!source) {
			return failure(MarkdownPathError.UnknownSource);
		}

		const resolvedPath = resolveWithinSourceRoot(
			source.rootPath,
			parsed.value.relativePath,
		);

		if (!resolvedPath.ok) {
			return resolvedPath;
		}

		const exists = await fileExists(resolvedPath.value);

		if (!exists) {
			return failure(MarkdownPathError.MissingFile);
		}

		return success({
			sourceKey: source.key,
			relativePath: parsed.value.relativePath,
			absolutePath: resolvedPath.value,
			urlPath: `${source.key}/${parsed.value.relativePath}`,
		});
	};

	const renderMarkdownToHtml = async (
		documentPath: string,
	): Promise<MarkdownPathResult<string>> => {
		const resolved = await resolveMarkdownFile(documentPath);

		if (!resolved.ok) {
			return resolved;
		}

		const sourceContent = await readFile(
			resolved.value.absolutePath,
			FILE_ENCODING_UTF8,
		);

		const renderResult = await renderMarkdownSafe(sourceContent);

		if (!renderResult.ok) {
			console.error("Markdown rendering failed:", renderResult.error);
			return failure(MarkdownPathError.MissingFile);
		}

		return success(renderResult.data);
	};

	const listMarkdownFiles = async (): Promise<MarkdownFile[]> => {
		const registeredSources = sources.listSources();
		const aggregated: MarkdownFile[] = [];

		for (const source of registeredSources) {
			const files = await collectMarkdownFilesFromSource(
				source.key,
				source.rootPath,
			);
			aggregated.push(...files);
		}

		return aggregated;
	};

	return {
		resolveMarkdownFile,
		renderMarkdownToHtml,
		listMarkdownFiles,
	};
};
