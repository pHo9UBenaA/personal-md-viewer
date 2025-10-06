/**
 * @file Provides types that describe the navigation tree rendered on the index page.
 */

import type { MarkdownFile } from "./markdown";

/** Node that represents a markdown file entry within the tree. */
export type NavigationFileNode = {
	readonly name: string;
	readonly file: MarkdownFile;
};

/** Directory node with nested folders and files. */
export type NavigationDirectoryNode = {
	readonly name: string;
	readonly path: string;
	readonly directories: Map<string, NavigationDirectoryNode>;
	readonly files: NavigationFileNode[];
};
