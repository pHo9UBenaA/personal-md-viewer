export const HIGHLIGHT_COLORS = new Set([
	"green",
	"yellow",
	"orange",
	"pink",
	"blue",
]);

export const highlightOpenTag = (color) => `<mark data-mdv-color="${color}">`;

export function renderHighlightTags(html) {
	return html
		.replace(
			/&lt;mark data-mdv-color=&quot;(green|yellow|orange|pink|blue)&quot;&gt;/g,
			'<mark data-mdv-color="$1">',
		)
		.replace(/&lt;\/mark&gt;/g, "</mark>");
}
