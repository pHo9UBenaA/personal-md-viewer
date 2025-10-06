import type { UseMarkdownDocuments } from "../hooks/useMarkdownDocuments";
import { createUseMarkdownDocuments } from "../hooks/useMarkdownDocuments";
import type { UseMarkdownIndex } from "../hooks/useMarkdownIndex";
import { createUseMarkdownIndex } from "../hooks/useMarkdownIndex";
import type { UseMarkdownSources } from "../hooks/useMarkdownSources";
import { createUseMarkdownSources } from "../hooks/useMarkdownSources";
import type { SourceRegistry } from "../libs/source-registry";
import { createSourceRegistry } from "../libs/source-registry";
import type { MarkdownLibrary } from "../markdown";
import { createMarkdownLibrary } from "../markdown";
import type { MarkdownSources } from "../sources";
import { createMarkdownSources } from "../sources";
import type { Viewer } from "../ui/viewer";
import { createViewer } from "../ui/viewer";

export type MarkdownViewerEnvironment = {
	readonly registry: SourceRegistry;
	readonly sources: MarkdownSources;
	readonly markdown: MarkdownLibrary;
	readonly useMarkdownSources: UseMarkdownSources;
	readonly useMarkdownDocuments: UseMarkdownDocuments;
	readonly useMarkdownIndex: UseMarkdownIndex;
} & Viewer;

/**
 * Builds an isolated markdown viewer environment with fresh state.
 */
export const createMarkdownViewerEnvironment =
	(): MarkdownViewerEnvironment => {
		const registry = createSourceRegistry();
		const sources = createMarkdownSources(registry);
		const markdown = createMarkdownLibrary({ sources });
		const useMarkdownSources = createUseMarkdownSources(sources);
		const useMarkdownDocuments = createUseMarkdownDocuments(markdown);
		const useMarkdownIndex = createUseMarkdownIndex({
			useMarkdownSources,
			useMarkdownDocuments,
		});
		const viewer = createViewer({
			useMarkdownDocuments,
			useMarkdownIndex,
		});

		return {
			registry,
			sources,
			markdown,
			useMarkdownSources,
			useMarkdownDocuments,
			useMarkdownIndex,
			...viewer,
		};
	};
