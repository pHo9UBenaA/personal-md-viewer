/**
 * @file Supplies hook-style helpers for working with markdown documents and their rendered output.
 */

import type { MarkdownLibrary } from "../markdown";
import type { MarkdownFile, MarkdownPathResult } from "../types/markdown";

export type MarkdownDocumentsState = {
	readonly listFiles: () => Promise<MarkdownFile[]>;
	readonly resolveDocument: (
		documentPath: string,
	) => Promise<MarkdownPathResult<MarkdownFile>>;
	readonly renderDocument: (
		documentPath: string,
	) => Promise<MarkdownPathResult<string>>;
};

export type UseMarkdownDocuments = () => MarkdownDocumentsState;

/**
 * Gathers reusable markdown document helpers behind a React-inspired hook facade.
 */
export const createUseMarkdownDocuments =
	(markdown: MarkdownLibrary): UseMarkdownDocuments =>
	() => ({
		listFiles: () => markdown.listMarkdownFiles(),
		resolveDocument: (documentPath: string) =>
			markdown.resolveMarkdownFile(documentPath),
		renderDocument: (documentPath: string) =>
			markdown.renderMarkdownToHtml(documentPath),
	});
