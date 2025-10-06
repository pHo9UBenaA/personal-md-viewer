/**
 * @file Houses helpers for resolving and validating project directories.
 */

import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { Result } from "../types/result";
import { failure, success } from "../types/result";
import { SourceRegistrationError } from "../types/source";

const PROJECT_ROOT = process.cwd();

/**
 * Resolves a project-relative directory path to an absolute path.
 */
export const resolveProjectPath = (directoryPath: string): string =>
	resolve(PROJECT_ROOT, directoryPath);

/**
 * Ensures the provided absolute path refers to an existing directory.
 */
export const ensureDirectoryExists = async (
	directoryPath: string,
): Promise<Result<string, SourceRegistrationError>> => {
	try {
		const directoryStat: Stats = await stat(directoryPath);

		if (!directoryStat.isDirectory()) {
			return failure(SourceRegistrationError.NotDirectory);
		}

		return success(directoryPath);
	} catch {
		return failure(SourceRegistrationError.StatFailed);
	}
};
