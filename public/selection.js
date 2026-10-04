// Map literal preview text to UTF-16 source offsets. Markdown structure is checked by the server.
const HIGHLIGHT_CLOSE_TAG = "</mark>";

export function mapSourceText(frameDocument, source) {
	const positions = new WeakMap();
	const nodes = [];
	let sourceCursor = 0;
	const walker = frameDocument.createTreeWalker(
		frameDocument.body,
		NodeFilter.SHOW_TEXT,
	);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		nodes.push(node);
		if (!node.data || node.parentElement?.closest("pre, code, script, style"))
			continue;
		const start = source.indexOf(node.data, sourceCursor);
		if (start < 0) continue;
		const isEscaped = start > 0 && source[start - 1] === "\\";
		const entityMatch = source
			.slice(start)
			.match(/^&(?:#[0-9]{1,7}|#x[a-f0-9]{1,6}|[a-z][a-z0-9]{1,31});/i);
		sourceCursor = start + node.data.length;
		if (isEscaped || (entityMatch && entityMatch[0] !== node.data)) continue;
		positions.set(node, { start, end: sourceCursor });
	}
	return { nodes, positions };
}

function textBoundary(container, offset, isStartBoundary) {
	if (container.nodeType === Node.TEXT_NODE) return { node: container, offset };
	if (container.nodeType !== Node.ELEMENT_NODE) return null;
	let candidate = container.childNodes[isStartBoundary ? offset : offset - 1];
	while (candidate && candidate.nodeType !== Node.TEXT_NODE) {
		candidate = isStartBoundary ? candidate.firstChild : candidate.lastChild;
	}
	if (!candidate) return null;
	return {
		node: candidate,
		offset: isStartBoundary ? 0 : candidate.data.length,
	};
}

function collectSourceRanges(mapping, source, start, end) {
	const startIndex = mapping.nodes.indexOf(start.node);
	const endIndex = mapping.nodes.indexOf(end.node);
	if (startIndex < 0 || endIndex < startIndex) return null;
	const ranges = [];
	for (let index = startIndex; index <= endIndex; index++) {
		const node = mapping.nodes[index];
		const beginOffset = index === startIndex ? start.offset : 0;
		const endOffset = index === endIndex ? end.offset : node.data.length;
		if (endOffset <= beginOffset) continue;
		const position = mapping.positions.get(node);
		if (!position) return null;
		const sourceStart = position.start + beginOffset;
		const sourceEnd = position.start + endOffset;
		const text = source.slice(sourceStart, sourceEnd);
		if (!text || text !== node.data.slice(beginOffset, endOffset)) return null;
		ranges.push({ start: sourceStart, end: sourceEnd, text });
	}
	return ranges.length ? ranges : null;
}

function findSelectedMarker(source, ranges, startMark) {
	const color = startMark.dataset.mdvColor;
	const openTag = `<mark data-mdv-color="${color}">`;
	const firstSelectedOffset = ranges[0].start;
	const selectionEnd = ranges.at(-1).end;
	const markerStart = source.lastIndexOf(openTag, firstSelectedOffset);
	const closeStart = source.indexOf(HIGHLIGHT_CLOSE_TAG, selectionEnd);
	if (markerStart < 0 || closeStart < selectionEnd) return null;
	const precedingContent = source.slice(
		markerStart + openTag.length,
		firstSelectedOffset,
	);
	if (precedingContent.includes(HIGHLIGHT_CLOSE_TAG)) return null;
	return {
		start: markerStart,
		end: closeStart + HIGHLIGHT_CLOSE_TAG.length,
		color,
	};
}

export function sourceRangesForSelection(selection, mapping, source) {
	if (!selection || selection.isCollapsed || selection.rangeCount !== 1)
		return null;
	const range = selection.getRangeAt(0);
	const start = textBoundary(range.startContainer, range.startOffset, true);
	const end = textBoundary(range.endContainer, range.endOffset, false);
	if (!start || !end) return null;
	const ranges = collectSourceRanges(mapping, source, start, end);
	if (!ranges) return null;

	const marks = [
		...range.startContainer.ownerDocument.querySelectorAll(
			"mark[data-mdv-color]",
		),
	].filter((mark) => range.intersectsNode(mark));
	if (!marks.length) return { ranges, marker: null };
	const startMark = start.node.parentElement?.closest("mark[data-mdv-color]");
	const endMark = end.node.parentElement?.closest("mark[data-mdv-color]");
	// Reject partial crossings and multiple markers; recolor/remove operates on one whole marker.
	if (marks.length !== 1 || !startMark || startMark !== endMark) return null;
	const marker = findSelectedMarker(source, ranges, startMark);
	return marker ? { ranges, marker } : null;
}
