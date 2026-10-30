export function findDocuments(documents, query, maxResults = Infinity) {
	const matches = [];
	if (maxResults <= 0) return matches;
	const normalizedQuery = query.trim().toLocaleLowerCase();
	for (const [key, doc] of documents) {
		const searchableText = `${doc.label} ${doc.path ?? ""}`.toLocaleLowerCase();
		if (!searchableText.includes(normalizedQuery)) continue;
		matches.push([key, doc]);
		if (matches.length >= maxResults) break;
	}
	return matches;
}

function getOrCreateDirectory(parent, key, name) {
	if (!parent.directories.has(key))
		parent.directories.set(key, {
			name,
			directories: new Map(),
			files: [],
		});
	return parent.directories.get(key);
}

export function treeFromDocuments(documents) {
	const root = { directories: new Map(), files: [] };
	for (const [key, doc] of documents) {
		const parts = (doc.relativePath ?? doc.label)
			.split(/[\\/]/)
			.filter(Boolean);
		let branch = root;
		for (const part of parts.slice(0, -1))
			branch = getOrCreateDirectory(branch, part, part);
		branch.files.push({ key, doc, name: parts.at(-1) ?? doc.name });
	}
	return sortTree(root);
}

function sortTree(branch) {
	branch.directories = new Map(
		[...branch.directories].sort(([, left], [, right]) =>
			left.name.localeCompare(right.name),
		),
	);
	branch.files.sort((left, right) => left.name.localeCompare(right.name));
	for (const child of branch.directories.values()) sortTree(child);
	return branch;
}

// Include files under collapsed folders, in the same order as the rendered tree.
export function documentKeysFromTree(tree) {
	const keys = [];
	function visit(branch) {
		for (const child of branch.directories.values()) visit(child);
		for (const file of branch.files) keys.push(file.key);
	}
	visit(tree);
	return keys;
}
