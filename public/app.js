const $ = (id) => document.getElementById(id);
const token = document.querySelector('meta[name="viewer-token"]').content;
const tabs = new Map();
let active = null;
let generation = 0;
let showSource = false;
let busy = false;
let blobUrls = [];
let paletteIndex = 0;
let paletteMatches = [];
let importNumber = 0;
const MAX_BYTES = 1024 * 1024;

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

async function api(route, body = {}, binary = false) {
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
	return binary ? response.blob() : response.json();
}

async function action(work) {
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

async function addDocuments(documents) {
	for (const doc of documents)
		tabs.set(keyFor(doc), { ...tabs.get(keyFor(doc)), ...doc });
	if (documents.length) await activate(keyFor(documents[0]));
}

async function openPath(path, recursive) {
	status("ファイルを探しています…");
	const data = await api("open", { path, recursive });
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

function drawTabs() {
	$("count").textContent = String(tabs.size);
	$("tabs").replaceChildren();
	$("file-list").replaceChildren();
	const query = $("filter").value.toLocaleLowerCase();
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
		if (`${doc.label} ${doc.path ?? ""}`.toLocaleLowerCase().includes(query)) {
			const item = button(doc.label, () => activate(key));
			item.title = doc.path ?? doc.label;
			item.setAttribute("aria-current", String(active === key));
			$("file-list").append(item);
		}
	}
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

function clearReader() {
	for (const url of blobUrls) URL.revokeObjectURL(url);
	blobUrls = [];
	$("outline").replaceChildren();
	$("content").srcdoc = "";
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
		generation++;
		clearReader();
		document.title = "Markdown Viewer";
	}
	drawTabs();
}

function localHref(href, label) {
	if (/^(?:[a-z][a-z\d+.-]*:|\/|\\)/i.test(href)) return null;
	const base = new URL(
		label.split("/").map(encodeURIComponent).join("/"),
		"https://local.invalid/",
	);
	const url = new URL(href, base);
	return decodeURIComponent(url.pathname.slice(1));
}

async function followLink(doc, href) {
	if (doc.files) {
		const label = localHref(href, doc.label);
		const target = [...tabs.entries()].find(
			([, item]) => item.files === doc.files && item.label === label,
		);
		if (!target)
			throw new Error("リンク先の Markdown もファイル選択から開いてください。");
		await activate(target[0], href.split("#")[1]);
	} else {
		const data = await api("related", { id: doc.id, href });
		await addDocuments(data.documents);
		if (href.includes("#"))
			await activate(keyFor(data.documents[0]), href.split("#")[1]);
	}
}

function jumpTo(frameDocument, hash) {
	try {
		frameDocument.getElementById(decodeURIComponent(hash))?.scrollIntoView();
	} catch {
		status("見出しリンクの形式が不正です。", true);
	}
}

async function decorate(frameDocument, doc, revision, hash) {
	const used = new Set();
	for (const heading of frameDocument.querySelectorAll("h1,h2,h3,h4,h5,h6")) {
		const base =
			heading.textContent
				.toLocaleLowerCase()
				.trim()
				.replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
				.replace(/\s/g, "-") || "section";
		let slug = base;
		let suffix = 0;
		while (used.has(slug)) slug = `${base}-${++suffix}`;
		used.add(slug);
		heading.id = slug;
		const item = button(heading.textContent, () =>
			heading.scrollIntoView({ behavior: "smooth" }),
		);
		$("outline").append(item);
	}
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
				else action(() => followLink(doc, href));
			});
		}
	}
	if (hash) jumpTo(frameDocument, hash);
	// Sequential, bounded image loading avoids a burst of hundreds of requests.
	let images = 0;
	for (const img of frameDocument.querySelectorAll("img[data-image]")) {
		if (revision !== generation) return;
		const href = img.dataset.image;
		try {
			if (++images > 100) throw new Error("画像は 1 ページ 100 件までです。");
			if (/^(?:[a-z][a-z\d+.-]*:|\/|\\)/i.test(href))
				throw new Error("外部画像・絶対パス画像は読み込みません。");
			let blob;
			if (doc.files) {
				const label = localHref(href, doc.label);
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
			} else blob = await api("image", { id: doc.id, href }, true);
			if (revision !== generation) return;
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

async function activate(key, hash) {
	const doc = tabs.get(key);
	if (!doc) return;
	active = key;
	const revision = ++generation;
	clearReader();
	drawTabs();
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
		if (!doc.loaded) {
			if (doc.file) {
				if (doc.file.size > MAX_BYTES)
					throw new Error("Markdown の上限は 1 MiB です。");
				doc.source = await doc.file.text();
				doc.html = (await api("render", { source: doc.source })).html;
			} else Object.assign(doc, await api("read", { id: doc.id }));
			doc.loaded = true;
		}
		if (revision !== generation) return;
		// Keep content for only the ten most recently viewed tabs; other tabs are lazy.
		doc.lastViewed = Date.now();
		const cached = [...tabs.values()]
			.filter((item) => item.loaded)
			.sort((a, b) => b.lastViewed - a.lastViewed);
		for (const item of cached.slice(10)) {
			if (item !== doc) {
				delete item.html;
				delete item.source;
				item.loaded = false;
			}
		}
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
			if (revision === generation) {
				const child = frame.contentDocument;
				child.documentElement.dataset.theme = theme;
				child.addEventListener("keydown", shortcuts);
				child.addEventListener("dragover", handleDragOver);
				child.addEventListener("drop", handleDrop);
				if (!showSource)
					decorate(child, doc, revision, hash).catch((error) =>
						status(error.message, true),
					);
			}
		};
		// WebKit needs allow-scripts for parent-installed event listeners. A stricter
		// document CSP still forbids ALL script sources and inline execution.
		frame.srcdoc = `<!doctype html><html lang="ja" data-theme="${theme}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'self'; img-src blob:; base-uri 'none'; form-action 'none'"><link rel="stylesheet" href="${location.origin}/reader.css"></head><body>${content}</body></html>`;
		$("content").replaceWith(frame);
		if (revision === generation)
			status(
				doc.file
					? "選択時点の内容です。更新後はファイルを選び直してください。"
					: "読み取り専用 · 更新後は「再読み込み」",
			);
	} catch (error) {
		if (revision === generation) status(error.message, true);
	}
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
	const fileMap = new Map(
		files.map((file) => [
			file.webkitRelativePath || file.relativePath || file.name,
			file,
		]),
	);
	const batch = ++importNumber;
	const docs = selected
		.sort((a, b) =>
			(a.webkitRelativePath || a.relativePath || a.name).localeCompare(
				b.webkitRelativePath || b.relativePath || b.name,
			),
		)
		.map((file, index) => ({
			id: `import-${batch}-${index}`,
			name: file.name,
			label: file.webkitRelativePath || file.relativePath || file.name,
			file,
			files: fileMap,
		}));
	await addDocuments(docs);
}

