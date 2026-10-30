import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { activeTab, openTabs, test } from "./helpers.mjs";
import { command } from "./keyboard.mjs";

test("reopening a batch restores order and link scope, with fresh lazy content", async ({
	page,
	tabDirectory,
}) => {
	const directory = await openTabs(page, tabDirectory);
	await page.locator("#close-all").click();
	await writeFile(join(directory, "B.md"), "# Updated B");
	let restores = 0;
	let reads = 0;
	page.on("request", (request) => {
		if (request.url().endsWith("/api/restore")) restores++;
		if (request.url().endsWith("/api/read")) reads++;
	});
	const before = await page.evaluate(() => history.length);
	await command(page, "t", { shift: true });
	await expect(page.getByRole("tab")).toHaveCount(3);
	expect(await page.getByRole("tab").allTextContents()).toEqual([
		"A.md",
		"B.md",
		"C.md",
	]);
	await expect(page.frameLocator("#content").locator("h1")).toHaveText("C");
	await expect(activeTab(page)).toHaveText("C.md");
	await expect(page.locator('.tab[data-batch-selected="true"]')).toHaveCount(1);
	expect(restores).toBe(3);
	expect(reads).toBe(1);
	expect(await page.evaluate(() => history.length)).toBe(before + 1);
	await page.getByRole("tab", { name: "B.md", exact: true }).click();
	await expect(page.frameLocator("#content").locator("h1")).toHaveText(
		"Updated B",
	);
	await expect(page.locator("#reopen-closed")).toBeDisabled();
});

test("reopening skips a copied file replaced by an outside symlink", async ({
	page,
	tabDirectory,
}) => {
	const directory = await openTabs(page, tabDirectory);
	const outside = await mkdtemp(join(tmpdir(), "viewer-reopen-outside-"));
	try {
		await writeFile(join(outside, "secret.md"), "# Must not display");
		await page.locator("#close-all").click();
		await rm(join(directory, "B.md"));
		await symlink(join(outside, "secret.md"), join(directory, "B.md"));
		await page.locator("#reopen-closed").click();
		await expect(page.getByRole("tab")).toHaveCount(2);
		await expect(page.getByRole("status")).toContainText(
			"復元できませんでした",
		);
		await expect(page.frameLocator("#content").locator("h1")).toHaveText("C");
		expect(await page.getByRole("tab").allTextContents()).toEqual([
			"A.md",
			"C.md",
		]);
	} finally {
		await rm(outside, { recursive: true, force: true });
	}
});

test("a late reopen cannot replace a newer navigation and remains available to retry", async ({
	page,
	tabDirectory,
}) => {
	await openTabs(page, tabDirectory);
	await page
		.getByRole("button", { name: "B.md を閉じる", exact: true })
		.click();
	const received = Promise.withResolvers();
	const released = Promise.withResolvers();
	await page.route("**/api/restore", async (route) => {
		const response = await route.fetch();
		received.resolve();
		await released.promise;
		await route.fulfill({ response });
	});
	try {
		await command(page, "t", { shift: true });
		await received.promise;
		await page.getByRole("treeitem", { name: "A.md", exact: true }).click();
		await expect(page.frameLocator("#content").locator("h1")).toHaveText("A");
		released.resolve();
		await expect(page.locator("body")).not.toHaveAttribute("aria-busy", "true");
		expect(await page.getByRole("tab").allTextContents()).toEqual([
			"A.md",
			"C.md",
		]);
		await expect(page.locator("#reopen-closed")).toBeEnabled();
	} finally {
		released.resolve();
		await page.unrouteAll({ behavior: "wait" });
	}
	await page.locator("#reopen-closed").click();
	await expect(page.frameLocator("#content").locator("h1")).toHaveText("B");
	expect(await page.getByRole("tab").allTextContents()).toEqual([
		"A.md",
		"B.md",
		"C.md",
	]);
});
