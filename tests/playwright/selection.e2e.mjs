import { expect, test } from "@playwright/test";

const markerSource = '<mark data-mdv-color="yellow">marked</mark>';
const cases = [
	{
		name: "literal Unicode text uses UTF-16 source offsets",
		source: "あ😀text",
		selector: "p",
		expected: {
			ranges: [{ start: 0, end: 7, text: "あ😀text" }],
			marker: null,
		},
	},
	{
		name: "emphasis and adjacent text produce separate source ranges",
		source: "**bold** plain",
		selector: "p",
		expected: {
			ranges: [
				{ start: 2, end: 6, text: "bold" },
				{ start: 8, end: 14, text: " plain" },
			],
			marker: null,
		},
	},
	{
		name: "one existing marker resolves to its whole source tag",
		source: markerSource,
		selector: "mark",
		expected: {
			ranges: [
				{
					start: markerSource.indexOf("marked"),
					end: markerSource.indexOf("</mark>"),
					text: "marked",
				},
			],
			marker: { start: 0, end: markerSource.length, color: "yellow" },
		},
	},
	{
		name: "inline code is not highlightable",
		source: "`code`",
		selector: "code",
		expected: null,
	},
	{
		name: "decoded entities are not literal source text",
		source: "&amp;",
		selector: "p",
		expected: null,
	},
	{
		name: "escaped Markdown is not literal source text",
		source: "\\*escaped*",
		selector: "p",
		expected: null,
	},
	{
		name: "a selection across multiple markers is rejected",
		source: `${markerSource} ${markerSource}`,
		selector: "p",
		expected: null,
	},
];

for (const { name, source, selector, expected } of cases) {
	test(`sourceRangesForSelection: ${name}`, async ({ page }) => {
		await page.goto("/");
		await page.locator("#files").setInputFiles({
			name: "selection.md",
			mimeType: "text/markdown",
			buffer: Buffer.from(source),
		});
		await expect(
			page.frameLocator("#content").locator(selector).first(),
		).toBeVisible();
		const selectedRanges = await page.evaluate(
			async ({ source, selector }) => {
				const { mapSourceText, sourceRangesForSelection } = await import(
					"/selection.js"
				);
				const readerDocument =
					document.getElementById("content").contentDocument;
				const range = readerDocument.createRange();
				range.selectNodeContents(readerDocument.querySelector(selector));
				const selection = readerDocument.getSelection();
				selection.removeAllRanges();
				selection.addRange(range);
				return sourceRangesForSelection(
					selection,
					mapSourceText(readerDocument, source),
					source,
				);
			},
			{ source, selector },
		);
		expect(selectedRanges).toEqual(expected);
	});
}
