/**
 * @file Exposes a React-style hook facade for interacting with markdown sources without UI dependencies.
 */

import type { MarkdownSources } from "../sources";
import type {
	MarkdownSource,
	SourceKey,
	SourceRegistrationResult,
} from "../types/source";

/** Snapshot of current markdown sources and associated actions. */
export type MarkdownSourcesState = {
	readonly sources: MarkdownSource[];
	readonly listSources: () => MarkdownSource[];
	readonly registerSource: (
		path: string,
		isFile?: boolean,
	) => Promise<SourceRegistrationResult>;
	readonly createSymlink: (
		sourceKey: SourceKey,
	) => Promise<SourceRegistrationResult>;
	readonly resetSources: () => void;
};

export type UseMarkdownSources = () => MarkdownSourcesState;

/**
 * Provides helpers for querying and mutating markdown source registration.
 */
export const createUseMarkdownSources =
	(sources: MarkdownSources): UseMarkdownSources =>
	() => {
		const listSources = () => sources.listSources();

		return {
			sources: listSources(),
			listSources,
			registerSource: (path: string, isFile = false) =>
				sources.registerSource(path, isFile),
			createSymlink: (sourceKey: SourceKey) => sources.createSymlink(sourceKey),
			resetSources: () => {
				sources.resetSources();
			},
		};
	};
