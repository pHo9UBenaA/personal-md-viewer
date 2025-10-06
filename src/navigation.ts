/**
 * @file Houses navigation tree construction so it can be shared without UI coupling.
 */

import type { MarkdownFile } from "./types/markdown";
import type { NavigationDirectoryNode } from "./types/navigation";

const DIRECTORY_SEPARATOR = "/" as const;

const createDirectoryNode = (
	name: string,
	path: string,
): NavigationDirectoryNode => ({
	name,
	path,
	directories: new Map(),
	files: [],
});

/**
 * Builds a hierarchical navigation tree for the provided markdown files.
 */
export const buildNavigationTree = (
	files: MarkdownFile[],
	rootPath: string,
): NavigationDirectoryNode => {
	const root = createDirectoryNode("", rootPath);

	for (const file of files) {
		const segments = file.relativePath.split(DIRECTORY_SEPARATOR);
		const fileName = segments.at(-1);

		if (!fileName) {
			continue;
		}

		let current = root;

		for (let index = 0; index < segments.length - 1; index += 1) {
			const segment = segments[index];

			if (!segment) {
				continue;
			}

			const nextPath = `${current.path}${DIRECTORY_SEPARATOR}${segment}`;
			let directory = current.directories.get(segment);

			if (!directory) {
				directory = createDirectoryNode(segment, nextPath);
				current.directories.set(segment, directory);
			}

			current = directory;
		}

		current.files.push({
			name: fileName,
			file,
		});
	}

	return root;
};
