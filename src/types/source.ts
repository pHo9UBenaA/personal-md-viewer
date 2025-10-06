/**
 * @file Declares domain types and constants for working with markdown sources.
 */

import type { Result } from "./result";

/** Source keys identify registered markdown roots. */
export type SourceKey = string;

/** Source types to distinguish between directories, files, and symlinks. */
export const SourceType = {
	Directory: "directory",
	File: "file",
	Symlink: "symlink",
} as const;

export type SourceType = (typeof SourceType)[keyof typeof SourceType];

/**
 * Represents a directory that can be traversed for markdown documents.
 */
export type MarkdownSource = {
	readonly key: SourceKey;
	readonly name: string;
	readonly rootPath: string;
	readonly type: SourceType;
};

/** Registration error reasons that callers can handle explicitly. */
export const SourceRegistrationError = {
	NotDirectory: "SOURCE_NOT_DIRECTORY",
	StatFailed: "SOURCE_STAT_FAILED",
} as const;

export type SourceRegistrationError =
	(typeof SourceRegistrationError)[keyof typeof SourceRegistrationError];

/** Result type returned when attempting to register a new source. */
export type SourceRegistrationResult = Result<
	MarkdownSource,
	SourceRegistrationError
>;

/** Constant key for the default docs source. */
export const DEFAULT_SOURCE_KEY = "docs" as const;

/** Human readable name for the default docs source. */
export const DEFAULT_SOURCE_NAME = "docs" as const;

/** Default relative path that contains bundled documentation. */
export const DEFAULT_SOURCE_DIRECTORY = "tests/test_data" as const;

/** Prefix used when generating keys for ad-hoc sources. */
export const GENERATED_SOURCE_PREFIX = "source-" as const;
