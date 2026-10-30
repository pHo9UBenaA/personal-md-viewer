import { expect } from "@playwright/test";
import { openCopiedMarkdown, test } from "./helpers.mjs";

async function expectControlFonts(page) {
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
		await expect(page.locator("#reload")).toHaveCSS("font-size", "13px");
		await expect(page.locator("#reload")).toHaveCSS("height", "28px");
		await expect(page.locator("#filter")).toHaveCSS("height", "28px");
		await expectControlFonts(page);
		await expect(page.frameLocator("#content").locator("p").last()).toHaveCSS(
			"font-size",
			width <= 600 ? "15px" : "16px",
		);
		const overflow = () =>
			page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
		expect(await overflow()).toBe(false);
		await page.locator("#palette-open").click();
		await expect(page.locator("#command")).toHaveCSS("height", "28px");
		await expectControlFonts(page);
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
		await page.getByRole("tab").first().click({ button: "right" });
		await expect(page.locator("#tab-menu")).toBeVisible();
		await expectControlFonts(page);
		await page.keyboard.press("Escape");
		await page.keyboard.press("Control+f");
		await expect(page.locator("#find-query")).toBeFocused();
		await expect(page.locator("#find-query")).toHaveCSS("height", "28px");
		await expectControlFonts(page);
		await page.locator("#find-close").click();
		await page.getByRole("button", { name: "Raw", exact: true }).click();
		await expect(page.frameLocator("#content").locator("pre")).toHaveCSS(
			"font-size",
			"15px",
		);
		await page.getByRole("button", { name: "Preview", exact: true }).click();
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
