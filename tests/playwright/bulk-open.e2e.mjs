import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { openCopiedPath, test } from "./helpers.mjs";

async function registerMatches(page, viewer) {
	const directory = await mkdtemp(join(viewer.directory, "bulk-"));
	await mkdir(join(directory, "nested"));
	for (const file of [
		"match-z.md",
		"match-a.md",
		"nested/match-b.md",
		"unrelated.md",
	])
		await writeFile(
			join(directory, file),
			`# ${file}\n\n${"Reading paragraph.\n\n".repeat(100)}`,
		);
	await page.goto("/");
	await openCopiedPath(page, directory);
	await expect(page.locator("#palette")).toBeHidden();
}

test("bulk open is enabled only for a nonblank filter with matches", async ({
	page,
	viewer,
}) => {
	await registerMatches(page, viewer);
	const button = page.getByRole("button", {
		name: "まとめて開く",
		exact: true,
	});
	await expect(button).toBeDisabled();
	await expect(button).toHaveAttribute("title", "検索結果をすべてタブで開く");
	await page.locator("#filter").fill("missing-name");
	await expect(button).toBeDisabled();
	await expect(page.locator("#filter-count")).toHaveText("0 件");
	await page.locator("#filter").fill("  match-  ");
	await expect(button).toBeEnabled();
	await expect(page.locator("#filter-count")).toHaveText("3 件");
	await page.locator("#filter").fill("  ");
	await expect(button).toBeDisabled();
	await expect(page.locator("#filter-count")).toBeHidden();
});

test("bulk open includes collapsed matches without reading, duplicating or moving the current reader", async ({
	page,
	viewer,
}) => {
	await registerMatches(page, viewer);
	await page.locator("#filter").fill("match-");
	await page.getByRole("treeitem", { name: "match-z.md", exact: true }).click();
	await expect(page.frameLocator("#content").locator("h1")).toHaveText(
		"match-z.md",
	);
	const existing = await page.getByRole("tab").allTextContents();
	const matches = await page.locator("#file-list .tree-file").allTextContents();
	await page.locator("#file-list > .tree-folder > .tree-folder-row").click();
	await expect(
		page.getByRole("treeitem", { name: "match-b.md", exact: true }),
	).toBeHidden();
	await page.locator("#content").evaluate((frame) => {
		window.savedReader = frame;
		frame.contentWindow.scrollTo(0, 500);
	});
	let reads = 0;
	page.on("request", (request) => {
		if (request.url().endsWith("/api/read")) reads++;
	});
	const historyLength = await page.evaluate(() => history.length);
	await page.locator("#open-matches").click();
	expect(await page.getByRole("tab").allTextContents()).toEqual([
		...existing,
		...matches.filter((name) => !existing.includes(name)),
	]);
	expect(reads).toBe(0);
	expect(
		await page
			.locator("#content")
			.evaluate(
				(frame) =>
					window.savedReader === frame && frame.contentWindow.scrollY === 500,
			),
	).toBe(true);
	await expect(
		page.getByRole("tab", { name: "match-z.md", exact: true }),
	).toHaveAttribute("aria-selected", "true");
	await expect(page.locator('.tab[data-batch-selected="true"]')).toHaveCount(1);
	expect(await page.evaluate(() => history.length)).toBe(historyLength + 1);
	await page.locator("#open-matches").click();
	await expect(page.getByRole("status").locator(".notice-message")).toHaveText(
		"検索結果はすべて開いています。",
	);
	expect(await page.evaluate(() => history.length)).toBe(historyLength + 1);
	await page.evaluate(() => history.back());
	await expect
		.poll(() => page.getByRole("tab").allTextContents())
		.toEqual(existing);
});

test("bulk open with no active tab activates only the first tree result", async ({
	page,
	viewer,
}) => {
	await registerMatches(page, viewer);
	await page.locator("#close-all").click();
	await page.locator("#filter").fill("match-");
	const names = await page.locator("#file-list .tree-file").allTextContents();
	let reads = 0;
	page.on("request", (request) => {
		if (request.url().endsWith("/api/read")) reads++;
	});
	await page.locator("#open-matches").click();
	await expect(page.getByRole("tab")).toHaveCount(3);
	expect(await page.getByRole("tab").allTextContents()).toEqual(names);
	await expect(
		page.getByRole("tab", { name: names[0], exact: true }),
	).toHaveAttribute("aria-selected", "true");
	await expect(page.frameLocator("#content").locator("h1")).toHaveText(
		"nested/match-b.md",
	);
	expect(reads).toBe(1);
	await expect(page.locator('.tab[data-batch-selected="true"]')).toHaveCount(1);
});

for (const count of [50, 51]) {
	test(`bulk open confirms only when adding at least 50 tabs (${count} matches)`, async ({
		page,
		viewer,
	}) => {
		const directory = await mkdtemp(join(viewer.directory, "many-matches-"));
		await Promise.all(
			Array.from({ length: count }, (_, index) =>
				writeFile(
					join(directory, `entry-${String(index).padStart(2, "0")}.md`),
					`# Entry ${index}`,
				),
			),
		);
		await page.goto("/");
		await openCopiedPath(page, directory);
		await expect(page.locator("#palette")).toBeHidden();
		await page.locator("#filter").fill("entry-");
		let reads = 0;
		page.on("request", (request) => {
			if (request.url().endsWith("/api/read")) reads++;
		});
		await page.locator("#open-matches").click();
		if (count === 51) {
			await expect(page.locator("#open-matches-confirm")).toBeVisible();
			await expect(page.locator("#open-matches-message")).toHaveText(
				"50 件のタブを追加します。本文は、そのタブを表示したときに読み込みます。",
			);
			await expect(page.locator("#open-matches-cancel")).toBeFocused();
			await page.keyboard.press("Control+Tab");
			await page.keyboard.press("Control+Shift+2");
			await expect(page.locator("#open-matches-cancel")).toBeFocused();
			await page.keyboard.press("Escape");
			await expect(page.getByRole("tab")).toHaveCount(1);
			await page.locator("#open-matches").click();
			await page.locator("#open-matches-cancel").click();
			await expect(page.getByRole("tab")).toHaveCount(1);
			await page.locator("#open-matches").click();
			await page.locator("#open-matches-accept").click();
		} else await expect(page.locator("#open-matches-confirm")).toBeHidden();
		await expect(page.getByRole("tab")).toHaveCount(count);
		expect(reads).toBe(0);
		await expect(
			page.getByRole("tab", { name: "entry-00.md", exact: true }),
		).toHaveAttribute("aria-selected", "true");
	});
}
