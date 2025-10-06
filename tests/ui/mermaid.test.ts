import { describe, expect, test } from "vitest";

import { renderLayout } from "../../src/ui/layout";

describe("renderLayout", () => {
	test("embeds the mermaid module into the page", async () => {
		const html = await renderLayout("Title", "<p>content</p>");

		expect(html).toContain(
			'<script type="module" src="/scripts/mermaid.client.js" defer></script>',
		);
	});
});
