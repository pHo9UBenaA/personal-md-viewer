/**
 * @file Declares markdown-centric domain types shared across modules.
 */

import type { Result } from "./result";
import type { SourceKey } from "./source";

/**
 * Allowed HTML tag name for safe rendering.
 */
export type AllowedHtmlTag =
	| "details"
	| "summary"
	| "a"
	| "p"
	| "ul"
	| "li"
	| "strong"
	| "em"
	| "code"
	| "pre"
	| "span"
	| "div";

/**
 * Result type for Markdown rendering.
 */
export type RenderMarkdownResult =
	| { ok: true; data: string }
	| { ok: false; error: Error };

/** Normalised POSIX-style relative path within a source directory. */
export type MarkdownRelativePath = string;

/** Fully qualified path to a markdown document on disk. */
export type MarkdownAbsolutePath = string;

/**
 * Represents a markdown document discovered on disk.
 */
export type MarkdownFile = {
	readonly sourceKey: SourceKey;
	readonly relativePath: MarkdownRelativePath;
	readonly absolutePath: MarkdownAbsolutePath;
	readonly urlPath: string;
};

/** Description of a requested document combined with its original URL path. */
export type MarkdownDocumentRequest = {
	readonly sourceKey: SourceKey;
	readonly relativePath: MarkdownRelativePath;
};

/** Path resolutions may fail for a known reason. */
export const MarkdownPathError = {
	InvalidFormat: "MARKDOWN_PATH_INVALID_FORMAT",
	UnknownSource: "MARKDOWN_PATH_UNKNOWN_SOURCE",
	PathTraversal: "MARKDOWN_PATH_TRAVERSAL_DETECTED",
	EscapedSource: "MARKDOWN_PATH_ESCAPED_SOURCE",
	MissingFile: "MARKDOWN_PATH_MISSING_FILE",
} as const;

export type MarkdownPathError =
	(typeof MarkdownPathError)[keyof typeof MarkdownPathError];

/**
 * Result discriminant returned when resolving or loading markdown content.
 */
export type MarkdownPathResult<TValue> = Result<TValue, MarkdownPathError>;
