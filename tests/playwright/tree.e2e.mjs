import { expect } from "@playwright/test";
import { openFolder, test } from "./helpers.mjs";

test("file tree preserves collapsed folders while filtering and supports keyboard expansion", async ({
	folder,
	page,
}) => {
	await openFolder(page, folder);
	const nestedFolder = page.getByRole("treeitem", {
		name: "nested フォルダー",
		exact: true,
	});
	await expect(nestedFolder).toHaveAttribute("aria-expanded", "true");
	await expect(
		page.getByRole("treeitem", { name: "B.markdown", exact: true }),
	).toBeVisible();
	await nestedFolder.locator(".tree-folder-row").click();
	await expect(nestedFolder).toHaveAttribute("aria-expanded", "false");
	await expect(
		page.getByRole("treeitem", { name: "B.markdown", exact: true }),
	).toBeHidden();
	await page.getByPlaceholder("ファイルを絞り込む").fill("B.markdown");
	await expect(
		page.getByRole("treeitem", { name: "B.markdown", exact: true }),
	).toBeVisible();
	await page.getByPlaceholder("ファイルを絞り込む").fill("");
	await expect(
		page.getByRole("treeitem", { name: "B.markdown", exact: true }),
	).toBeHidden();
	await nestedFolder.focus();
	await page.keyboard.press("ArrowRight");
	await expect(nestedFolder).toHaveAttribute("aria-expanded", "true");
});

test("file tree selection opens tabs and returns to cached documents", async ({
	folder,
	page,
}) => {
	await openFolder(page, folder);
	await page.getByRole("treeitem", { name: "B.markdown", exact: true }).click();
	await expect(page.getByRole("tab")).toHaveCount(2);
	await expect(
		page.frameLocator("#content").getByRole("heading", {
			name: "Second document",
		}),
	).toBeVisible();
	await page.getByRole("treeitem", { name: "A # %.md", exact: true }).click();
	await expect(
		page.frameLocator("#content").getByRole("heading", {
			name: "First document",
		}),
	).toBeVisible();
});

test("Command+Left collapses the hovered tree without closing the active tab", async ({
	folder,
	page,
}) => {
	await openFolder(page, folder);
	const tree = page.getByRole("tree", { name: "ファイルツリー" });
	const folders = tree.locator('.tree-folder[aria-expanded="true"]');
	await expect(folders).toHaveCount(2);
	await tree.hover();
	await page.keyboard.press("Meta+ArrowLeft");
	await expect(folders).toHaveCount(0);
	await expect(page.getByRole("tab")).toHaveCount(1);
	await expect(
		page.frameLocator("#content").getByRole("heading", {
			name: "First document",
		}),
	).toBeVisible();
	const rootFolder = tree.locator(".tree-folder").first();
	await rootFolder.focus();
	await page.keyboard.press("ArrowRight");
	await expect(rootFolder).toHaveAttribute("aria-expanded", "true");
	await expect(
		tree.getByRole("treeitem", { name: "nested フォルダー" }),
	).toHaveAttribute("aria-expanded", "false");
	await page.keyboard.press("Meta+ArrowLeft");
	await expect(folders).toHaveCount(0);
	await page.locator("#filter").fill("B.markdown");
	await expect(folders).toHaveCount(2);
	await tree.hover();
	await page.keyboard.press("Meta+ArrowLeft");
	await expect(folders).toHaveCount(0);
	await page.locator("#filter").fill("");
	await expect(folders).toHaveCount(0);
});
