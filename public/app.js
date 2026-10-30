import {
	documentKeysFromTree,
	findDocuments,
	treeFromDocuments,
} from "./documents.js";
import { initializeReaderSearch } from "./reader-search.js";
import { mapSourceText, sourceRangesForSelection } from "./selection.js";
import { initializeSidebarResize } from "./sidebar.js";
import { initializeTabs } from "./tabs.js";

const $ = (id) => document.getElementById(id);
const token = document.querySelector('meta[name="viewer-token"]').content;
const availableDocuments = new Map();
const tabs = new Map();
const historyTag = "markdown-viewer-copied-v1";
const savedView = history.state?.viewer === historyTag ? history.state : null;
if (!savedView)
	history.replaceState(
		{ viewer: historyTag, active: null, tabs: [], paths: [] },
		"",
	);
let active = null;
// Render revisions discard late reads/images; navigation revisions also cancel opens/restores.
let renderRevision = 0;
let navigationRevision = 0;
let showSource = false;
let busy = false;
let blobUrls = [];
let highlightSelection = null;
let highlightListeners = null;
const expandedFolders = new Set();
const filterCollapsedFolders = new Set();
const readerPositions = new Map();
let displayedView = null;
let readerFocusRevision = null;
const MAX_CACHED_TABS = 10;
const MAX_PAGE_IMAGES = 100;
const MAX_PALETTE_MATCHES = 20;
const BULK_OPEN_CONFIRM_COUNT = 50;
let filteredKeys = [];
let pendingOpenKeys = null;
const closedBatches = [];
const MAX_CLOSED_BATCHES = 20;

const workspace = document.querySelector(".workspace");
initializeSidebarResize({
	workspace,
	sidebar: $("sidebar"),
	resizer: $("sidebar-resizer"),
});

const tabController = initializeTabs({
	element: $("tabs"),
	menu: $("tab-menu"),
	tabs,
	getActive: () => active,
	activate,
	closeTabs,
	reorderTabs,
	reloadTab: (key) => runExclusiveAction(() => reloadTab(key)),
	status,
});

const readerSearch = initializeReaderSearch({
	bar: $("find-bar"),
	input: $("find-query"),
	counter: $("find-count"),
	previous: $("find-previous"),
	next: $("find-next"),
	close: $("find-close"),
	focusReader: focusReaderContent,
});

let theme = document.documentElement.dataset.theme;
function applyTheme(value) {
	theme = value === "dark" ? "dark" : "light";
	document.documentElement.dataset.theme = theme;
	const reader = $("content").contentDocument;
	if (reader?.documentElement) reader.documentElement.dataset.theme = theme;
	const action =
		theme === "dark" ? "ライトモードに切り替える" : "ダークモードに切り替える";
	$("theme-toggle").setAttribute("aria-label", action);
	$("theme-toggle").title = action;
}
applyTheme(theme);
$("theme-toggle").addEventListener("click", () => {
	applyTheme(theme === "dark" ? "light" : "dark");
	try {
		localStorage.setItem("viewer-theme", theme);
	} catch {
		/* Toggle still works without persistence. */
	}
});
window.addEventListener("storage", (event) => {
	if (
		event.key === "viewer-theme" &&
		["dark", "light"].includes(event.newValue)
	)
		applyTheme(event.newValue);
});

function status(message, error = false) {
	$("status").textContent = message;
	$("status").dataset.error = String(error);
}

