import {
	documentKeysFromTree,
	findDocuments,
	treeFromDocuments,
} from "./documents.js";
import { createButton } from "./dom.js";

const FILTER_DELAY_MS = 150;

export function initializeTree({
	list,
	filter,
	openMatches,
	matchCount,
	documents,
	getActive,
	activate,
}) {
	const expandedFolders = new Set();
	const filterCollapsedFolders = new Set();
	let filteredKeys = [];
	let query = "";
	let filterTimer = null;
	let composing = false;
	let documentTree = null;
	let renderedTree = null;
	const fileItems = new Map();
	let activeItem = null;

	function redraw() {
		renderedTree = null;
		draw();
	}

	function drawTreeBranch(
		branch,
		parent,
		path = [],
		level = 1,
		filtering = false,
	) {
		for (const [id, child] of branch.directories) {
			const folderPath = [...path, id];
			const folderKey = JSON.stringify(folderPath);
			const folderState = filtering ? filterCollapsedFolders : expandedFolders;
			const expanded = filtering
				? !folderState.has(folderKey)
				: folderState.has(folderKey);
			const folder = document.createElement("div");
			folder.className = "tree-folder";
			const row = document.createElement("div");
			row.className = "tree-folder-row";
			row.textContent = child.name;
			folder.tabIndex = 0;
			folder.dataset.folderKey = folderKey;
			function toggleFolder() {
				if (folderState.has(folderKey)) folderState.delete(folderKey);
				else folderState.add(folderKey);
				redraw();
				[...list.querySelectorAll(".tree-folder")]
					.find((item) => item.dataset.folderKey === folderKey)
					?.focus();
			}
			folder.addEventListener("click", (event) => {
				if (event.target === row) toggleFolder();
			});
			folder.addEventListener("keydown", (event) => {
				if (event.target !== folder) return;
				if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)
					return;
				const shouldToggle =
					event.key === "Enter" ||
					event.key === " " ||
					(event.key === "ArrowRight" && !expanded) ||
					(event.key === "ArrowLeft" && expanded);
				if (!shouldToggle) return;
				event.preventDefault();
				toggleFolder();
			});
			folder.setAttribute("role", "treeitem");
			folder.setAttribute("aria-expanded", String(expanded));
			folder.setAttribute("aria-level", String(level));
			folder.setAttribute("aria-label", `${child.name} フォルダー`);
			const group = document.createElement("div");
			group.setAttribute("role", "group");
			group.hidden = !expanded;
			drawTreeBranch(child, group, folderPath, level + 1, filtering);
			folder.append(row, group);
			parent.append(folder);
		}
		for (const { key, doc, name } of branch.files) {
			const item = createButton(name, () => activate(key), "tree-file");
			item.title = doc.path ?? doc.label;
			item.setAttribute("role", "treeitem");
			item.setAttribute("aria-label", name);
			item.setAttribute("aria-level", String(level));
			item.setAttribute("aria-current", String(getActive() === key));
			fileItems.set(key, item);
			parent.append(item);
		}
	}

	function filterPending() {
		return composing || filter.value.trim() !== query;
	}

	function updateSearchState() {
		const pending = filterPending();
		list.setAttribute("aria-busy", String(pending));
		openMatches.disabled = pending || filteredKeys.length === 0;
	}

	function draw() {
		if (!documentTree) {
			documentTree = treeFromDocuments(findDocuments(documents, query));
			filteredKeys = query ? documentKeysFromTree(documentTree) : [];
			matchCount.hidden = !query;
			matchCount.textContent = `${filteredKeys.length} 件`;
		}
		updateSearchState();
		if (renderedTree !== documentTree) {
			const fragment = document.createDocumentFragment();
			fileItems.clear();
			drawTreeBranch(documentTree, fragment, [], 1, Boolean(query));
			list.replaceChildren(fragment);
			renderedTree = documentTree;
		}
		// Navigation changes only the old and new active rows, not the whole tree.
		const nextItem = fileItems.get(getActive()) ?? null;
		if (activeItem !== nextItem) {
			activeItem?.setAttribute("aria-current", "false");
			nextItem?.setAttribute("aria-current", "true");
			activeItem = nextItem;
		}
	}

	function applyFilter() {
		clearTimeout(filterTimer);
		if (composing) return;
		const nextQuery = filter.value.trim();
		if (nextQuery !== query) {
			query = nextQuery;
			filterCollapsedFolders.clear();
			documentTree = null;
		}
		draw();
	}

	function scheduleFilter() {
		clearTimeout(filterTimer);
		updateSearchState();
		if (!composing) filterTimer = setTimeout(applyFilter, FILTER_DELAY_MS);
	}

	filter.addEventListener("input", scheduleFilter);
	filter.addEventListener("compositionstart", () => {
		composing = true;
		scheduleFilter();
	});
	filter.addEventListener("compositionend", () => {
		composing = false;
		scheduleFilter();
	});
	list.addEventListener("keydown", (event) => {
		if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)
			return;
		if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
		const items = [...list.querySelectorAll('[role="treeitem"]')].filter(
			(item) => !item.closest("[hidden]"),
		);
		if (!items.length) return;
		event.preventDefault();
		const index = items.indexOf(document.activeElement);
		let next;
		if (event.key === "Home") next = 0;
		else if (event.key === "End") next = items.length - 1;
		else {
			const direction = event.key === "ArrowDown" ? 1 : -1;
			next = Math.max(0, Math.min(items.length - 1, index + direction));
		}
		items[next].focus();
	});
	document.addEventListener("keydown", (event) => {
		if (
			!event.metaKey ||
			event.ctrlKey ||
			event.altKey ||
			event.shiftKey ||
			event.key !== "ArrowLeft"
		)
			return;
		const tree = list;
		if (!tree.matches(":hover") && !tree.contains(document.activeElement))
			return;
		event.preventDefault();
		const folders = [...tree.querySelectorAll(".tree-folder")];
		if (!folders.length) return;
		if (query) {
			for (const folder of folders)
				filterCollapsedFolders.add(folder.dataset.folderKey);
		} else expandedFolders.clear();
		const focusKey = [...tree.children].find((folder) =>
			folder.contains(document.activeElement),
		)?.dataset.folderKey;
		redraw();
		if (focusKey)
			[...tree.querySelectorAll(".tree-folder")]
				.find((folder) => folder.dataset.folderKey === focusKey)
				?.focus();
	});
	return {
		draw,
		invalidate: () => {
			documentTree = null;
		},
		matchingKeys: () => (filterPending() ? [] : filteredKeys),
	};
}
