/**
 * @file Derives markdown index data composed of sources, files, and navigation trees.
 */

import { buildNavigationTree } from "../navigation";
import type { MarkdownFile } from "../types/markdown";
import type { NavigationDirectoryNode } from "../types/navigation";
import type { MarkdownSource } from "../types/source";
import type { UseMarkdownDocuments } from "./useMarkdownDocuments";
import type { UseMarkdownSources } from "./useMarkdownSources";

export type MarkdownIndexSection = {
	readonly source: MarkdownSource;
	readonly files: MarkdownFile[];
	readonly tree?: NavigationDirectoryNode;
};

export type MarkdownIndexState = {
	readonly sections: MarkdownIndexSection[];
};

export type UseMarkdownIndex = () => Promise<MarkdownIndexState>;

type UseMarkdownIndexDeps = {
	readonly useMarkdownSources: UseMarkdownSources;
	readonly useMarkdownDocuments: UseMarkdownDocuments;
};

/**
 * Produces aggregated data needed to render the markdown index.
 */
export const createUseMarkdownIndex =
	({
		useMarkdownSources,
		useMarkdownDocuments,
	}: UseMarkdownIndexDeps): UseMarkdownIndex =>
	async () => {
		const { sources } = useMarkdownSources();
		const { listFiles } = useMarkdownDocuments();
		const files = await listFiles();

		const sections: MarkdownIndexSection[] = sources.map((source) => {
			const sourceFiles = files.filter((file) => file.sourceKey === source.key);
			const tree =
				sourceFiles.length > 0
					? buildNavigationTree(sourceFiles, source.key)
					: undefined;

			return {
				source,
				files: sourceFiles,
				tree,
			};
		});

		return { sections };
	};