async function api(route, body = {}, { asBlob = false } = {}) {
	const response = await fetch(`/api/${route}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-Viewer-Token": token },
		body: JSON.stringify(body),
	});
	if (!response.ok) {
		const data = await response.json().catch(() => ({}));
		throw new Error(
			data.error ||
				"リクエストに失敗しました。サーバーを再起動した場合は、このページを再読み込みしてください。",
		);
	}
	return asBlob ? response.blob() : response.json();
}

async function runExclusiveAction(work) {
	if (busy) {
		status("処理中です。完了してから操作してください。");
		return;
	}
	busy = true;
	document.body.setAttribute("aria-busy", "true");
	try {
		await work();
	} catch (error) {
		status(error.message, true);
	} finally {
		busy = false;
		document.body.removeAttribute("aria-busy");
	}
}

function keyFor(doc) {
	return doc.path ?? doc.id;
}

function recordView() {
	navigationRevision++;
	const keys = [...tabs.keys()];
	const previous = history.state;
	if (
		previous?.viewer === historyTag &&
		previous.active === active &&
		previous.tabs.length === keys.length &&
		previous.tabs.every((key, index) => key === keys[index])
	)
		return;
	const paths = [...tabs.values()]
		.filter((doc) => doc.path)
		.map((doc) => ({ path: doc.path, root: doc.root }));
	history.pushState({ viewer: historyTag, active, tabs: keys, paths }, "");
}

async function addDocuments(documents) {
	for (const doc of documents) {
		const key = keyFor(doc);
		if (availableDocuments.has(key))
			Object.assign(availableDocuments.get(key), doc);
		else availableDocuments.set(key, doc);
	}
	if (documents.length) await activate(keyFor(documents[0]));
}

async function openPath(path, recursive) {
	const revision = navigationRevision;
	status("ファイルを探しています…");
	const data = await api("open", { path, recursive });
	if (revision !== navigationRevision) return;
	await addDocuments(data.documents);
	$("palette").close();
}

function button(text, click, className) {
	const node = document.createElement("button");
	node.type = "button";
	node.textContent = text;
	if (className) node.className = className;
	node.addEventListener("click", click);
	return node;
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
			drawNavigation();
			[...$("file-list").querySelectorAll(".tree-folder")]
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
		const item = button(name, () => activate(key), "tree-file");
		item.title = doc.path ?? doc.label;
		item.setAttribute("role", "treeitem");
		item.setAttribute("aria-label", name);
		item.setAttribute("aria-level", String(level));
		item.setAttribute("aria-current", String(active === key));
		parent.append(item);
	}
}

function drawNavigation() {
	$("count").textContent = String(availableDocuments.size);
	$("reopen-closed").disabled = closedBatches.length === 0;
	workspace.dataset.hasDocuments = String(availableDocuments.size > 0);
	tabController.draw();
	$("file-list").replaceChildren();
	const query = $("filter").value.trim();
	const tree = treeFromDocuments(findDocuments(availableDocuments, query));
	filteredKeys = query ? documentKeysFromTree(tree) : [];
	$("open-matches").disabled = filteredKeys.length === 0;
	$("filter-count").hidden = !query;
	$("filter-count").textContent = `${filteredKeys.length} 件`;
	drawTreeBranch(tree, $("file-list"), [], 1, Boolean(query));
	$("empty").hidden = tabs.size > 0;
	$("reader").hidden = tabs.size === 0;
	if (active) {
		$("reader").setAttribute("role", "tabpanel");
		$("reader").setAttribute("aria-labelledby", `tab-${tabs.get(active).id}`);
		document
			.querySelector('[aria-selected="true"]')
			?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}
}

function openMatchingTabs(keys) {
	const additions = keys.filter(
		(key) => availableDocuments.has(key) && !tabs.has(key),
	);
	if (!additions.length) {
		status("検索結果はすべて開いています。");
		return;
	}
	for (const key of additions) tabs.set(key, availableDocuments.get(key));
	if (!active) {
		void activate(additions[0]);
		return;
	}
	// Adding background tabs must not recreate or scroll the current reader.
	drawNavigation();
	recordView();
	status(`${additions.length} 件のタブを追加しました。`);
}

function openFilteredDocuments() {
	if (!filteredKeys.length || $("open-matches-confirm").open) return;
	const additions = filteredKeys.filter((key) => !tabs.has(key));
	if (additions.length < BULK_OPEN_CONFIRM_COUNT) {
		openMatchingTabs(additions);
		return;
	}
	pendingOpenKeys = additions;
	$("open-matches-message").textContent =
		`${additions.length} 件のタブを追加する。本文は実際に表示したときに読み込む。`;
	$("open-matches-confirm").showModal();
	$("open-matches-cancel").focus();
}

function hideHighlightToolbar() {
	highlightSelection = null;
	$("highlight-toolbar").hidden = true;
}

function rememberReaderPosition() {
	if (!displayedView || !tabs.has(displayedView.key)) return;
	const { key, mode, frame } = displayedView;
	const positions = readerPositions.get(key) ?? {};
	positions[mode] = {
		x: frame.contentWindow.scrollX,
		y: frame.contentWindow.scrollY,
	};
	readerPositions.set(key, positions);
}

function focusReaderContent() {
	if (!active) return;
	if (!displayedView || displayedView.frame !== $("content")) {
		readerFocusRevision = renderRevision;
		return;
	}
	readerFocusRevision = null;
	document.getSelection()?.removeAllRanges();
	$("content").contentWindow.focus();
	$("content").contentDocument.body.focus({ preventScroll: true });
}

function setSidebarVisible(visible) {
	document.body.classList.toggle("sidebar-hidden", !visible);
	$("sidebar-toggle").setAttribute("aria-expanded", String(visible));
	$("sidebar-toggle").setAttribute(
		"aria-label",
		visible ? "サイドバーを隠す" : "サイドバーを表示する",
	);
	if (
		!visible &&
		($("sidebar").contains(document.activeElement) ||
			document.activeElement === $("sidebar-resizer"))
	) {
		if (active) focusReaderContent();
		else $("palette-open").focus();
	}
}

function toggleSidebar() {
	if (document.body.classList.contains("focus-mode")) {
		setFocusMode(false);
		setSidebarVisible(true);
	} else setSidebarVisible(document.body.classList.contains("sidebar-hidden"));
}

function toggleSource({ focusReader = false } = {}) {
	showSource = !showSource;
	$("source-toggle").textContent = showSource ? "Preview" : "Raw";
	if (active)
		void activate(active, { preserveTabSelection: true, focusReader });
}

function focusTreeFilter() {
	readerFocusRevision = null;
	setSidebarVisible(true);
	tabController.closeMenu();
	setFocusMode(false);
	$("filter").focus();
	$("filter").select();
}

function cycleTab(direction) {
	const keys = [...tabs.keys()];
	if (!keys.length) return;
	const index = (keys.indexOf(active) + direction + keys.length) % keys.length;
	if (keys[index] === active) {
		tabController.selectOnly(active);
		drawNavigation();
		focusReaderContent();
	} else void activate(keys[index], { focusReader: true });
}

function clearReader() {
	readerSearch.clearDocument();
	rememberReaderPosition();
	displayedView = null;
	readerFocusRevision = null;
	highlightListeners?.abort();
	highlightListeners = null;
	hideHighlightToolbar();
	for (const url of blobUrls) URL.revokeObjectURL(url);
	blobUrls = [];
	$("outline").replaceChildren();
	const frame = document.createElement("iframe");
	frame.id = "content";
	frame.title = "Markdown 本文";
	frame.setAttribute(
		"sandbox",
		"allow-same-origin allow-popups allow-popups-to-escape-sandbox",
	);
	$("content").replaceWith(frame);
}

function watchHighlightSelection(frameDocument, doc, revision) {
	const mapping = mapSourceText(frameDocument, doc.source);
	const frame = frameDocument.defaultView.frameElement;
	const toolbar = $("highlight-toolbar");
	const controller = new AbortController();
	highlightListeners = controller;
	const position = () => {
		if (toolbar.hidden || revision !== renderRevision) return;
		const selection = frameDocument.getSelection();
		if (!selection?.rangeCount || selection.isCollapsed) return;
		const frameRect = frame.getBoundingClientRect();
		const rects = [...selection.getRangeAt(0).getClientRects()].filter(
			(rect) => rect.width && rect.height,
		);
		const rect = rects.at(-1);
		if (!rect || frameRect.bottom < 0 || frameRect.top > innerHeight) return;
		const x = frameRect.left + rect.left + rect.width / 2;
		const top = frameRect.top + rect.top;
		const bottom = frameRect.top + rect.bottom;
		const width = toolbar.offsetWidth;
		const height = toolbar.offsetHeight;
		const viewportMarginPx = 8;
		const selectionGapPx = 10;
		const centeredLeft = x - width / 2;
		const maxLeft = innerWidth - width - viewportMarginPx;
		const aboveSelection = top - height - selectionGapPx;
		const belowSelection = Math.min(
			innerHeight - height - viewportMarginPx,
			bottom + selectionGapPx,
		);
		toolbar.style.left = `${Math.max(viewportMarginPx, Math.min(maxLeft, centeredLeft))}px`;
		toolbar.style.top = `${aboveSelection >= viewportMarginPx ? aboveSelection : belowSelection}px`;
		toolbar.style.visibility =
			bottom < Math.max(0, frameRect.top) ||
			top > Math.min(innerHeight, frameRect.bottom)
				? "hidden"
				: "visible";
	};
	const update = () => {
		if (revision !== renderRevision || showSource) return;
		if (!document.getSelection()?.isCollapsed) {
			hideHighlightToolbar();
			return;
		}
		const selected = sourceRangesForSelection(
			frameDocument.getSelection(),
			mapping,
			doc.source,
		);
		if (!selected) {
			hideHighlightToolbar();
			return;
		}
		highlightSelection = { key: keyFor(doc), revision, ...selected };
		$("highlight-toolbar").hidden = false;
		for (const button of $("highlight-toolbar").querySelectorAll(
			"[data-highlight-color]",
		)) {
			button.setAttribute(
				"aria-pressed",
				String(button.dataset.highlightColor === selected.marker?.color),
			);
		}
		$("highlight-remove").disabled = !selected.marker;
		position();
	};
	frameDocument.defaultView.addEventListener("scroll", position, {
		passive: true,
		signal: controller.signal,
	});
	window.addEventListener("resize", position, { signal: controller.signal });
	const clearSelection = () => {
		frameDocument.getSelection()?.removeAllRanges();
		hideHighlightToolbar();
	};
	document.addEventListener(
		"selectionchange",
		() => {
			if (!document.getSelection()?.isCollapsed) clearSelection();
		},
		{ signal: controller.signal },
	);
	document.addEventListener(
		"focusin",
		(event) => {
			if (!toolbar.contains(event.target) && event.target !== frame)
				clearSelection();
		},
		{ signal: controller.signal },
	);
	frameDocument.addEventListener("pointerdown", () =>
		document.getSelection()?.removeAllRanges(),
	);
	frameDocument.addEventListener("selectionchange", update);
	frameDocument.addEventListener("mouseup", update);
	frameDocument.addEventListener("keyup", update);
	frameDocument.addEventListener("click", (event) => {
		const mark = event.target.closest?.("mark[data-mdv-color]");
		const selection = frameDocument.getSelection();
		if (!mark || mark.closest("a") || !selection?.isCollapsed) return;
		const range = frameDocument.createRange();
		range.selectNodeContents(mark);
		selection.removeAllRanges();
		selection.addRange(range);
		update();
	});
	update();
}

async function applyHighlight(color) {
	const selected = highlightSelection;
	const doc = selected && tabs.get(selected.key);
	if (!doc || selected.revision !== renderRevision || selected.key !== active)
		throw new Error("文章を選択し直してください。");
	const scrollTop = $("content").contentWindow?.scrollY ?? 0;
	let mode = "add";
	if (selected.marker) mode = color ? "recolor" : "remove";
	if (!color && !selected.marker)
		throw new Error("外すマーカーを選択してください。");
	if (mode === "recolor" && color === selected.marker.color) {
		status("この色が選択されています。");
		return;
	}
	const updated = await api("highlight", {
		id: doc.id,
		mode,
		color,
		ranges: mode === "add" ? selected.ranges : undefined,
		marker: selected.marker,
		version: doc.version,
	});
	Object.assign(doc, updated, { loaded: true });
	// Saving may finish after navigation; update the saved document, not the new reader.
	if (selected.revision !== renderRevision || selected.key !== active) return;
	hideHighlightToolbar();
	await activate(selected.key, { scrollTop, preserveTabSelection: true });
	const messagesByMode = {
		add: "マーカーを保存しました。",
		recolor: "マーカーの色を変更しました。",
		remove: "マーカーを外しました。",
	};
	status(messagesByMode[mode]);
}

function closeTabs(closingKeys) {
	const keys = [...tabs.keys()];
	const closing = new Set(closingKeys.filter((key) => tabs.has(key)));
	if (!closing.size) return;
	const focusWasInTabs = $("tabs").contains(document.activeElement);
	const index = keys.indexOf(active);
	const closedDocuments = [];
	for (const [index, key] of keys.entries()) {
		if (!closing.has(key)) continue;
		const doc = tabs.get(key);
		closedDocuments.push({ path: doc.path, root: doc.root, index });
	}
	closedBatches.push({
		active: closing.has(active) ? active : [...closing][0],
		documents: closedDocuments,
	});
	if (closedBatches.length > MAX_CLOSED_BATCHES) closedBatches.shift();
	for (const key of closing) {
		tabs.delete(key);
		readerPositions.delete(key);
	}
	if (!tabs.size) {
		showEmpty("タブを閉じました。ファイル一覧から開き直せます。");
		if (focusWasInTabs) $("filter").focus();
		return;
	}
	if (closing.has(active)) {
		const next =
			keys.slice(index + 1).find((key) => tabs.has(key)) ??
			keys
				.slice(0, index)
				.reverse()
				.find((key) => tabs.has(key));
		void activate(next, { preserveTabSelection: true });
	} else {
		drawNavigation();
		recordView();
	}
	if (focusWasInTabs) document.querySelector('[aria-selected="true"]')?.focus();
}

async function reopenClosedTabs() {
	const batch = closedBatches.at(-1);
	if (!batch) {
		status("復元できるタブはありません。");
		return;
	}
	const revision = navigationRevision;
	const restored = [];
	let failure = "";
	for (const saved of batch.documents) {
		if (tabs.has(saved.path)) continue;
		try {
			// Always revalidate the copy and saved link scope, even if metadata is cached.
			const { document: doc } = await api("restore", {
				path: saved.path,
				root: saved.root,
			});
			if (revision !== navigationRevision) return;
			restored.push({ doc, index: saved.index });
		} catch (error) {
			if (revision !== navigationRevision) return;
			failure ||= error.message;
		}
	}
	const batchIndex = closedBatches.indexOf(batch);
	if (batchIndex >= 0) closedBatches.splice(batchIndex, 1);
	$("reopen-closed").disabled = closedBatches.length === 0;
	if (!restored.length) {
		status(
			failure
				? `タブを復元できませんでした。${failure}`
				: "閉じたタブはすでに開いています。",
			Boolean(failure),
		);
		return;
	}
	const entries = [...tabs.entries()];
	for (const { doc, index } of restored) {
		const key = keyFor(doc);
		const current = availableDocuments.get(key) ?? doc;
		Object.assign(current, doc, { loaded: false });
		delete current.source;
		delete current.html;
		availableDocuments.set(key, current);
		entries.splice(Math.min(index, entries.length), 0, [key, current]);
	}
	tabs.clear();
	for (const [key, doc] of entries) tabs.set(key, doc);
	const target = tabs.has(batch.active)
		? batch.active
		: keyFor(restored[0].doc);
	await activate(target, { focusReader: true });
	if (failure && active === target)
		status(`一部のタブを復元できませんでした。${failure}`, true);
}

function reorderTabs(keys) {
	const current = [...tabs.keys()];
	if (keys.every((key, index) => key === current[index])) return;
	const documents = keys.map((key) => [key, tabs.get(key)]);
	tabs.clear();
	for (const [key, doc] of documents) tabs.set(key, doc);
	drawNavigation();
	recordView();
}

async function reloadTab(key = active) {
	const doc = tabs.get(key);
	if (!doc) return;
	doc.loaded = false;
	await activate(key, {
		preserveTabSelection: key === active,
		scrollTop: key === active ? ($("content").contentWindow?.scrollY ?? 0) : 0,
	});
}

function showEmpty(message, { record = true } = {}) {
	active = null;
	readerSearch.dismiss();
	tabController.selectOnly(null);
	renderRevision++;
	setFocusMode(false);
	clearReader();
	drawNavigation();
	document.title = "Markdown Viewer";
	status(message);
	if (record) recordView();
}

async function restoreView(state) {
	const revision = ++navigationRevision;
	if ($("palette").open) $("palette").close();
	tabs.clear();
	readerPositions.clear();
	showEmpty("履歴から復元しています…", { record: false });
	const paths = new Map((state?.paths ?? []).map((doc) => [doc.path, doc]));
	let missingPaths = 0;
	let restoreError = "";
	for (const key of state?.tabs ?? []) {
		if (revision !== navigationRevision) return;
		let doc = availableDocuments.get(key);
		if (!doc && paths.has(key)) {
			try {
				const saved = paths.get(key);
				doc = (await api("restore", saved)).document;
				if (revision !== navigationRevision) return;
				availableDocuments.set(keyFor(doc), doc);
			} catch (error) {
				missingPaths++;
				restoreError ||= error.message;
			}
		}
		if (doc) tabs.set(keyFor(doc), doc);
	}
	if (revision !== navigationRevision) return;
	const selected =
		state?.active && tabs.has(state.active)
			? state.active
			: [...tabs.keys()].at(-1);
	if (selected) {
		await activate(selected, { record: false });
		if (revision !== navigationRevision) return;
		if (missingPaths)
			status(`履歴の一部を復元できませんでした。${restoreError}`, true);
		return;
	}
	let message = "pnpm copy-docs で content/ にコピーしてから開いてください。";
	if (missingPaths)
		message = `履歴のパスを復元できませんでした。${restoreError}`;
	else if (availableDocuments.size) message = "ファイル一覧から選択できます。";
	showEmpty(message, { record: false });
}

window.addEventListener("popstate", (event) => {
	if (event.state && event.state.viewer !== historyTag) return;
	void restoreView(event.state);
});

async function followLink(doc, href) {
	const revision = navigationRevision;
	const data = await api("related", { id: doc.id, href });
	if (revision !== navigationRevision) return;
	await addDocuments(data.documents);
	if (href.includes("#"))
		await activate(keyFor(data.documents[0]), { hash: href.split("#")[1] });
}

function jumpTo(frameDocument, hash) {
	try {
		frameDocument.getElementById(decodeURIComponent(hash))?.scrollIntoView();
	} catch {
		status("見出しリンクの形式が不正です。", true);
	}
}

function buildOutline(frameDocument) {
	const usedHeadingIds = new Set();
	for (const heading of frameDocument.querySelectorAll("h1,h2,h3,h4,h5,h6")) {
		const base =
			heading.textContent
				.toLocaleLowerCase()
				.trim()
				.replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
				.replace(/\s/g, "-") || "section";
		let slug = base;
		let suffix = 0;
		while (usedHeadingIds.has(slug)) slug = `${base}-${++suffix}`;
		usedHeadingIds.add(slug);
		heading.id = slug;
		const item = button(heading.textContent, () =>
			heading.scrollIntoView({ behavior: "smooth" }),
		);
		$("outline").append(item);
	}
}

function enableReaderLinks(frameDocument, doc) {
	for (const link of frameDocument.querySelectorAll("a[data-link]")) {
		const href = link.dataset.link;
		if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) {
			link.href = href;
			link.target = "_blank";
			link.rel = "noopener noreferrer";
		} else {
			link.href = "#";
			link.addEventListener("click", (event) => {
				event.preventDefault();
				if (href.startsWith("#")) jumpTo(frameDocument, href.slice(1));
				else runExclusiveAction(() => followLink(doc, href));
			});
		}
	}
}

// Sequential, bounded image loading avoids a burst of hundreds of requests.
async function loadReaderImages(frameDocument, doc, revision) {
	let imageCount = 0;
	for (const img of frameDocument.querySelectorAll("img[data-image]")) {
		if (revision !== renderRevision) return;
		const href = img.dataset.image;
		try {
			if (++imageCount > MAX_PAGE_IMAGES)
				throw new Error("画像は 1 ページ 100 件までです。");
			if (/^(?:[a-z][a-z\d+.-]*:|\/|\\)/i.test(href))
				throw new Error("外部画像・絶対パス画像は読み込みません。");
			const blob = await api("image", { id: doc.id, href }, { asBlob: true });
			if (revision !== renderRevision) return;
			const url = URL.createObjectURL(blob);
			blobUrls.push(url);
			img.src = url;
		} catch (error) {
			const note = frameDocument.createElement("span");
			note.className = "image-note";
			note.textContent = `[${img.alt || "画像"}: ${error.message}]`;
			img.replaceWith(note);
		}
	}
}

async function loadDocumentContent(doc) {
	if (doc.loaded) return;
	Object.assign(doc, await api("read", { id: doc.id }));
	doc.loaded = true;
}

function evictOldTabContent(currentDoc) {
	// Retain content only for recently viewed tabs; metadata remains available.
	currentDoc.lastViewed = Date.now();
	const cached = [...tabs.values()]
		.filter((doc) => doc.loaded)
		.sort((left, right) => right.lastViewed - left.lastViewed);
	for (const doc of cached.slice(MAX_CACHED_TABS)) {
		if (doc === currentDoc) continue;
		delete doc.html;
		delete doc.source;
		doc.loaded = false;
	}
}

function createReaderFrame(doc, revision, { hash, scrollTop, scrollLeft }) {
	const sourceMode = showSource;
	const frame = document.createElement("iframe");
	frame.id = "content";
	frame.title = "Markdown 本文";
	frame.setAttribute(
		"sandbox",
		"allow-same-origin allow-scripts allow-popups allow-popups-to-escape-sandbox",
	);
	let content = doc.html;
	if (sourceMode) {
		const pre = document.createElement("pre");
		pre.className = "source";
		pre.textContent = doc.source;
		content = pre.outerHTML;
	}
	frame.onload = async () => {
		if (revision !== renderRevision) return;
		const readerDocument = frame.contentDocument;
		// Restore pixels only after local fonts finish layout, avoiding scroll anchoring jumps.
		await readerDocument.fonts.ready;
		if (revision !== renderRevision) return;
		readerDocument.documentElement.dataset.theme = theme;
		readerDocument.body.tabIndex = -1;
		displayedView = {
			key: keyFor(doc),
			mode: sourceMode ? "raw" : "preview",
			frame,
		};
		readerDocument.addEventListener("keydown", shortcuts);
		readerDocument.addEventListener("pointerdown", () =>
			tabController.closeMenu(),
		);
		preventFileDrop(readerDocument);
		if (!sourceMode) {
			watchHighlightSelection(readerDocument, doc, revision);
			buildOutline(readerDocument);
			enableReaderLinks(readerDocument, doc);
			if (hash) jumpTo(readerDocument, hash);
			loadReaderImages(readerDocument, doc, revision).catch((error) =>
				status(error.message, true),
			);
		}
		readerSearch.setDocument(readerDocument, keyFor(doc));
		if (!hash) frame.contentWindow.scrollTo(scrollLeft, scrollTop);
		if (readerFocusRevision === revision) focusReaderContent();
	};
	// WebKit needs allow-scripts for parent-installed listeners; the document CSP forbids execution.
	frame.srcdoc = `<!doctype html>
<html lang="ja" data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'self'; font-src 'self'; img-src blob:; base-uri 'none'; form-action 'none'">
<link rel="stylesheet" href="${location.origin}/reader.css">
</head>
<body>${content}</body>
</html>`;
	return frame;
}

async function activate(
	key,
	{
		hash,
		record = true,
		scrollTop,
		preserveTabSelection = false,
		focusReader = false,
	} = {},
) {
	const doc = availableDocuments.get(key);
	if (!doc) return;
	tabs.set(key, doc);
	active = key;
	if (!preserveTabSelection) tabController.selectOnly(key);
	if (record) recordView();
	const revision = ++renderRevision;
	clearReader();
	if (focusReader) readerFocusRevision = revision;
	const position = readerPositions.get(key)?.[
		showSource ? "raw" : "preview"
	] ?? { x: 0, y: 0 };
	drawNavigation();
	$("document-path").textContent = doc.path;
	$("document-path").title = doc.path;
	$("reload").title = "コピーから読み直す";
	document.title = `${doc.name} — Markdown Viewer`;
	status("読み込み中…");
	try {
		await loadDocumentContent(doc);
		if (revision !== renderRevision) return;
		evictOldTabContent(doc);
		$("content").replaceWith(
			createReaderFrame(doc, revision, {
				hash,
				scrollTop: scrollTop ?? position.y,
				scrollLeft: position.x,
			}),
		);
		if (revision === renderRevision)
			status(
				"コピーを閲覧中（マーカーはコピーに保存し、元ファイルは変更しない）。",
			);
	} catch (error) {
		if (revision === renderRevision) status(error.message, true);
	}
}

let paletteIndex = 0;
let paletteMatches = [];

function updatePalette() {
	const query = $("command").value.trim();
	paletteMatches = query
		? findDocuments(availableDocuments, query, MAX_PALETTE_MATCHES)
		: [];
	paletteIndex = Math.min(paletteIndex, Math.max(0, paletteMatches.length - 1));
	$("results").replaceChildren(
		...paletteMatches.map(([key, doc], index) => {
			const node = button(doc.path ?? doc.label, () => {
				$("palette").close();
				activate(key);
			});
			node.dataset.selected = String(index === paletteIndex);
			return node;
		}),
	);
}

function openPalette() {
	if (!$("palette").open) $("palette").showModal();
	$("command").value = "";
	paletteIndex = 0;
	updatePalette();
	$("command").focus();
}
function setFocusMode(enabled) {
	if (enabled && !active) return;
	document.body.classList.toggle("focus-mode", enabled);
	$("focus-toggle").setAttribute("aria-pressed", String(enabled));
	$("focus-toggle").textContent = enabled ? "通常表示" : "全画面表示";
	$("focus-toggle").title = enabled
		? "通常表示に戻す (Esc / ⌘⇧F / Ctrl+Shift+F)"
		: "全画面表示 (⌘⇧F / Ctrl+Shift+F)";
}
function shortcuts(event) {
	if (event.defaultPrevented || event.isComposing || event.keyCode === 229)
		return;
	const key = event.key.toLowerCase();
	const dialogOpen = Boolean(document.querySelector("dialog[open]"));
	const editable =
		event.target.isContentEditable ||
		event.target.closest?.("input, textarea, select");
	const isCommand = (event.metaKey || event.ctrlKey) && !event.altKey;
	if (isCommand && !event.shiftKey && key === "p") {
		event.preventDefault();
		if (!dialogOpen) openPalette();
		return;
	}
	if (isCommand && !event.shiftKey && key === "b" && !editable) {
		event.preventDefault();
		if (!dialogOpen && !event.repeat) toggleSidebar();
		return;
	}
	if (isCommand && event.shiftKey && key === "t") {
		event.preventDefault();
		if (!dialogOpen && !event.repeat) void runExclusiveAction(reopenClosedTabs);
		return;
	}
	if (isCommand && event.shiftKey && key === "v" && !editable) {
		event.preventDefault();
		if (!dialogOpen && active && !event.repeat)
			toggleSource({ focusReader: true });
		return;
	}
	if (isCommand && !event.shiftKey && key === "f") {
		event.preventDefault();
		if (!dialogOpen && active) readerSearch.open();
		return;
	}
	if (isCommand && key === "g") {
		event.preventDefault();
		if (!dialogOpen && active) readerSearch.step(event.shiftKey ? -1 : 1);
		return;
	}
	const controlOnly = event.ctrlKey && !event.metaKey && !event.altKey;
	if (controlOnly && key === "tab") {
		event.preventDefault();
		if (!dialogOpen) cycleTab(event.shiftKey ? -1 : 1);
		return;
	}
	// JIS has an @ key; US layouts use Shift+2. Do not bind Ctrl+[ on US layouts.
	if (
		controlOnly &&
		(key === "@" || (event.code === "Digit2" && event.shiftKey))
	) {
		event.preventDefault();
		if (!dialogOpen && !event.repeat) {
			if (document.activeElement === $("filter") && active)
				focusReaderContent();
			else focusTreeFilter();
		}
		return;
	}
	if (isCommand && !event.shiftKey && (key === "w" || event.code === "KeyW")) {
		event.preventDefault();
		if (!event.repeat && !dialogOpen) closeTabs(tabController.selectedKeys());
		return;
	}
	if (isCommand && !event.shiftKey && (key === "r" || event.code === "KeyR")) {
		event.preventDefault();
		if (!event.repeat && !dialogOpen)
			void runExclusiveAction(() => reloadTab());
		return;
	}
	if (
		key === "/" &&
		!event.metaKey &&
		!event.ctrlKey &&
		!event.altKey &&
		!editable &&
		!dialogOpen
	) {
		event.preventDefault();
		focusTreeFilter();
		return;
	}
	const isCommandShift =
		(event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey;
	if (isCommandShift && key === "f") {
		event.preventDefault();
		if (!active || dialogOpen) return;
		tabController.closeMenu();
		setFocusMode(!document.body.classList.contains("focus-mode"));
		return;
	}
	if (event.key === "Escape" && !dialogOpen) {
		if (!$("highlight-toolbar").hidden) {
			$("content").contentWindow?.getSelection()?.removeAllRanges();
			hideHighlightToolbar();
			return;
		}
		if (readerSearch.isOpen()) readerSearch.dismiss();
		else setFocusMode(false);
		return;
	}
	if (isCommandShift && key === "p") {
		event.preventDefault();
		if (!dialogOpen || $("palette").open) openPalette();
	}
}
document.addEventListener("keydown", shortcuts);
$("palette-open").addEventListener("click", openPalette);
$("sidebar-toggle").addEventListener("click", toggleSidebar);
$("reopen-closed").addEventListener("click", () =>
	runExclusiveAction(reopenClosedTabs),
);
$("focus-toggle").addEventListener("click", () => {
	setFocusMode(!document.body.classList.contains("focus-mode"));
});
$("palette-close").addEventListener("click", () => $("palette").close());
$("command").addEventListener("input", () => {
	paletteIndex = 0;
	updatePalette();
});
$("command").addEventListener("keydown", (event) => {
	if (event.key === "ArrowDown" || event.key === "ArrowUp") {
		event.preventDefault();
		paletteIndex = Math.max(
			0,
			Math.min(
				paletteMatches.length - 1,
				paletteIndex + (event.key === "ArrowDown" ? 1 : -1),
			),
		);
		updatePalette();
	}
});
$("palette-form").addEventListener("submit", (event) => {
	event.preventDefault();
	const value = $("command").value.trim();
	if (!value) return;
	if (paletteMatches.length && !/^(?:\/|~|\.|[a-z]:[\\/])/i.test(value)) {
		$("palette").close();
		activate(paletteMatches[paletteIndex][0]);
	} else
		runExclusiveAction(() => openPath(value, $("palette-recursive").checked));
});
$("open-matches").addEventListener("click", openFilteredDocuments);
$("open-matches-cancel").addEventListener("click", () =>
	$("open-matches-confirm").close(),
);
$("open-matches-accept").addEventListener("click", () => {
	const keys = pendingOpenKeys ?? [];
	pendingOpenKeys = null;
	$("open-matches-confirm").close();
	openMatchingTabs(keys);
});
$("open-matches-confirm").addEventListener("close", () => {
	pendingOpenKeys = null;
});
$("filter").addEventListener("input", () => {
	filterCollapsedFolders.clear();
	drawNavigation();
});
$("file-list").addEventListener("keydown", (event) => {
	if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
	if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
	const items = [
		...$("file-list").querySelectorAll('[role="treeitem"]'),
	].filter((item) => !item.closest("[hidden]"));
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
	const tree = $("file-list");
	if (!tree.matches(":hover") && !tree.contains(document.activeElement)) return;
	event.preventDefault();
	const folders = [...tree.querySelectorAll(".tree-folder")];
	if (!folders.length) return;
	if ($("filter").value.trim()) {
		for (const folder of folders)
			filterCollapsedFolders.add(folder.dataset.folderKey);
	} else expandedFolders.clear();
	const focusKey = [...tree.children].find((folder) =>
		folder.contains(document.activeElement),
	)?.dataset.folderKey;
	drawNavigation();
	if (focusKey)
		[...tree.querySelectorAll(".tree-folder")]
			.find((folder) => folder.dataset.folderKey === focusKey)
			?.focus();
});
$("close-all").addEventListener("click", () => closeTabs([...tabs.keys()]));
$("reload").addEventListener("click", () =>
	runExclusiveAction(() => reloadTab()),
);
$("source-toggle").addEventListener("click", () => toggleSource());
document.addEventListener("focusin", (event) => {
	if (event.target !== $("content")) readerFocusRevision = null;
});
document.addEventListener("pointerdown", (event) => {
	readerFocusRevision = null;
	if (!$("highlight-toolbar").contains(event.target)) {
		$("content").contentWindow?.getSelection()?.removeAllRanges();
		hideHighlightToolbar();
	}
});
$("highlight-toolbar").addEventListener("click", (event) => {
	if (event.target.closest("#highlight-remove")) {
		runExclusiveAction(() => applyHighlight(null));
		return;
	}
	const color = event.target.closest("[data-highlight-color]")?.dataset
		.highlightColor;
	if (color) runExclusiveAction(() => applyHighlight(color));
});
function preventFileDrop(target) {
	target.addEventListener("dragover", (event) => event.preventDefault());
	target.addEventListener("drop", (event) => {
		event.preventDefault();
		status(
			"ファイルのドロップは利用できません。pnpm copy-docs でコピーしてください。",
			true,
		);
	});
}
preventFileDrop(document);
runExclusiveAction(async () => {
	if (savedView) {
		await restoreView(savedView);
		const data = await api("initial");
		for (const doc of data.documents) {
			const key = keyFor(doc);
			if (!availableDocuments.has(key)) availableDocuments.set(key, doc);
		}
		drawNavigation();
		return;
	}
	const revision = navigationRevision;
	const documentId = new URLSearchParams(location.hash.slice(1)).get(
		"document",
	);
	if (documentId) {
		const doc = await api("read", { id: documentId });
		if (revision !== navigationRevision) return;
		await addDocuments([{ ...doc, loaded: true }]);
		return;
	}
	const data = await api("initial");
	if (revision !== navigationRevision) return;
	if (data.documents.length) await addDocuments(data.documents);
	else status("pnpm copy-docs で content/ にコピーしてから開いてください。");
});
