import { mapSourceText, sourceRangesForSelection } from "./selection.js";

const $ = (id) => document.getElementById(id);
const token = document.querySelector('meta[name="viewer-token"]').content;
const availableDocuments = new Map();
const tabs = new Map();
const historyTag = "markdown-viewer-v2";
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
let importNumber = 0;
let highlightSelection = null;
let highlightListeners = null;
const collapsedFolders = new Set();
const filterCollapsedFolders = new Set();
const MAX_BYTES = 1024 * 1024;
const MAX_CACHED_TABS = 10;
const MAX_PAGE_IMAGES = 100;
const MAX_DIRECTORY_DEPTH = 32;
const MIN_SIDEBAR_WIDTH_PX = 180;
const MAX_SIDEBAR_WIDTH_PX = 600;
const MOBILE_BREAKPOINT_PX = 760;
// Leave room for the reader plus the six-pixel resize handle.
const MIN_READER_AND_RESIZER_WIDTH_PX = 326;

const workspace = document.querySelector(".workspace");
function initializeSidebarResize() {
	const resizer = $("sidebar-resizer");
	let sidebarWidth = 250;
	let resizeOffset = 0;
	try {
		const saved = Number(localStorage.getItem("viewer-sidebar-width"));
		if (Number.isFinite(saved) && saved > 0) sidebarWidth = saved;
	} catch {
		/* Resizing still works without persistence. */
	}
	let preferredSidebarWidth = sidebarWidth;
	function sidebarMaxWidth() {
		return Math.max(
			MIN_SIDEBAR_WIDTH_PX,
			Math.min(
				MAX_SIDEBAR_WIDTH_PX,
				workspace.clientWidth - MIN_READER_AND_RESIZER_WIDTH_PX,
			),
		);
	}
	function setSidebarWidth(width, persist = false) {
		if (!Number.isFinite(width)) return;
		sidebarWidth = Math.round(
			Math.max(MIN_SIDEBAR_WIDTH_PX, Math.min(sidebarMaxWidth(), width)),
		);
		workspace.style.setProperty("--sidebar-width", `${sidebarWidth}px`);
		resizer.setAttribute("aria-valuemax", String(sidebarMaxWidth()));
		resizer.setAttribute("aria-valuenow", String(sidebarWidth));
		if (persist) {
			preferredSidebarWidth = sidebarWidth;
			try {
				localStorage.setItem("viewer-sidebar-width", String(sidebarWidth));
			} catch {
				/* Resizing still works without persistence. */
			}
		}
	}
	setSidebarWidth(sidebarWidth);
	window.addEventListener("resize", () => {
		if (window.innerWidth > MOBILE_BREAKPOINT_PX)
			setSidebarWidth(preferredSidebarWidth);
	});
	resizer.addEventListener("pointerdown", (event) => {
		if (event.button !== 0) return;
		resizeOffset = event.clientX - $("sidebar").getBoundingClientRect().right;
		resizer.setPointerCapture(event.pointerId);
		resizer.focus();
		document.body.classList.add("resizing-sidebar");
	});
	resizer.addEventListener("pointermove", (event) => {
		if (resizer.hasPointerCapture(event.pointerId))
			setSidebarWidth(
				event.clientX - workspace.getBoundingClientRect().left - resizeOffset,
			);
	});
	function finishSidebarResize() {
		document.body.classList.remove("resizing-sidebar");
		setSidebarWidth(sidebarWidth, true);
	}
	resizer.addEventListener("pointerup", finishSidebarResize);
	resizer.addEventListener("pointercancel", finishSidebarResize);
	resizer.addEventListener("keydown", (event) => {
		const widthsByKey = {
			ArrowLeft: sidebarWidth - 20,
			ArrowRight: sidebarWidth + 20,
			Home: MIN_SIDEBAR_WIDTH_PX,
			End: sidebarMaxWidth(),
		};
		const width = widthsByKey[event.key] ?? null;
		if (width === null) return;
		event.preventDefault();
		setSidebarWidth(width, true);
	});
}
initializeSidebarResize();

