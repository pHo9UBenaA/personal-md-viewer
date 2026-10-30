import { expect } from "@playwright/test";
import { openCopiedMarkdown, test } from "./helpers.mjs";

async function expectControls(page) {
	const controls = page.locator(
		'button, input[type="text"], input[type="search"], #file-list .tree-folder-row',
	);
	await expect
		.poll(() =>
			controls.evaluateAll((elements) =>
				elements
					.filter((element) => getComputedStyle(element).fontSize !== "13px")
					.map((element) => element.id || element.textContent),
			),
		)
		.toEqual([]);
	for (const control of await controls.filter({ visible: true }).all()) {
		await expect(control).toHaveCSS("height", "28px");
	}
	// Use glyph bounds, not just the line box: BIZ UDPGothic sits high in it.
	const offCenter = await page
		.locator("button:visible")
		.evaluateAll((buttons) => {
			const context = document.createElement("canvas").getContext("2d");
			return buttons.flatMap((button) => {
				const text = [...button.childNodes].find(
					(node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim(),
				);
				if (!text) return [];
				context.font = getComputedStyle(button).font;
				const metrics = context.measureText(text.textContent.trim());
				const range = document.createRange();
				range.selectNodeContents(text);
				const baseline =
					range.getBoundingClientRect().bottom - metrics.fontBoundingBoxDescent;
				const glyphCenter =
					baseline +
					(metrics.actualBoundingBoxDescent - metrics.actualBoundingBoxAscent) /
						2;
				const box = button.getBoundingClientRect();
				const offset = glyphCenter - (box.y + box.height / 2);
				return Math.abs(offset) > 1.5
					? [{ label: text.textContent.trim(), offset }]
					: [];
			});
		});
	expect(offCenter).toEqual([]);
}

for (const width of [320, 390, 1280]) {
	test(`compact Gruvbox controls and local fonts fit a ${width}px viewport`, async ({
		page,
		viewer,
	}) => {
		await page.setViewportSize({ width, height: 900 });
		await page.emulateMedia({ colorScheme: "dark" });
		const external = [];
		page.on("request", (request) => {
			if (
				!request.url().startsWith(new URL(viewer.url).origin) &&
				!request.url().startsWith("blob:")
			)
				external.push(request.url());
		});
		await openCopiedMarkdown(page, viewer.directory, {
			name: "compact.md",
			source: "# Compact\n\n## 見出し\n\n`code`\n\nText.",
		});
		await page.evaluate(() => document.fonts.ready);
		await expect(page.locator("html")).toHaveCSS("font-size", "16px");
		await expect(page.frameLocator("#content").locator("html")).toHaveCSS(
			"background-color",
			"rgb(29, 32, 33)",
		);
		await expect(page.frameLocator("#content").locator("code")).toHaveCSS(
			"font-size",
			"15px",
		);
		await expect(page.locator("#reload")).toHaveCSS("font-size", "13px");
		await expect(page.locator("#reload")).toHaveCSS("height", "28px");
		await expect(page.locator("#filter")).toHaveCSS("height", "28px");
		await expectControls(page);
		await expect(page.frameLocator("#content").locator("p").last()).toHaveCSS(
			"font-size",
			width <= 600 ? "15px" : "16px",
		);
		const overflow = () =>
			page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
		expect(await overflow()).toBe(false);
		await page.locator("#palette-open").click();
		await expect(page.locator("#command")).toHaveCSS("height", "28px");
		await page.locator("#command").fill("compact");
		await expect(page.locator("#results button")).toHaveCount(1);
		await expectControls(page);
		const dimensions = await page.locator("#command").boundingBox();
		expect(dimensions.width).toBeGreaterThan(120);
		expect(dimensions.x + dimensions.width).toBeLessThanOrEqual(width);
		await page.keyboard.press("Escape");
		await page.locator("#filter").fill("compact");
		await expect(page.locator("#file-list .tree-file")).toBeVisible();
		await expectControls(page);
		if (width === 1280) {
			await page.locator("#sidebar-resizer").focus();
			await page.keyboard.press("Home");
			const input = await page.locator("#filter").boundingBox();
			expect(input.width).toBeGreaterThan(140);
		}
		await page.getByRole("tab").first().click({ button: "right" });
		await expect(page.locator("#tab-menu")).toBeVisible();
		await expectControls(page);
		await page.keyboard.press("Escape");
		await page.keyboard.press("Control+f");
		await expect(page.locator("#find-query")).toBeFocused();
		await expect(page.locator("#find-query")).toHaveCSS("height", "28px");
		await expectControls(page);
		await page.locator("#find-close").click();
		await page.getByRole("button", { name: "Raw", exact: true }).click();
		await expect(page.frameLocator("#content").locator("pre")).toHaveCSS(
			"font-size",
			"15px",
		);
		await page.getByRole("button", { name: "Preview", exact: true }).click();
		await page.locator("#focus-toggle").click();
		await expectControls(page);
		await page
			.frameLocator("#content")
			.locator("p")
			.last()
			.evaluate((element) => {
				const range = document.createRange();
				range.selectNodeContents(element);
				const selection = getSelection();
				selection.removeAllRanges();
				selection.addRange(range);
			});
		await expect(page.locator("#highlight-toolbar")).toBeVisible();
		await expectControls(page);
		await page.keyboard.press("Escape");
		await page.locator("#focus-toggle").click();
		await page.locator("#theme-toggle").click();
		await expect(page.frameLocator("#content").locator("html")).toHaveCSS(
			"background-color",
			"rgb(251, 241, 199)",
		);
		expect(external).toEqual([]);
		const loaded = await page.evaluate(() =>
			[...document.fonts].some(
				(font) => font.family === "BIZ UDPGothic" && font.status === "loaded",
			),
		);
		expect(loaded).toBe(true);
	});
}
