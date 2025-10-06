/**
 * @file Provides utilities for constructing markdown source managers.
 */

import type { SourceRegistry } from "./libs/source-registry";
import { createSourceRegistry } from "./libs/source-registry";
import type {
	MarkdownSource,
	SourceKey,
	SourceRegistrationResult,
} from "./types/source";

export type MarkdownSources = {
	readonly listSources: () => MarkdownSource[];
	readonly getSource: (sourceKey: SourceKey) => MarkdownSource | undefined;
	readonly registerSource: (
		path: string,
		isFile?: boolean,
	) => Promise<SourceRegistrationResult>;
	readonly createSymlink: (
		sourceKey: SourceKey,
	) => Promise<SourceRegistrationResult>;
	readonly resetSources: () => void;
};

/**
 * Builds a markdown source manager around the provided registry.
 */
export const createMarkdownSources = (
	registry: SourceRegistry = createSourceRegistry(),
): MarkdownSources => {
	const listSources = () => registry.listSources();
	const getSource = (sourceKey: SourceKey) => registry.getSource(sourceKey);
	const registerSource = async (path: string, isFile = false) =>
		registry.registerSource(path, isFile);
	const createSymlink = async (sourceKey: SourceKey) =>
		registry.createSymlink(sourceKey);
	const resetSources = () => {
		registry.reset();
	};

	return {
		listSources,
		getSource,
		registerSource,
		createSymlink,
		resetSources,
	};
};
