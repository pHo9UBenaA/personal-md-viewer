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
		const parts = doc.label.split(/[\\/]/).filter(Boolean);
		let branch = root;
		if (doc.root) {
			const rootName =
				doc.root.split(/[\\/]/).filter(Boolean).at(-1) ?? doc.root;
			// Equal folder names in different roots must remain separate branches.
			branch = getOrCreateDirectory(branch, `root:${doc.root}`, rootName);
		}
		for (const part of parts.slice(0, -1))
			branch = getOrCreateDirectory(branch, part, part);
		branch.files.push({ key, doc, name: parts.at(-1) ?? doc.name });
	}
	return root;
}
