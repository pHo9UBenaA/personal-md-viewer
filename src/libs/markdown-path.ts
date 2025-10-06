/**
 * @file Centralises markdown document path parsing and safety checks.
 */

import { relative, resolve, sep } from "node:path";
import type {
	MarkdownDocumentRequest,
	MarkdownPathResult,
} from "../types/markdown";
import { MarkdownPathError } from "../types/markdown";
import { failure, success } from "../types/result";

const PATH_SEGMENT_SEPARATOR = "/" as const;
const PATH_TRAVERSAL_TOKEN = ".." as const;

const normaliseToPosix = (value: string): string =>
	value.split(sep).join(PATH_SEGMENT_SEPARATOR);

const escapesRoot = (root: string, target: string): boolean => {
	const difference = relative(root, target);

	return difference === "" || difference.startsWith(PATH_TRAVERSAL_TOKEN);
};

/**
 * Parses a URL style markdown path into a structured document request.
 */
export const parseDocumentPath = (
	documentPath: string,
): MarkdownPathResult<MarkdownDocumentRequest> => {
	const [sourceKey, ...rawSegments] = documentPath.split(
		PATH_SEGMENT_SEPARATOR,
	);

	if (!sourceKey || rawSegments.length === 0) {
		return failure(MarkdownPathError.InvalidFormat);
	}

	if (rawSegments.some((segment) => segment.length === 0)) {
		return failure(MarkdownPathError.InvalidFormat);
	}

	if (rawSegments.some((segment) => segment === PATH_TRAVERSAL_TOKEN)) {
		return failure(MarkdownPathError.PathTraversal);
	}

	return success({
		sourceKey,
		relativePath: rawSegments.join(PATH_SEGMENT_SEPARATOR),
	});
};

const ensureNormalisedRoot = (sourceRoot: string): string =>
	resolve(sourceRoot);

/**
 * Resolves a relative markdown path against a source root while ensuring it stays inside the source.
 */
export const resolveWithinSourceRoot = (
	sourceRoot: string,
	relativePath: string,
): MarkdownPathResult<string> => {
	const root = ensureNormalisedRoot(sourceRoot);
	const target = resolve(root, relativePath);

	if (escapesRoot(root, target)) {
		return failure(MarkdownPathError.EscapedSource);
	}

	return success(target);
};

/**
 * Converts an absolute path to a POSIX-style relative path anchored at the source root.
 */
export const deriveRelativeMarkdownPath = (
	sourceRoot: string,
	absolutePath: string,
): MarkdownPathResult<string> => {
	const root = ensureNormalisedRoot(sourceRoot);
	const target = resolve(absolutePath);

	if (escapesRoot(root, target)) {
		return failure(MarkdownPathError.EscapedSource);
	}

	return success(normaliseToPosix(relative(root, target)));
};
