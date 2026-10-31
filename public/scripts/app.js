import { byId } from "./dom.js";
import { initializeHighlightToolbar } from "./highlight-toolbar.js";
import { initializeNotices } from "./notices.js";
import { initializePalette } from "./palette.js";
import { initializeReader } from "./reader.js";
import { initializeReaderSearch } from "./reader-search.js";
import { createShortcutHandler } from "./shortcuts.js";
import { initializeSidebarResize } from "./sidebar.js";
import { activeTabAfterClosing, initializeTabs } from "./tabs.js";
import { initializeTree } from "./tree.js";

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
const readerPositions = new Map();
const MAX_CACHED_TABS = 10;
const BULK_OPEN_CONFIRM_COUNT = 50;
let pendingOpenKeys = null;
const closedBatches = [];
const MAX_CLOSED_BATCHES = 20;
const showNotices = document.body.dataset.showNotices !== "false";

const workspace = document.querySelector(".workspace");
const { status, showCopyNotice } = initializeNotices({
	container: byId("notices"),
	region: byId("status-region"),
	showNotices,
	onClose: () => {
		if (active) focusReaderContent();
		else byId("palette-open").focus({ preventScroll: true });
	},
});
const { open: openPalette } = initializePalette({
	dialog: byId("palette"),
	input: byId("command"),
	results: byId("results"),
	recursive: byId("palette-recursive"),
	form: byId("palette-form"),
	close: byId("palette-close"),
	documents: availableDocuments,
	activate,
	openPath,
	runAction: runExclusiveAction,
});
const treeController = initializeTree({
	list: byId("file-list"),
	filter: byId("filter"),
	openMatches: byId("open-matches"),
	matchCount: byId("filter-count"),
	documents: availableDocuments,
	getActive: () => active,
	activate,
});
initializeSidebarResize({
	workspace,
	sidebar: byId("sidebar"),
	resizer: byId("sidebar-resizer"),
});

const tabController = initializeTabs({
	element: byId("tabs"),
	menu: byId("tab-menu"),
	tabs,
	getActive: () => active,
	activate,
	closeTabs,
	reorderTabs,
	reloadTab: (key) => runExclusiveAction(() => reloadTab(key)),
	status,
});

const readerSearch = initializeReaderSearch({
	bar: byId("find-bar"),
	input: byId("find-query"),
	counter: byId("find-count"),
	previous: byId("find-previous"),
	next: byId("find-next"),
	close: byId("find-close"),
	focusReader: focusReaderContent,
});

