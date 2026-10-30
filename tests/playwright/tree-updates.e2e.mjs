import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { openCopiedPath, openFolder, test } from "./helpers.mjs";

async function observeNavigation(page) {
	await page.evaluate(() => {
		window.navigationObserver?.disconnect();
		window.navigationRebuilds = { tree: 0, tabs: 0 };
		const tree = document.getElementById("file-list");
		const tabs = document.getElementById("tabs");
		window.navigationObserver = new MutationObserver((records) => {
			for (const record of records) {
				if (record.target === tree) window.navigationRebuilds.tree++;
				if (record.target === tabs) window.navigationRebuilds.tabs++;
			}
		});
		window.navigationObserver.observe(document.querySelector(".workspace"), {
			childList: true,
			subtree: true,
		});
	});
}

async function pauseClock(page) {
	const now = new Date();
	await page.clock.install({ time: now });
	await page.clock.pauseAt(now);
}

const rebuilds = (page) => page.evaluate(() => window.navigationRebuilds);

test("tree filtering waits for a pause in typing and never redraws tabs or the reader", async ({
	page,
	folder,
}) => {
	await openFolder(page, folder);
	await pauseClock(page);
	await observeNavigation(page);
	await page.locator("#content").evaluate((frame) => {
		window.savedFrame = frame;
	});
	const filter = page.locator("#filter");
	await filter.fill("B");
	await page.clock.runFor(100);
	await filter.fill("B.markdown");
	await expect(page.locator("#open-matches")).toBeDisabled();
	await expect(page.locator("#file-list")).toHaveAttribute("aria-busy", "true");
	await page.clock.runFor(149);
	expect(await rebuilds(page)).toEqual({ tree: 0, tabs: 0 });
	await page.clock.runFor(1);
	await expect(page.locator("#filter-count")).toHaveText("1 件");
	await expect(page.locator("#open-matches")).toBeEnabled();
	await expect(page.locator("#file-list")).toHaveAttribute(
		"aria-busy",
		"false",
	);
	expect(await rebuilds(page)).toEqual({ tree: 1, tabs: 0 });
	expect(
		await page
			.locator("#content")
			.evaluate((frame) => frame === window.savedFrame),
	).toBe(true);

	// Old matching results must not remain actionable while a new query is pending.
	await filter.fill("missing");
	await expect(page.locator("#open-matches")).toBeDisabled();
	await page.clock.runFor(150);
	await expect(page.locator("#filter-count")).toHaveText("0 件");
	await expect(page.locator("#open-matches")).toBeDisabled();
	expect(await rebuilds(page)).toEqual({ tree: 2, tabs: 0 });
});

test("Japanese composition defers filtering until the committed input settles", async ({
	page,
	folder,
}) => {
	await openFolder(page, folder);
	await pauseClock(page);
	await observeNavigation(page);
	const filter = page.locator("#filter");
	await filter.dispatchEvent("compositionstart");
	await filter.fill("未");
	await page.clock.runFor(1000);
	expect(await rebuilds(page)).toEqual({ tree: 0, tabs: 0 });
	await filter.fill("未登録");
	await filter.dispatchEvent("compositionend");
	await page.clock.runFor(149);
	expect(await rebuilds(page)).toEqual({ tree: 0, tabs: 0 });
	await page.clock.runFor(1);
	await expect(page.locator("#filter-count")).toHaveText("0 件");
	expect(await rebuilds(page)).toEqual({ tree: 1, tabs: 0 });
});

test("a thousand registered files are filtered once per typing burst without reading bodies", async ({
	page,
	viewer,
}) => {
	const directory = await mkdtemp(join(viewer.directory, "large-tree-"));
	await Promise.all(
		Array.from({ length: 1000 }, (_, index) =>
			writeFile(
				join(directory, `entry-${String(index).padStart(4, "0")}.md`),
				`# Entry ${index}`,
			),
		),
	);
	await page.goto("/");
	await openCopiedPath(page, directory);
	await expect(page.locator("#file-list .tree-file")).toHaveCount(1000);
	await pauseClock(page);
	await observeNavigation(page);
	let reads = 0;
	page.on("request", (request) => {
		if (request.url().endsWith("/api/read")) reads++;
	});
	for (const query of ["e", "en", "ent", "entry-09"])
		await page.locator("#filter").fill(query);
	expect(await rebuilds(page)).toEqual({ tree: 0, tabs: 0 });
	await page.clock.runFor(150);
	await expect(page.locator("#filter-count")).toHaveText("100 件");
	await expect(page.locator("#file-list .tree-file")).toHaveCount(100);
	expect(await rebuilds(page)).toEqual({ tree: 1, tabs: 0 });
	expect(reads).toBe(0);
});

test("tab navigation reuses the tree, and folder toggles do not redraw tabs", async ({
	page,
	folder,
}) => {
	await openFolder(page, folder);
	await observeNavigation(page);
	const nextFile = page.getByRole("treeitem", {
		name: "B.markdown",
		exact: true,
	});
	await nextFile.click();
	await expect(page.frameLocator("#content").locator("h1")).toHaveText(
		"Second document",
	);
	await expect(nextFile).toHaveAttribute("aria-current", "true");
	await expect(
		page.getByRole("treeitem", { name: "A # %.md", exact: true }),
	).toHaveAttribute("aria-current", "false");
	expect((await rebuilds(page)).tree).toBe(0);
	await observeNavigation(page);
	await page
		.getByRole("treeitem", { name: "nested フォルダー", exact: true })
		.locator(":scope > .tree-folder-row")
		.click();
	expect(await rebuilds(page)).toEqual({ tree: 1, tabs: 0 });
});
