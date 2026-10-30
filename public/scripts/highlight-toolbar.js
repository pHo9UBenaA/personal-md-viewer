import { mapSourceText, sourceRangesForSelection } from "./selection.js";

export function initializeHighlightToolbar({
	toolbar,
	remove,
	getFrame,
	isCurrent,
	isSourceMode,
	onApply,
}) {
	let highlightSelection = null;
	let highlightListeners = null;
	function hide() {
		highlightSelection = null;
		toolbar.hidden = true;
	}
	function attach(frameDocument, doc, key, revision) {
		detach();
		const mapping = mapSourceText(frameDocument, doc.source);
		const frame = frameDocument.defaultView.frameElement;

		const controller = new AbortController();
		highlightListeners = controller;
		const position = () => {
			if (toolbar.hidden || !isCurrent(revision)) return;
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
			if (!isCurrent(revision) || isSourceMode()) return;
			if (!document.getSelection()?.isCollapsed) {
				hide();
				return;
			}
			const selected = sourceRangesForSelection(
				frameDocument.getSelection(),
				mapping,
				doc.source,
			);
			if (!selected) {
				hide();
				return;
			}
			highlightSelection = { key, revision, ...selected };
			toolbar.hidden = false;
			for (const button of toolbar.querySelectorAll("[data-highlight-color]")) {
				button.setAttribute(
					"aria-pressed",
					String(button.dataset.highlightColor === selected.marker?.color),
				);
			}
			remove.disabled = !selected.marker;
			position();
		};
		frameDocument.defaultView.addEventListener("scroll", position, {
			passive: true,
			signal: controller.signal,
		});
		window.addEventListener("resize", position, { signal: controller.signal });
		const clearSelection = () => {
			frameDocument.getSelection()?.removeAllRanges();
			hide();
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
		const options = { signal: controller.signal };
		frameDocument.addEventListener(
			"pointerdown",
			() => document.getSelection()?.removeAllRanges(),
			options,
		);
		frameDocument.addEventListener("selectionchange", update, options);
		frameDocument.addEventListener("mouseup", update, options);
		frameDocument.addEventListener("keyup", update, options);
		frameDocument.addEventListener(
			"click",
			(event) => {
				const mark = event.target.closest?.("mark[data-mdv-color]");
				const selection = frameDocument.getSelection();
				if (!mark || mark.closest("a") || !selection?.isCollapsed) return;
				const range = frameDocument.createRange();
				range.selectNodeContents(mark);
				selection.removeAllRanges();
				selection.addRange(range);
				update();
			},
			options,
		);
		update();
	}
	document.addEventListener("pointerdown", (event) => {
		if (!toolbar.contains(event.target)) {
			getFrame().contentWindow?.getSelection()?.removeAllRanges();
			hide();
		}
	});
	toolbar.addEventListener("click", (event) => {
		if (event.target.closest("#highlight-remove")) {
			onApply(null);
			return;
		}
		const color = event.target.closest("[data-highlight-color]")?.dataset
			.highlightColor;
		if (color) onApply(color);
	});
	function detach() {
		highlightListeners?.abort();
		highlightListeners = null;
		hide();
	}
	function dismiss() {
		getFrame().contentWindow?.getSelection()?.removeAllRanges();
		hide();
	}
	return {
		attach,
		detach,
		hide,
		dismiss,
		selection: () => highlightSelection,
		isVisible: () => !toolbar.hidden,
	};
}