let theme = document.documentElement.dataset.theme;
function applyTheme(value) {
	theme = value === "dark" ? "dark" : "light";
	document.documentElement.dataset.theme = theme;
	const reader = $("content").contentDocument;
	if (reader?.documentElement) reader.documentElement.dataset.theme = theme;
	$("theme-toggle").setAttribute("aria-pressed", String(theme === "dark"));
	$("theme-toggle").textContent = theme === "dark" ? "ライトへ" : "ダークへ";
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
				"サーバーに接続できません。再起動後はページを再読み込みしてください。",
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

function treeFromDocuments(documents) {
	const root = { directories: new Map(), files: [] };
	for (const [key, doc] of documents) {
		const parts = doc.label.split(/[\\/]/).filter(Boolean);
		let branch = root;
		if (doc.root) {
			const rootKey = `root:${doc.root}`;
			if (!branch.directories.has(rootKey))
				branch.directories.set(rootKey, {
					name: doc.root.split(/[\\/]/).filter(Boolean).at(-1) ?? doc.root,
					directories: new Map(),
					files: [],
				});
			branch = branch.directories.get(rootKey);
		}
		for (const part of parts.slice(0, -1)) {
			if (!branch.directories.has(part))
				branch.directories.set(part, {
					name: part,
					directories: new Map(),
					files: [],
				});
			branch = branch.directories.get(part);
		}
		branch.files.push({ key, doc, name: parts.at(-1) ?? doc.name });
	}
	return root;
}

function drawTreeBranch(
	branch,
	parent,
	path = [],
	level = 1,
	filtering = false,
) {
	const directories = [...branch.directories.entries()].sort(
		([, left], [, right]) => left.name.localeCompare(right.name),
	);
	for (const [id, child] of directories) {
		const folderPath = [...path, id];
		const folderKey = JSON.stringify(folderPath);
		const folderState = filtering ? filterCollapsedFolders : collapsedFolders;
		const expanded = !folderState.has(folderKey);
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
	for (const { key, doc, name } of branch.files.sort((left, right) =>
		left.name.localeCompare(right.name),
	)) {
		const item = button(name, () => activate(key), "tree-file");
		item.title = doc.path ?? doc.label;
		item.setAttribute("role", "treeitem");
		item.setAttribute("aria-label", name);
		item.setAttribute("aria-level", String(level));
		item.setAttribute("aria-current", String(active === key));
		parent.append(item);
	}
}

function drawOpenTabs() {
	$("tabs").replaceChildren();
	for (const [key, doc] of tabs) {
		const tab = button(doc.name, () => activate(key));
		tab.setAttribute("role", "tab");
		tab.setAttribute("aria-selected", String(active === key));
		tab.setAttribute("aria-controls", "reader");
		tab.tabIndex = active === key ? 0 : -1;
		tab.title = doc.path ?? doc.label;
		tab.id = `tab-${doc.id}`;
		const close = button("×", () => closeTab(key), "close-tab");
		close.setAttribute("aria-label", `${doc.label} を閉じる`);
		const group = document.createElement("div");
		group.className = "tab";
		group.setAttribute("role", "presentation");
		group.append(tab, close);
		$("tabs").append(group);
	}
}

function drawNavigation() {
	$("count").textContent = String(availableDocuments.size);
	workspace.dataset.hasDocuments = String(availableDocuments.size > 0);
	drawOpenTabs();
	$("file-list").replaceChildren();
	const query = $("filter").value.trim().toLocaleLowerCase();
	const visibleDocuments = [];
	for (const [key, doc] of availableDocuments)
		if (`${doc.label} ${doc.path ?? ""}`.toLocaleLowerCase().includes(query))
			visibleDocuments.push([key, doc]);
	drawTreeBranch(
		treeFromDocuments(visibleDocuments),
		$("file-list"),
		[],
		1,
		Boolean(query),
	);
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

function hideHighlightToolbar() {
	highlightSelection = null;
	$("highlight-toolbar").hidden = true;
}

function clearReader() {
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
		$("highlight-note").textContent = doc.file
			? "パスで開いたファイルのみ保存できます"
			: "";
		for (const button of $("highlight-toolbar").querySelectorAll(
			"[data-highlight-color]",
		)) {
			button.disabled = Boolean(doc.file);
			button.setAttribute(
				"aria-pressed",
				String(button.dataset.highlightColor === selected.marker?.color),
			);
		}
		$("highlight-remove").disabled = Boolean(doc.file || !selected.marker);
		position();
	};
	frameDocument.defaultView.addEventListener("scroll", position, {
		passive: true,
		signal: controller.signal,
	});
	window.addEventListener("resize", position, { signal: controller.signal });
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
}

async function applyHighlight(color) {
	const selected = highlightSelection;
	const doc = selected && tabs.get(selected.key);
	if (
		!doc ||
		doc.file ||
		selected.revision !== renderRevision ||
		selected.key !== active
	)
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
	await activate(selected.key, { scrollTop });
	const messagesByMode = {
		add: "マーカーを保存しました。",
		recolor: "マーカーの色を変更しました。",
		remove: "マーカーを外しました。",
	};
	status(messagesByMode[mode]);
}

function closeTab(key) {
	const keys = [...tabs.keys()];
	const index = keys.indexOf(key);
	tabs.delete(key);
	if (key === active) {
		active = null;
		const next = keys[index + 1] ?? keys[index - 1];
		if (next) {
			activate(next);
			return;
		}
		showEmpty("タブを閉じました。");
		return;
	}
	drawNavigation();
	recordView();
}

function showEmpty(message, { record = true } = {}) {
	active = null;
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
	showEmpty("履歴から復元しています…", { record: false });
	const paths = new Map((state?.paths ?? []).map((doc) => [doc.path, doc]));
	let missingPaths = 0;
	let missingImports = 0;
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
		} else if (!doc) missingImports++;
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
		else if (missingImports)
			status("ブラウザーから選択したファイルは再度取り込んでください。");
		return;
	}
	let message = "パス入力・ファイル選択・ドラッグ＆ドロップに対応しています。";
	if (missingPaths)
		message = `履歴のパスを復元できませんでした。${restoreError}`;
	else if (missingImports)
		message = "ブラウザーから選択したファイルは再度取り込んでください。";
	else if (availableDocuments.size) message = "ファイル一覧から選択できます。";
	showEmpty(message, { record: false });
}

