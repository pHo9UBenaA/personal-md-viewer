import { expect } from "@playwright/test";
import { openCopiedMarkdown, test } from "./helpers.mjs";

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
			source: "# Compact\n\n`code`\n\nText.",
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
		await expect(page.locator("#filter")).toHaveCSS("height", "30px");
		const overflow = () =>
			page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
		expect(await overflow()).toBe(false);
		await page.locator("#palette-open").click();
		await expect(page.locator("#command")).toHaveCSS("height", "30px");
		const dimensions = await page.locator("#command").boundingBox();
		expect(dimensions.width).toBeGreaterThan(120);
		expect(dimensions.x + dimensions.width).toBeLessThanOrEqual(width);
		await page.keyboard.press("Escape");
		if (width === 1280) {
			await page.locator("#sidebar-resizer").focus();
			await page.keyboard.press("Home");
			const input = await page.locator("#filter").boundingBox();
			expect(input.width).toBeGreaterThan(140);
		}
		await page.locator("#theme-toggle").click();
		await expect(page.frameLocator("#content").locator("html")).toHaveCSS(
			"background-color",
			"rgb(251, 241, 199)",
		);
		expect(external).toEqual([]);
		const loaded = await page.evaluate(() =>
			[...document.fonts].some(
				(font) => font.family === "Viewer Sans" && font.status === "loaded",
			),
		);
		expect(loaded).toBe(true);
	});
}
