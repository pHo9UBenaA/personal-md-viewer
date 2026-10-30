import { createButton } from "./dom.js";

const MAX_PAGE_IMAGES = 100;

export function initializeReader({
	container,
	outline,
	search,
	highlights,
	getTheme,
	isCurrent,
	onPosition,
	onKeyDown,
	onPointerDown,
	preventFileDrop,
	onFollowLink,
	readImage,
	status,
}) {
	let displayedView = null;
	let pendingFocusRevision = null;
	let blobUrls = [];
	let listeners = null;
	const getFrame = () => container.querySelector("#content");
	function clear() {
		search.clearDocument();
		if (displayedView) {
			const { key, mode, frame } = displayedView;
			onPosition({
				key,
				mode,
				x: frame.contentWindow.scrollX,
				y: frame.contentWindow.scrollY,
			});
		}
		displayedView = null;
		pendingFocusRevision = null;
		highlights.detach();
		listeners?.abort();
		listeners = null;
		for (const url of blobUrls) URL.revokeObjectURL(url);
		blobUrls = [];
		outline.replaceChildren();
		const frame = document.createElement("iframe");
		frame.id = "content";
		frame.title = "Markdown 本文";
		frame.setAttribute(
			"sandbox",
			"allow-same-origin allow-popups allow-popups-to-escape-sandbox",
		);
		getFrame().replaceWith(frame);
	}

	function focus(revision) {
		if (!displayedView || displayedView.frame !== getFrame()) {
			pendingFocusRevision = revision;
			return;
		}
		pendingFocusRevision = null;
		document.getSelection()?.removeAllRanges();
		getFrame().contentWindow.focus();
		getFrame().contentDocument.body.focus({ preventScroll: true });
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
			const item = createButton(heading.textContent, () =>
				heading.scrollIntoView({ behavior: "smooth" }),
			);
			outline.append(item);
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
					else onFollowLink(doc, href);
				});
			}
		}
	}

	// Sequential, bounded image loading avoids a burst of hundreds of requests.
	async function loadReaderImages(frameDocument, doc, revision) {
		let imageCount = 0;
		for (const img of frameDocument.querySelectorAll("img[data-image]")) {
			if (!isCurrent(revision)) return;
			const href = img.dataset.image;
			try {
				if (++imageCount > MAX_PAGE_IMAGES)
					throw new Error("画像は 1 ページ 100 件までです。");
				if (/^(?:[a-z][a-z\d+.-]*:|\/|\\)/i.test(href))
					throw new Error("外部画像・絶対パス画像は読み込みません。");
				const blob = await readImage(doc.id, href);
				if (!isCurrent(revision)) return;
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
	function createReaderFrame(
		doc,
		{ key, revision, sourceMode, hash, scrollTop, scrollLeft },
	) {
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
			if (!isCurrent(revision)) return;
			const readerDocument = frame.contentDocument;
			// Restore pixels only after local fonts finish layout, avoiding scroll anchoring jumps.
			await readerDocument.fonts.ready;
			if (!isCurrent(revision)) return;
			readerDocument.documentElement.dataset.theme = getTheme();
			readerDocument.body.tabIndex = -1;
			displayedView = {
				key,
				mode: sourceMode ? "raw" : "preview",
				frame,
			};
			listeners?.abort();
			listeners = new AbortController();
			const options = { signal: listeners.signal };
			readerDocument.addEventListener("keydown", onKeyDown, options);
			readerDocument.addEventListener("pointerdown", onPointerDown, options);
			preventFileDrop(readerDocument, options);
			if (!sourceMode) {
				highlights.attach(readerDocument, doc, key, revision);
				buildOutline(readerDocument);
				enableReaderLinks(readerDocument, doc);
				if (hash) jumpTo(readerDocument, hash);
				loadReaderImages(readerDocument, doc, revision).catch((error) =>
					status(error.message, true),
				);
			}
			search.setDocument(readerDocument, key);
			if (!hash) frame.contentWindow.scrollTo(scrollLeft, scrollTop);
			if (pendingFocusRevision === revision) focus(revision);
		};
		// WebKit needs allow-scripts for parent-installed listeners; the document CSP forbids execution.
		frame.srcdoc = `<!doctype html>
<html lang="ja" data-theme="${getTheme()}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'self'; font-src 'self'; img-src blob:; base-uri 'none'; form-action 'none'">
<link rel="stylesheet" href="${location.origin}/reader.css">
</head>
<body>${content}</body>
</html>`;
		return frame;
	}

	function cancelFocus() {
		pendingFocusRevision = null;
	}
	document.addEventListener("focusin", (event) => {
		if (event.target !== getFrame()) cancelFocus();
	});
	document.addEventListener("pointerdown", cancelFocus);
	return {
		clear,
		focus,
		cancelFocus,
		scrollTop: () => getFrame().contentWindow?.scrollY ?? 0,
		setTheme: (theme) => {
			const doc = getFrame().contentDocument;
			if (doc?.documentElement) doc.documentElement.dataset.theme = theme;
		},
		show: (doc, options) =>
			getFrame().replaceWith(createReaderFrame(doc, options)),
	};
}
