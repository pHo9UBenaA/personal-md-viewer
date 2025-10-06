/**
 * @file Provides a dedicated registry factory for managing markdown sources.
 */

import { stat, symlink } from "node:fs/promises";
import { basename, extname } from "node:path";
import { failure, success } from "../types/result";
import {
	DEFAULT_SOURCE_DIRECTORY,
	DEFAULT_SOURCE_KEY,
	DEFAULT_SOURCE_NAME,
	GENERATED_SOURCE_PREFIX,
	type MarkdownSource,
	type SourceKey,
	SourceRegistrationError,
	type SourceRegistrationResult,
	SourceType,
} from "../types/source";
import { resolveProjectPath } from "./directories";

/** Internal shape for registry state. */
type RegistryState = {
	sources: Map<SourceKey, MarkdownSource>;
	nextId: number;
};

const INITIAL_NEXT_ID = 1;

const createDefaultSource = (): MarkdownSource => ({
	key: DEFAULT_SOURCE_KEY,
	name: DEFAULT_SOURCE_NAME,
	rootPath: resolveProjectPath(DEFAULT_SOURCE_DIRECTORY),
	type: SourceType.Directory,
});

const createInitialState = (): RegistryState => ({
	sources: new Map([[DEFAULT_SOURCE_KEY, createDefaultSource()]]),
	nextId: INITIAL_NEXT_ID,
});

/**
 * Builds a generator-style source registry that can be instantiated per consumer.
 */
export const createSourceRegistry = () => {
	let state: RegistryState = createInitialState();

	const buildGeneratedKey = (identifier: number): SourceKey =>
		`${GENERATED_SOURCE_PREFIX}${identifier}`;

	return {
		/** Returns a snapshot array of registered sources. */
		listSources(): MarkdownSource[] {
			return [...state.sources.values()];
		},

		/** Retrieves a single source by key. */
		getSource(sourceKey: SourceKey): MarkdownSource | undefined {
			return state.sources.get(sourceKey);
		},

		/** Registers a new directory or file as a markdown source. */
		async registerSource(
			path: string,
			isFile = false,
		): Promise<SourceRegistrationResult> {
			const absolutePath = resolveProjectPath(path);

			try {
				const stats = await stat(absolutePath);

				if (isFile && !stats.isFile()) {
					return failure(SourceRegistrationError.NotDirectory);
				}

				if (!isFile && !stats.isDirectory()) {
					return failure(SourceRegistrationError.NotDirectory);
				}

				if (isFile) {
					const ext = extname(absolutePath).toLowerCase();
					if (ext !== ".md" && ext !== ".markdown") {
						return failure(SourceRegistrationError.NotDirectory);
					}
				}
			} catch {
				return failure(SourceRegistrationError.StatFailed);
			}

			const generatedKey = buildGeneratedKey(state.nextId);
			const source: MarkdownSource = {
				key: generatedKey,
				name: basename(absolutePath) || absolutePath,
				rootPath: absolutePath,
				type: isFile ? SourceType.File : SourceType.Directory,
			};

			const nextSources = new Map(state.sources);
			nextSources.set(generatedKey, source);

			state = {
				sources: nextSources,
				nextId: state.nextId + 1,
			};

			return success(source);
		},

		/** Creates a symlink in the docs directory pointing to a registered source. */
		async createSymlink(
			sourceKey: SourceKey,
		): Promise<SourceRegistrationResult> {
			const source = state.sources.get(sourceKey);
			if (!source) {
				return failure(SourceRegistrationError.StatFailed);
			}

			const docsPath = resolveProjectPath(DEFAULT_SOURCE_DIRECTORY);
			const linkName = `${source.name}_link`;
			const linkPath = `${docsPath}/${linkName}`;

			try {
				await symlink(source.rootPath, linkPath);

				const generatedKey = buildGeneratedKey(state.nextId);
				const symlinkSource: MarkdownSource = {
					key: generatedKey,
					name: linkName,
					rootPath: linkPath,
					type: SourceType.Symlink,
				};

				const nextSources = new Map(state.sources);
				nextSources.set(generatedKey, symlinkSource);

				state = {
					sources: nextSources,
					nextId: state.nextId + 1,
				};

				return success(symlinkSource);
			} catch {
				return failure(SourceRegistrationError.StatFailed);
			}
		},

		/** Restores the registry to its initial default state. */
		reset(): void {
			state = createInitialState();
		},
	};
};

export type SourceRegistry = ReturnType<typeof createSourceRegistry>;