function updatePalette() {
	const query = $("command").value.toLocaleLowerCase();
	paletteMatches = [...tabs.entries()]
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
function shortcuts(event) {
	if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
		event.preventDefault();
		openPalette();
	}
}
document.addEventListener("keydown", shortcuts);
$("palette-open").addEventListener("click", openPalette);
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
	if (paletteMatches.length && !/^(?:\/|~|\.|[a-z]:[\\/])/i.test(value)) {
		$("palette").close();
		activate(paletteMatches[paletteIndex][0]);
	} else action(() => openPath(value, $("palette-recursive").checked));
});
$("open-form").addEventListener("submit", (event) => {
	event.preventDefault();
	action(() => openPath($("path").value, $("recursive").checked));
});
$("filter").addEventListener("input", drawTabs);
$("pick-files").addEventListener("click", () => $("files").click());
$("pick-folder").addEventListener("click", () => $("folder").click());
for (const id of ["files", "folder"])
	$(id).addEventListener("change", (event) => {
		const files = [...event.target.files];
		event.target.value = "";
		if (files.length) action(() => importFiles(files));
	});
$("close-all").addEventListener("click", () => {
	tabs.clear();
	active = null;
	generation++;
	clearReader();
	drawTabs();
	document.title = "Markdown Viewer";
	status("すべてのタブを閉じました。");
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
		if (depth > 32) throw new Error("フォルダーの範囲を絞ってください。");
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
	action(async () => importFiles(await droppedFiles(items)));
}
document.addEventListener("drop", handleDrop);
action(async () => {
	const documentId = new URLSearchParams(location.hash.slice(1)).get(
		"document",
	);
	if (documentId) {
		const doc = await api("read", { id: documentId });
		await addDocuments([{ ...doc, loaded: true }]);
		return;
	}
	const data = await api("initial");
	if (data.documents.length) await addDocuments(data.documents);
	else status("パス入力・ファイル選択・ドラッグ＆ドロップに対応しています。");
});
