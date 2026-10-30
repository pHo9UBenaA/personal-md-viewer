import { join } from "node:path";
import { expect } from "@playwright/test";
import { openCopiedPath, openFolder, test } from "./helpers.mjs";

test("theme persists and syncs the reader and browser tabs", async ({
	folder,
	page,
}) => {
	await page.emulateMedia({ colorScheme: "light" });
	await openFolder(page, folder);
	const toggle = page.locator("#theme-toggle");
	await expect(toggle).toHaveAccessibleName("ダークモードに切り替える");
	await expect(toggle.locator(".theme-icon")).toHaveCSS(
		"mask-image",
		/moon\.svg/,
	);
	await expect(page.frameLocator("#content").locator("html")).toHaveCSS(
		"color-scheme",
		"light",
	);
	await toggle.click();
	await expect(page.frameLocator("#content").locator("html")).toHaveCSS(
		"color-scheme",
		"dark",
	);
	await page.getByRole("treeitem", { name: "B.markdown", exact: true }).click();
	await expect(
		page
			.frameLocator("#content")
			.getByRole("heading", { name: "Second document" }),
	).toBeVisible();
	await expect(page.frameLocator("#content").locator("html")).toHaveCSS(
		"color-scheme",
		"dark",
	);
	await expect(page.locator("#separate-tab")).toHaveCount(0);
	const popup = await page.context().newPage();
	await popup.goto(page.url());
	await openCopiedPath(popup, join(folder, "nested/B.markdown"));
	await expect(
		popup
			.frameLocator("#content")
			.getByRole("heading", { name: "Second document" }),
	).toBeVisible();
	await expect(popup.locator("#theme-toggle")).toHaveAccessibleName(
		"ライトモードに切り替える",
	);
	await expect(toggle.locator(".theme-icon")).toHaveCSS(
		"mask-image",
		/sun\.svg/,
	);
	await toggle.click();
	await expect(popup.frameLocator("#content").locator("html")).toHaveCSS(
		"color-scheme",
		"light",
	);
	await popup.close();
	await page.emulateMedia({ colorScheme: "dark" });
	await page.reload();
	await expect(toggle).toHaveAccessibleName("ダークモードに切り替える");
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(toggle).toBeVisible();
	await toggle.click();
	await expect(toggle).toHaveAccessibleName("ライトモードに切り替える");
});
