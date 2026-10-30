import { findDocuments } from "./documents.js";
import { createButton } from "./dom.js";

const MAX_PALETTE_MATCHES = 20;

export function initializePalette({
	dialog,
	input,
	results,
	recursive,
	form,
	close,
	documents,
	activate,
	openPath,
	runAction,
}) {
	let paletteIndex = 0;
	let paletteMatches = [];

	function updatePalette() {
		const query = input.value.trim();
		paletteMatches = query
			? findDocuments(documents, query, MAX_PALETTE_MATCHES)
			: [];
		paletteIndex = Math.min(
			paletteIndex,
			Math.max(0, paletteMatches.length - 1),
		);
		results.replaceChildren(
			...paletteMatches.map(([key, doc], index) => {
				const node = createButton(doc.path ?? doc.label, () => {
					dialog.close();
					activate(key);
				});
				node.dataset.selected = String(index === paletteIndex);
				return node;
			}),
		);
	}

	function openPalette() {
		if (!dialog.open) dialog.showModal();
		input.value = "";
		paletteIndex = 0;
		updatePalette();
		input.focus();
	}
	close.addEventListener("click", () => dialog.close());
	input.addEventListener("input", () => {
		paletteIndex = 0;
		updatePalette();
	});
	input.addEventListener("keydown", (event) => {
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
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		const value = input.value.trim();
		if (!value) return;
		if (paletteMatches.length && !/^(?:\/|~|\.|[a-z]:[\\/])/i.test(value)) {
			dialog.close();
			activate(paletteMatches[paletteIndex][0]);
		} else runAction(() => openPath(value, recursive.checked));
	});
	return { open: openPalette };
}