window.addEventListener("popstate", (event) => {
	if (event.state && event.state.viewer !== historyTag) return;
	void restoreView(event.state);
});

function resolveImportedLabel(href, label) {
	if (/^(?:[a-z][a-z\d+.-]*:|\/|\\)/i.test(href)) return null;
	const base = new URL(
		label.split("/").map(encodeURIComponent).join("/"),
		"https://local.invalid/",
	);
	const url = new URL(href, base);
	return decodeURIComponent(url.pathname.slice(1));
}

async function followLink(doc, href) {
	const revision = navigationRevision;
	if (doc.files) {
		const label = resolveImportedLabel(href, doc.label);
		const target = [...availableDocuments.entries()].find(
			([, item]) => item.files === doc.files && item.label === label,
		);
		if (!target)
			throw new Error("リンク先の Markdown もファイル選択から開いてください。");
		await activate(target[0], { hash: href.split("#")[1] });
	} else {
		const data = await api("related", { id: doc.id, href });
		if (revision !== navigationRevision) return;
		await addDocuments(data.documents);
		if (href.includes("#"))
			await activate(keyFor(data.documents[0]), { hash: href.split("#")[1] });
	}
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
			let blob;
			if (doc.files) {
				const label = resolveImportedLabel(href, doc.label);
				const file = doc.files.get(label);
				if (!file || !/\.(png|jpe?g|gif|webp|avif)$/i.test(label))
					throw new Error(
						"画像を読むには、画像を含むフォルダーを選択してください。",
					);
				if (file.size > 5 * MAX_BYTES)
					throw new Error("画像の上限は 5 MiB です。");
				const extension = label.split(".").pop().toLowerCase();
				blob = new Blob([await file.arrayBuffer()], {
					type: `image/${extension === "jpg" ? "jpeg" : extension}`,
				});
			} else blob = await api("image", { id: doc.id, href }, { asBlob: true });
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
	if (doc.file) {
		if (doc.file.size > MAX_BYTES)
			throw new Error("Markdown の上限は 1 MiB です。");
		doc.source = await doc.file.text();
		doc.html = (await api("render", { source: doc.source })).html;
	} else Object.assign(doc, await api("read", { id: doc.id }));
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

function createReaderFrame(doc, revision, { hash, scrollTop }) {
	const frame = document.createElement("iframe");
	frame.id = "content";
	frame.title = "Markdown 本文";
	frame.setAttribute(
		"sandbox",
		"allow-same-origin allow-scripts allow-popups allow-popups-to-escape-sandbox",
	);
	let content = doc.html;
	if (showSource) {
		const pre = document.createElement("pre");
		pre.className = "source";
		pre.textContent = doc.source;
		content = pre.outerHTML;
	}
	frame.onload = () => {
		if (revision !== renderRevision) return;
		const readerDocument = frame.contentDocument;
		readerDocument.documentElement.dataset.theme = theme;
		readerDocument.addEventListener("keydown", shortcuts);
		readerDocument.addEventListener("dragover", handleDragOver);
		readerDocument.addEventListener("drop", handleDrop);
		if (!showSource) {
			watchHighlightSelection(readerDocument, doc, revision);
			buildOutline(readerDocument);
			enableReaderLinks(readerDocument, doc);
			if (hash) jumpTo(readerDocument, hash);
			loadReaderImages(readerDocument, doc, revision).catch((error) =>
				status(error.message, true),
			);
		}
		if (scrollTop) frame.contentWindow.scrollTo(0, scrollTop);
	};
	// WebKit needs allow-scripts for parent-installed listeners; the document CSP forbids execution.
	frame.srcdoc = `<!doctype html>
<html lang="ja" data-theme="${theme}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'self'; img-src blob:; base-uri 'none'; form-action 'none'">
<link rel="stylesheet" href="${location.origin}/reader.css">
</head>
<body>${content}</body>
</html>`;
	return frame;
}

async function activate(key, { hash, record = true, scrollTop = 0 } = {}) {
	const doc = availableDocuments.get(key);
	if (!doc) return;
	tabs.set(key, doc);
	active = key;
	if (record) recordView();
	const revision = ++renderRevision;
	clearReader();
	drawNavigation();
	$("document-path").textContent = doc.path ?? `選択したファイル: ${doc.label}`;
	$("document-path").title = doc.path ?? doc.label;
	$("reload").disabled = Boolean(doc.file);
	$("separate-tab").hidden = Boolean(doc.file);
	$("separate-tab").href = `/#document=${encodeURIComponent(doc.id)}`;
	$("reload").title = doc.file
		? "選択したファイルの更新は、もう一度選択して読み込んでください。"
		: "ディスクから読み直す";
	document.title = `${doc.name} — Markdown Viewer`;
	status("読み込み中…");
	try {
		await loadDocumentContent(doc);
		if (revision !== renderRevision) return;
		evictOldTabContent(doc);
		$("content").replaceWith(
			createReaderFrame(doc, revision, { hash, scrollTop }),
		);
		if (revision === renderRevision)
			status(
				doc.file
					? "選択時点の内容です。更新後はファイルを選び直してください。"
					: "本文編集なし · マーカー保存可 · 更新後は「再読み込み」",
			);
	} catch (error) {
		if (revision === renderRevision) status(error.message, true);
	}
}

function importedFileLabel(file) {
	return file.webkitRelativePath || file.relativePath || file.name;
}

async function importFiles(files) {
	const selected = files.filter((file) => /\.(md|markdown)$/i.test(file.name));
	if (!selected.length)
		throw new Error("選択した項目に Markdown がありません。");
	if (selected.some((file) => file.size > MAX_BYTES))
		throw new Error(
			"1 MiB を超える Markdown があります。小さい範囲を選択してください。",
		);
	if (files.reduce((size, file) => size + file.size, 0) > 50 * MAX_BYTES)
		throw new Error("選択したファイルの合計上限は 50 MiB です。");
	const fileMap = new Map(files.map((file) => [importedFileLabel(file), file]));
	const batch = ++importNumber;
	const docs = selected
		.sort((left, right) =>
			importedFileLabel(left).localeCompare(importedFileLabel(right)),
		)
		.map((file, index) => ({
			id: `import-${batch}-${index}`,
			name: file.name,
			label: importedFileLabel(file),
			file,
			files: fileMap,
		}));
	await addDocuments(docs);
}

let paletteIndex = 0;
let paletteMatches = [];

function updatePalette() {
	const query = $("command").value.trim().toLocaleLowerCase();
	paletteMatches = !query
		? []
		: [...availableDocuments.entries()]
				.filter(([, doc]) =>
					`${doc.label} ${doc.path ?? ""}`.toLocaleLowerCase().includes(query),
				)
				.slice(0, 20);
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
	const isCommandShift =
		(event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey;
	const key = event.key.toLowerCase();
	if (isCommandShift && key === "f") {
		if (!active) return;
		event.preventDefault();
		setFocusMode(!document.body.classList.contains("focus-mode"));
		return;
	}
	if (event.key === "Escape" && !$("palette").open) {
		if (!$("highlight-toolbar").hidden) {
			$("content").contentWindow?.getSelection()?.removeAllRanges();
			hideHighlightToolbar();
			return;
		}
		setFocusMode(false);
		return;
	}
	if (isCommandShift && key === "p") {
		event.preventDefault();
		openPalette();
	}
}
document.addEventListener("keydown", shortcuts);
$("palette-open").addEventListener("click", openPalette);
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
$("open-form").addEventListener("submit", (event) => {
	event.preventDefault();
	runExclusiveAction(() => openPath($("path").value, $("recursive").checked));
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
	const folderState = $("filter").value.trim()
		? filterCollapsedFolders
		: collapsedFolders;
	for (const folder of folders) folderState.add(folder.dataset.folderKey);
	const focusKey = [...tree.children].find((folder) =>
		folder.contains(document.activeElement),
	)?.dataset.folderKey;
	drawNavigation();
	if (focusKey)
		[...tree.querySelectorAll(".tree-folder")]
			.find((folder) => folder.dataset.folderKey === focusKey)
			?.focus();
});
$("pick-files").addEventListener("click", () => {
	$("add-menu").open = false;
	$("files").click();
});
$("pick-folder").addEventListener("click", () => {
	$("add-menu").open = false;
	$("folder").click();
});
document.addEventListener("click", (event) => {
	if (!$("add-menu").contains(event.target)) $("add-menu").open = false;
});
document.addEventListener("keydown", (event) => {
	if (event.key === "Escape") $("add-menu").open = false;
});
for (const id of ["files", "folder"])
	$(id).addEventListener("change", (event) => {
		const files = [...event.target.files];
		event.target.value = "";
		if (files.length) runExclusiveAction(() => importFiles(files));
	});
$("close-all").addEventListener("click", () => {
	tabs.clear();
	showEmpty("すべてのタブを閉じました。ファイル一覧から開き直せます。");
});
$("reload").addEventListener("click", () => {
	if (active) {
		tabs.get(active).loaded = false;
		activate(active);
	}
});
$("source-toggle").addEventListener("click", () => {
	showSource = !showSource;
	$("source-toggle").setAttribute("aria-pressed", String(showSource));
	$("source-toggle").textContent = showSource ? "プレビュー" : "ソース";
	if (active) activate(active);
});
document.addEventListener("pointerdown", (event) => {
	if (
		!$("highlight-toolbar").hidden &&
		!$("highlight-toolbar").contains(event.target)
	) {
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
$("tabs").addEventListener("keydown", (event) => {
	const keys = [...tabs.keys()];
	let index = keys.indexOf(active);
	if (event.key === "ArrowRight") index = (index + 1) % keys.length;
	else if (event.key === "ArrowLeft")
		index = (index - 1 + keys.length) % keys.length;
	else if (event.key === "Home") index = 0;
	else if (event.key === "End") index = keys.length - 1;
	else if (event.key === "Delete") {
		event.preventDefault();
		closeTab(active);
		return;
	} else return;
	event.preventDefault();
	activate(keys[index]);
	document.querySelector('[aria-selected="true"]')?.focus();
});

async function droppedFiles(items) {
	const files = [];
	async function walk(entry, prefix = "", depth = 0) {
		if (depth > MAX_DIRECTORY_DEPTH)
			throw new Error("フォルダーの範囲を絞ってください。");
		if (entry.isFile) {
			const file = await new Promise((resolve, reject) =>
				entry.file(resolve, reject),
			);
			Object.defineProperty(file, "relativePath", {
				value: prefix + file.name,
			});
			files.push(file);
		} else if (entry.isDirectory) {
			const reader = entry.createReader();
			while (true) {
				const entries = await new Promise((resolve, reject) =>
					reader.readEntries(resolve, reject),
				);
				if (!entries.length) break;
				for (const child of entries) {
					if (![".git", "node_modules"].includes(child.name))
						await walk(child, `${prefix}${entry.name}/`, depth + 1);
				}
			}
		}
	}
	for (const item of items) {
		if (item.entry?.isDirectory) await walk(item.entry);
		else if (item.file) files.push(item.file);
		else if (item.entry) await walk(item.entry);
	}
	return files;
}
function handleDragOver(event) {
	event.preventDefault();
	document.body.classList.add("dragging");
}
document.addEventListener("dragover", handleDragOver);
document.addEventListener("dragleave", (event) => {
	if (!event.relatedTarget) document.body.classList.remove("dragging");
});
function handleDrop(event) {
	event.preventDefault();
	document.body.classList.remove("dragging");
	const items = [...event.dataTransfer.items]
		.filter((item) => item.kind === "file")
		.map((item) => ({
			entry: item.webkitGetAsEntry?.(),
			file: item.getAsFile(),
		}));
	runExclusiveAction(async () => importFiles(await droppedFiles(items)));
}
document.addEventListener("drop", handleDrop);
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
	else status("パス入力・ファイル選択・ドラッグ＆ドロップに対応しています。");
});