const highlightToolbar = initializeHighlightToolbar({
	toolbar: byId("highlight-toolbar"),
	remove: byId("highlight-remove"),
	getFrame: () => byId("content"),
	isCurrent: (revision) => revision === renderRevision,
	isSourceMode: () => showSource,
	onApply: (color) => runExclusiveAction(() => applyHighlight(color)),
});
const reader = initializeReader({
	container: byId("reader"),
	loading: byId("reader-loading"),
	outline: byId("outline"),
	search: readerSearch,
	highlights: highlightToolbar,
	getTheme: () => theme,
	isCurrent: (revision) => revision === renderRevision,
	onPosition: rememberReaderPosition,
	onKeyDown: (event) => shortcuts(event),
	onPointerDown: () => tabController.closeMenu(),
	preventFileDrop,
	onFollowLink: (doc, href) => runExclusiveAction(() => followLink(doc, href)),
	readImage: (id, href) => api("image", { id, href }, { asBlob: true }),
	status,
});
let theme = document.documentElement.dataset.theme;
function applyTheme(value) {
	theme = value === "dark" ? "dark" : "light";
	document.documentElement.dataset.theme = theme;
	reader.setTheme(theme);
	const action =
		theme === "dark" ? "ライトモードに切り替える" : "ダークモードに切り替える";
	byId("theme-toggle").setAttribute("aria-label", action);
	byId("theme-toggle").title = action;
}
applyTheme(theme);
byId("theme-toggle").addEventListener("click", () => {
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
				"リクエストに失敗しました。サーバーを再起動した場合は、⌘⇧R / Ctrl+Shift+R でこのページ全体を再読み込みしてください。",
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

function registerDocuments(documents) {
	for (const doc of documents) {
		const key = keyFor(doc);
		if (availableDocuments.has(key))
			Object.assign(availableDocuments.get(key), doc);
		else availableDocuments.set(key, doc);
	}
	treeController.invalidate();
}

async function addDocuments(documents) {
	registerDocuments(documents);
	if (documents.length) await activate(keyFor(documents[0]));
}

async function openPath(path, recursive) {
	const revision = navigationRevision;
	status("ファイルを探しています…");
	const data = await api("open", { path, recursive });
	if (revision !== navigationRevision) return;
	await addDocuments(data.documents);
	byId("palette").close();
}

function drawNavigation() {
	byId("count").textContent = String(availableDocuments.size);
	byId("reopen-closed").disabled = closedBatches.length === 0;
	byId("close-all").disabled = tabs.size === 0;
	workspace.dataset.hasDocuments = String(availableDocuments.size > 0);
	tabController.draw();
	treeController.draw();
	byId("empty").hidden = tabs.size > 0;
	byId("reader").hidden = tabs.size === 0;
	if (active) {
		byId("reader").setAttribute("role", "tabpanel");
		byId("reader").setAttribute(
			"aria-labelledby",
			`tab-${tabs.get(active).id}`,
		);
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
	const filteredKeys = treeController.matchingKeys();
	if (!filteredKeys.length || byId("open-matches-confirm").open) return;
	const additions = filteredKeys.filter((key) => !tabs.has(key));
	if (additions.length < BULK_OPEN_CONFIRM_COUNT) {
		openMatchingTabs(additions);
		return;
	}
	pendingOpenKeys = additions;
	byId("open-matches-message").textContent =
		`${additions.length} 件のタブを追加します。本文は、そのタブを表示したときに読み込みます。`;
	byId("open-matches-confirm").showModal();
	byId("open-matches-cancel").focus();
}

function rememberReaderPosition({ key, mode, x, y }) {
	if (!tabs.has(key)) return;
	const positions = readerPositions.get(key) ?? {};
	positions[mode] = { x, y };
	readerPositions.set(key, positions);
}

function focusReaderContent() {
	if (active) reader.focus(renderRevision);
}

function setSidebarVisible(visible) {
	document.body.classList.toggle("sidebar-hidden", !visible);
	byId("sidebar-toggle").setAttribute("aria-expanded", String(visible));
	byId("sidebar-toggle").setAttribute(
		"aria-label",
		visible ? "サイドバーを隠す" : "サイドバーを表示する",
	);
	if (
		!visible &&
		(byId("sidebar").contains(document.activeElement) ||
			document.activeElement === byId("sidebar-resizer"))
	) {
		if (active) focusReaderContent();
		else byId("palette-open").focus();
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
	byId("source-toggle").textContent = showSource ? "Preview" : "Raw";
	if (active)
		void activate(active, { preserveTabSelection: true, focusReader });
}

function focusTreeFilter() {
	reader.cancelFocus();
	setSidebarVisible(true);
	tabController.closeMenu();
	setFocusMode(false);
	byId("filter").focus();
	byId("filter").select();
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

async function applyHighlight(color) {
	const selected = highlightToolbar.selection();
	const doc = selected && tabs.get(selected.key);
	if (!doc || selected.revision !== renderRevision || selected.key !== active)
		throw new Error("文章を選択し直してください。");
	const scrollTop = reader.scrollTop();
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
	highlightToolbar.hide();
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
	const focusWasInTabs = byId("tabs").contains(document.activeElement);
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
		if (focusWasInTabs) byId("filter").focus();
		return;
	}
	if (closing.has(active)) {
		const next = activeTabAfterClosing(keys, active, closing);
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
	byId("reopen-closed").disabled = closedBatches.length === 0;
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
		registerDocuments([current]);
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
		scrollTop: key === active ? reader.scrollTop() : 0,
	});
}

function homeNotice() {
	if (!showNotices) return "";
	return availableDocuments.size
		? "ファイル一覧から選択できます。"
		: "pnpm copy-docs で content/ にコピーしてから開いてください。";
}

function showEmpty(message, { record = true } = {}) {
	active = null;
	readerSearch.dismiss();
	tabController.selectOnly(null);
	renderRevision++;
	setFocusMode(false);
	reader.clear();
	drawNavigation();
	document.title = "Markdown Viewer";
	status(message);
	if (record) recordView();
}

async function restoreView(state) {
	const revision = ++navigationRevision;
	if (byId("palette").open) byId("palette").close();
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
				registerDocuments([doc]);
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
	const message = missingPaths
		? `履歴のパスを復元できませんでした。${restoreError}`
		: homeNotice();
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
	reader.clear();
	if (focusReader) reader.focus(revision);
	const position = readerPositions.get(key)?.[
		showSource ? "raw" : "preview"
	] ?? { x: 0, y: 0 };
	drawNavigation();
	byId("document-path").textContent = doc.path;
	byId("document-path").title = doc.path;
	byId("reload").title = "コピーから読み直す";
	document.title = `${doc.name} — Markdown Viewer`;
	showCopyNotice();
	reader.setLoading(true);
	try {
		await loadDocumentContent(doc);
		if (revision !== renderRevision) return;
		evictOldTabContent(doc);
		reader.show(doc, {
			key,
			revision,
			sourceMode: showSource,
			hash,
			scrollTop: scrollTop ?? position.y,
			scrollLeft: position.x,
		});
		if (revision === renderRevision) showCopyNotice();
	} catch (error) {
		if (revision === renderRevision) {
			reader.setLoading(false);
			status(error.message, true);
		}
	}
}

function setFocusMode(enabled) {
	if (enabled && !active) return;
	document.body.classList.toggle("focus-mode", enabled);
	byId("focus-toggle").setAttribute("aria-pressed", String(enabled));
	byId("focus-toggle").textContent = enabled ? "通常表示" : "全画面表示";
	byId("focus-toggle").title = enabled
		? "通常表示に戻す (Esc / ⌘⇧F / Ctrl+Shift+F)"
		: "全画面表示 (⌘⇧F / Ctrl+Shift+F)";
}
const shortcuts = createShortcutHandler({
	hasActive: () => Boolean(active),
	isPaletteOpen: () => byId("palette").open,
	isDialogOpen: () => Boolean(document.querySelector("dialog[open]")),
	openPalette,
	toggleSidebar,
	toggleSource,
	cycleTab,
	focusTreeFilter,
	reopenClosedTabs: () => {
		void runExclusiveAction(reopenClosedTabs);
	},
	reloadTab: () => {
		void runExclusiveAction(() => reloadTab());
	},
	closeSelectedTabs: () => closeTabs(tabController.selectedKeys()),
	openSearch: readerSearch.open,
	stepSearch: readerSearch.step,
	toggleTreeFocus: () => {
		if (document.activeElement === byId("filter") && active)
			focusReaderContent();
		else focusTreeFilter();
	},
	toggleFocusMode: () => {
		tabController.closeMenu();
		setFocusMode(!document.body.classList.contains("focus-mode"));
	},
	dismiss: () => {
		if (highlightToolbar.isVisible()) {
			highlightToolbar.dismiss();
			return;
		}
		if (readerSearch.isOpen()) readerSearch.dismiss();
		else setFocusMode(false);
	},
});
document.addEventListener("keydown", shortcuts);
byId("palette-open").addEventListener("click", openPalette);
byId("sidebar-toggle").addEventListener("click", toggleSidebar);
byId("reopen-closed").addEventListener("click", () =>
	runExclusiveAction(reopenClosedTabs),
);
byId("focus-toggle").addEventListener("click", () => {
	setFocusMode(!document.body.classList.contains("focus-mode"));
});

byId("open-matches").addEventListener("click", openFilteredDocuments);
byId("open-matches-cancel").addEventListener("click", () =>
	byId("open-matches-confirm").close(),
);
byId("open-matches-accept").addEventListener("click", () => {
	const keys = pendingOpenKeys ?? [];
	pendingOpenKeys = null;
	byId("open-matches-confirm").close();
	openMatchingTabs(keys);
});
byId("open-matches-confirm").addEventListener("close", () => {
	pendingOpenKeys = null;
});

byId("close-all").addEventListener("click", () => closeTabs([...tabs.keys()]));
byId("reload").addEventListener("click", () =>
	runExclusiveAction(() => reloadTab()),
);
byId("source-toggle").addEventListener("click", () => toggleSource());

function preventFileDrop(target, options) {
	target.addEventListener(
		"dragover",
		(event) => event.preventDefault(),
		options,
	);
	target.addEventListener(
		"drop",
		(event) => {
			event.preventDefault();
			status(
				"ファイルのドロップは利用できません。pnpm copy-docs でコピーしてください。",
				true,
			);
		},
		options,
	);
}
preventFileDrop(document);
runExclusiveAction(async () => {
	if (savedView?.tabs?.length) {
		await restoreView(savedView);
		const data = await api("initial");
		registerDocuments(
			data.documents.filter((doc) => !availableDocuments.has(keyFor(doc))),
		);
		drawNavigation();
		return;
	}
	const revision = navigationRevision;
	const documentId = new URLSearchParams(location.hash.slice(1)).get(
		"document",
	);
	if (!savedView && documentId) {
		const doc = await api("read", { id: documentId });
		if (revision !== navigationRevision) return;
		await addDocuments([{ ...doc, loaded: true }]);
		return;
	}
	const data = await api("initial");
	if (revision !== navigationRevision) return;
	registerDocuments(data.documents);
	showEmpty(homeNotice(), { record: false });
});
