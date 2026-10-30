function isFoldedText(node) {
	let details = node.parentElement.closest("details:not([open])");
	while (details) {
		if (!details.querySelector(":scope > summary")?.contains(node)) return true;
		details = details.parentElement?.closest("details:not([open])");
	}
	return false;
}

function searchableText(doc) {
	const segments = [];
	const parts = [];
	let length = 0;
	let previousBlock = null;
	function addLineBreak() {
		if (!parts.length || parts.at(-1).endsWith("\n")) return;
		parts.push("\n");
		length++;
	}
	const { Node, NodeFilter } = doc.defaultView;
	const walker = doc.createTreeWalker(
		doc.body,
		NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
	);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if (node.nodeType !== Node.TEXT_NODE) {
			if (
				node.tagName === "BR" &&
				!isFoldedText(node) &&
				!node.closest("[hidden]") &&
				node.getClientRects().length
			)
				addLineBreak();
			continue;
		}
		if (
			!node.data ||
			isFoldedText(node) ||
			node.parentElement.closest(
				"script, style, noscript, template, [hidden], .image-note",
			)
		)
			continue;
		const range = doc.createRange();
		range.selectNodeContents(node);
		if (
			!range.getClientRects().length ||
			doc.defaultView.getComputedStyle(node.parentElement).visibility ===
				"hidden"
		)
			continue;
		const block =
			node.parentElement.closest(
				"p, pre, li, td, th, h1, h2, h3, h4, h5, h6, div, section, article, summary",
			) ?? doc.body;
		if (previousBlock && previousBlock !== block) addLineBreak();
		previousBlock = block;
		segments.push({ node, start: length, end: length + node.data.length });
		parts.push(node.data);
		length += node.data.length;
	}
	return { segments, text: parts.join("") };
}

export function initializeReaderSearch({
	bar,
	input,
	counter,
	previous,
	next,
	close,
	focusReader,
}) {
	let doc = null;
	let documentKey = null;
	let listeners = null;
	let segments = [];
	// Flat UTF-16 offset pairs keep even very frequent one-character matches small.
	let offsets = [];
	let index = -1;

	function clearHighlight() {
		doc?.defaultView.CSS.highlights?.delete("mdv-find");
	}
	function paint(scroll = false) {
		clearHighlight();
		const count = offsets.length / 2;
		counter.textContent = `${count ? index + 1 : 0} / ${count}`;
		previous.disabled = next.disabled = count === 0;
		if (!doc || !count) return;
		const start = offsets[index * 2];
		const end = offsets[index * 2 + 1];
		const first = segments.find(
			(segment) => start >= segment.start && start < segment.end,
		);
		const last = segments.find(
			(segment) => end > segment.start && end <= segment.end,
		);
		if (!first || !last) return;
		const range = doc.createRange();
		range.setStart(first.node, start - first.start);
		range.setEnd(last.node, end - last.start);
		// CSS Highlights leaves text nodes and the marker source mapping unchanged.
		if (doc.defaultView.CSS.highlights && doc.defaultView.Highlight)
			doc.defaultView.CSS.highlights.set(
				"mdv-find",
				new doc.defaultView.Highlight(range),
			);
		if (scroll) {
			const rect = range.getBoundingClientRect();
			const view = doc.defaultView;
			if (
				rect.top < 0 ||
				rect.bottom > view.innerHeight ||
				rect.left < 0 ||
				rect.right > view.innerWidth
			)
				view.scrollBy(
					rect.left < 0 || rect.right > view.innerWidth
						? rect.left - view.innerWidth / 2
						: 0,
					rect.top - view.innerHeight / 2,
				);
		}
	}

	function refresh({ reset = false, scroll = false } = {}) {
		offsets = [];
		segments = [];
		if (doc && input.value && !bar.hidden) {
			const collected = searchableText(doc);
			segments = collected.segments;
			const literal = input.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const pattern = new RegExp(literal, "giu");
			for (
				let match = pattern.exec(collected.text);
				match;
				match = pattern.exec(collected.text)
			)
				offsets.push(match.index, match.index + match[0].length);
		}
		index = offsets.length
			? reset
				? 0
				: Math.max(0, Math.min(index, offsets.length / 2 - 1))
			: -1;
		paint(scroll);
	}

	function open({ focus = true, scroll = true } = {}) {
		bar.hidden = false;
		refresh({ scroll });
		if (focus) {
			input.focus();
			input.select();
		}
	}
	function step(direction) {
		if (!input.value) {
			open();
			return;
		}
		if (bar.hidden) open({ focus: false, scroll: false });
		const count = offsets.length / 2;
		if (!count) return;
		index = (index + direction + count) % count;
		paint(true);
	}
	function dismiss() {
		bar.hidden = true;
		clearHighlight();
		focusReader();
	}
	function clearDocument() {
		listeners?.abort();
		listeners = null;
		clearHighlight();
		doc = null;
		segments = [];
		offsets = [];
		paint();
	}
	function setDocument(value, key) {
		clearDocument();
		const changed = documentKey !== key;
		documentKey = key;
		doc = value;
		listeners = new AbortController();
		doc.addEventListener("toggle", () => refresh(), {
			capture: true,
			signal: listeners.signal,
		});
		if (!bar.hidden) refresh({ reset: changed });
	}
	input.addEventListener("input", () => refresh({ reset: true, scroll: true }));
	input.addEventListener("keydown", (event) => {
		if (event.isComposing || event.keyCode === 229) return;
		if (event.key === "Enter") {
			event.preventDefault();
			step(event.shiftKey ? -1 : 1);
		} else if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			dismiss();
		}
	});
	previous.addEventListener("click", () => step(-1));
	next.addEventListener("click", () => step(1));
	close.addEventListener("click", dismiss);
	return {
		open,
		step,
		dismiss,
		clearDocument,
		setDocument,
		isOpen: () => !bar.hidden,
	};
}
