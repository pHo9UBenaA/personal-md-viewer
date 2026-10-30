import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { openCopiedPath, openFolder, test } from "./helpers.mjs";

test("palette keyboard search opens the matching document and ignores blank queries", async ({
	folder,
	page,
}) => {
	await openFolder(page, folder);
	await page.keyboard.press("Control+Shift+P");
	await expect(page.getByRole("dialog")).toBeVisible();
	await expect(page.locator("#results button")).toHaveCount(0);
	await page.locator("#command").fill("  ");
	await expect(page.locator("#results button")).toHaveCount(0);
	expect(
		await page
			.locator("#palette")
			.evaluate((element) => element.getBoundingClientRect().width),
	).toBeGreaterThanOrEqual(600);
	const commandBox = await page.locator("#command").boundingBox();
	expect(commandBox.width).toBeGreaterThan(450);
	expect(commandBox.height).toBe(28);
	await page.locator("#command").fill("B.markdown");
	await expect(page.locator("#results button")).toHaveCount(1);
	await page.locator("#command").press("Enter");
	await expect(page.getByRole("dialog")).not.toBeVisible();
	await expect(
		page
			.frameLocator("#content")
			.getByRole("heading", { name: "Second document" }),
	).toBeVisible();
});

test("palette limits results while the tree filter keeps all matches", async ({
	page,
	viewer,
}) => {
	const directory = await mkdtemp(join(viewer.directory, "palette-limit-"));
	try {
		await Promise.all(
			Array.from({ length: 25 }, (_, index) =>
				writeFile(
					join(directory, `entry-${String(index).padStart(2, "0")}.md`),
					`# Entry ${index}`,
				),
			),
		);
		await page.goto("/");
		await openCopiedPath(page, directory);
		await expect(page.locator(".tree-file")).toHaveCount(25);
		await page.locator("#filter").fill("  ENTRY-  ");
		await expect(page.locator(".tree-file")).toHaveCount(25);
		await page.getByRole("button", { name: /コマンドパレット/ }).click();
		await page.locator("#command").fill("  ENTRY-  ");
		await expect(page.locator("#results button")).toHaveCount(20);
		await expect(page.locator("#results button").first()).toContainText(
			"entry-00.md",
		);
		await expect(page.locator("#results button").last()).toContainText(
			"entry-19.md",
		);
		await page.locator("#command").press("ArrowDown");
		await page.locator("#command").press("Enter");
		await expect(
			page
				.frameLocator("#content")
				.getByRole("heading", { name: "Entry 1", exact: true }),
		).toBeVisible();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("homepage inputs are absent and the command palette rejects outside paths", async ({
	page,
}) => {
	await page.goto("/");
	await expect(page.locator('input[type="file"]')).toHaveCount(0);
	await expect(page.locator("#empty input")).toHaveCount(0);
	await page.getByRole("button", { name: /コマンドパレット/ }).click();
	await page.locator("#command").fill("/outside/not-copied.md");
	await page.locator("#command").press("Enter");
	await expect(page.getByRole("status")).toContainText(
		"コピーしたファイルだけ",
	);
	await expect(page.getByRole("tab")).toHaveCount(0);
	await page.locator("#palette-close").click();
	await page.evaluate(() =>
		document.dispatchEvent(
			new DragEvent("drop", { bubbles: true, cancelable: true }),
		),
	);
	await expect(page.getByRole("status")).toContainText(
		"ドロップは利用できません",
	);
});

test("palette includes subfolders by default and the checkbox can opt out", async ({
	folder,
	page,
}) => {
	await page.goto("/");
	await page.getByRole("button", { name: /コマンドパレット/ }).click();
	await expect(page.locator("#palette-recursive")).toBeChecked();
	await page.locator("#command").fill(folder);
	await page.locator("#command").press("Enter");
	await expect(page.getByRole("tab")).toHaveCount(1);
	await page.getByRole("button", { name: /コマンドパレット/ }).click();
	await page.locator("#palette-recursive").uncheck();
	const request = page.waitForRequest("**/api/open");
	await page.locator("#command").fill(folder);
	await page.locator("#command").press("Enter");
	expect((await request).postDataJSON().recursive).toBe(false);
});

test("missing paths are recoverable and mobile opening remains usable", async ({
	folder,
	page,
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto("/");
	await expect(page.getByRole("status")).toContainText("pnpm copy-docs");
	await openCopiedPath(page, join(folder, "missing.md"));
	await expect(page.getByRole("status")).toContainText("見つかりません");
	await page.locator("#command").fill(join(folder, "A # %.md"));
	await page.locator("#command").press("Enter");
	await expect(
		page
			.frameLocator("#content")
			.getByRole("heading", { name: "First document", exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("tree", { name: "ファイルツリー" }),
	).toBeVisible();
	const dimensions = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		viewportWidth: innerWidth,
	}));
	expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.viewportWidth);
});
