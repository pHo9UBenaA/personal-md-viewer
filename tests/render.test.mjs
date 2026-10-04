import assert from "node:assert/strict";
import { test } from "node:test";
import { renderMarkdown } from "../src/render.mjs";

test("renderMarkdown escapes active HTML, unsafe links and code info; images stay inert", () => {
	const source = [
		"<script>alert(1)</script>",
		"<img src=x onerror=alert(1)>",
		"[x](javascript:alert(1))",
		"![remote](https://evil.example/track)",
		"[safe](nested/b.md)",
		'```js" onmouseover="alert(1)\n<script>\n```',
	].join("\n\n");
	const html = renderMarkdown(source);
	assert.doesNotMatch(
		html,
		/<script|<img src|href="javascript:|<[^>]+\sonerror=/,
	);
	assert.match(html, /data-image="https:\/\/evil.example\/track"/);
	assert.match(html, /&lt;script&gt;/);
	assert.match(html, /data-link="nested\/b.md"/);
	assert.doesNotMatch(html, /<a\b[^>]*\shref=/);
});

test("renderMarkdown renders only fixed highlight tags when raw HTML is disabled", () => {
	const html = renderMarkdown(
		'Plain <mark data-mdv-color="pink">marked</mark> text.\n\n<mark data-mdv-color="pink" onclick="alert(1)">unsafe</mark>',
	);
	assert.match(html, /<mark data-mdv-color="pink">marked<\/mark>/);
	assert.doesNotMatch(html, /<mark[^>]+onclick=/);
	assert.match(html, /&lt;mark data-mdv-color=&quot;pink&quot; onclick=/);
});

const commentCases = [
	{ name: "block comment", source: "<!-- hidden -->", expected: "" },
	{
		name: "inline comment",
		source: "before <!-- hidden --> after",
		expected: "<p>before  after</p>\n",
	},
	{
		name: "blank lines in a comment",
		source: "<!-- first\n\nlast -->",
		expected: "",
	},
	{
		name: "text after a multiline comment",
		source: "<!-- first\n\nlast --> after",
		expected: "<p>after</p>\n",
	},
	{
		name: "inline code preserves comments",
		source: "`<!-- example -->`",
		expected: "<p><code>&lt;!-- example --&gt;</code></p>\n",
	},
	{
		name: "fenced code preserves comments",
		source: "```md\n<!-- example -->\n```",
		expected:
			'<pre><code class="language-md">&lt;!-- example --&gt;\n</code></pre>\n',
	},
	{
		name: "escaped comment stays visible",
		source: "\\<!-- example -->",
		expected: "<p>&lt;!-- example --&gt;</p>\n",
	},
];
for (const { name, source, expected } of commentCases) {
	test(`renderMarkdown comment handling: ${name}`, () => {
		assert.equal(renderMarkdown(source), expected);
	});
}

test("renderMarkdown raw HTML requires opt-in and renders details while omitting comments", () => {
	const source =
		"<!-- hidden -->\n\n<details>\n<summary>詳細</summary>\n\n**本文**\n\n</details>";
	const escapedHtml = renderMarkdown(source);
	const rawHtml = renderMarkdown(source, { allowHtml: true });
	assert.match(escapedHtml, /&lt;details&gt;/);
	assert.doesNotMatch(escapedHtml, /hidden/);
	assert.match(rawHtml, /<details>/);
	assert.match(rawHtml, /<summary>詳細<\/summary>/);
	assert.match(rawHtml, /<strong>本文<\/strong>/);
	assert.doesNotMatch(rawHtml, /hidden/);
	assert.equal(
		renderMarkdown("<!-- draft\n\nhidden\n--> after", { allowHtml: true }),
		"<p>after</p>\n",
	);
});
