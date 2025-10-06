/**
 * @file Provides UI helpers for rendering navigation trees for markdown sources.
 */

import type {
	NavigationDirectoryNode,
	NavigationFileNode,
} from "../types/navigation";

/**
 * Builds a link for a navigation node based on its markdown metadata.
 */
export type FileHrefBuilder = (file: NavigationFileNode["file"]) => string;

const renderFileNode = (
	node: NavigationFileNode,
	buildHref: FileHrefBuilder,
): string =>
	`<li class="file"><a href="${buildHref(node.file)}">${node.name}</a></li>`;

const renderDirectoryEntry = (
	directory: NavigationDirectoryNode,
	buildHref: FileHrefBuilder,
): string => {
	const content = renderDirectoryList(directory, buildHref);
	return `<li class="directory"><details><summary>${directory.name}/</summary>${content}</details></li>`;
};

const renderDirectoryList = (
	directory: NavigationDirectoryNode,
	buildHref: FileHrefBuilder,
	className?: string,
): string => {
	const classAttribute = className ? ` class="${className}"` : "";

	const directoryItems = Array.from(directory.directories.values())
		.sort((left, right) => left.name.localeCompare(right.name))
		.map((child) => renderDirectoryEntry(child, buildHref))
		.join("");

	const fileItems = [...directory.files]
		.sort((left, right) => left.name.localeCompare(right.name))
		.map((file) => renderFileNode(file, buildHref))
		.join("");

	return `<ul${classAttribute}>${directoryItems}${fileItems}</ul>`;
};

/**
 * Renders the supplied navigation tree as nested list markup.
 */
export const renderNavigationTree = (
	tree: NavigationDirectoryNode,
	buildHref: FileHrefBuilder,
	className?: string,
): string => renderDirectoryList(tree, buildHref, className);
