/**
 * @file Unit tests for safe Markdown rendering with rehype-sanitize.
 */

import { describe, expect, it } from "vitest";
import { renderMarkdownSafe } from "../src/markdown-safe";

describe("renderMarkdownSafe", () => {
	it("renders <details> with <summary>", async () => {
		const md = `
<details>
  <summary>More</summary>
  Hidden content
</details>
    `;
		const result = await renderMarkdownSafe(md);

		if (!result.ok) {
			throw result.error;
		}

		expect(result.data).toContain("<details>");
		expect(result.data).toContain("<summary>");
		expect(result.data).toContain("Hidden content");
	});

	it("removes <script> tags", async () => {
		const md = `<script>alert("xss")</script>`;
		const result = await renderMarkdownSafe(md);

		if (!result.ok) {
			throw result.error;
		}

		expect(result.data).not.toContain("<script>");
		expect(result.data).not.toContain('alert("xss")');
	});

	it("removes onclick attributes", async () => {
		const md = `<div onclick="alert('xss')">Click me</div>`;
		const result = await renderMarkdownSafe(md);

		if (!result.ok) {
			throw result.error;
		}

		expect(result.data).not.toContain("onclick");
	});

	it("allows safe inline HTML in markdown", async () => {
		const md = `# Title\n\n<div>Safe content</div>`;
		const result = await renderMarkdownSafe(md);

		if (!result.ok) {
			throw result.error;
		}

		expect(result.data).toContain("<h1>Title</h1>");
		expect(result.data).toContain("<div>Safe content</div>");
	});
});
