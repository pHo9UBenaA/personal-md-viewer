import { mkdtemp, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { openCopiedMarkdown, openCopiedPath, test } from "./helpers.mjs";

async function readerGeometry(page) {
	return page.evaluate(() =>
		Object.fromEntries(
			[".workspace", ".sidebar", "main", ".document-bar", "#content"].map(
				(selector) => {
					const { x, y, width, height } = document
						.querySelector(selector)
						.getBoundingClientRect();
					return [selector, { x, y, width, height }];
				},
			),
		),
	);
}

for (const width of [390, 1280]) {
	for (const dismissNotices of [false, true]) {
		test(`cold tab loading keeps reader geometry stable at ${width}px (dismissed=${dismissNotices})`, async ({
			page,
			viewer,
		}) => {
			const directory = await mkdtemp(join(viewer.directory, "layout-"));
			await writeFile(join(directory, "A.md"), "# A\n\nFirst document.");
			await writeFile(join(directory, "B.md"), "# B\n\nSecond document.");
			await page.setViewportSize({ width, height: 900 });
			await page.goto("/");
			await openCopiedPath(page, directory);
			await expect(
				page.frameLocator("#content").locator("body"),
			).toHaveAttribute("tabindex", "-1");
			await page
				.locator("#file-list > .tree-folder > .tree-folder-row")
				.click();
			if (dismissNotices) {
				await page
					.getByRole("button", { name: "ショートカットの案内を閉じる" })
					.click();
				await page
					.getByRole("button", { name: "通知を閉じる", exact: true })
					.click();
			}
			const before = await readerGeometry(page);
			const received = Promise.withResolvers();
			const released = Promise.withResolvers();
			await page.route("**/api/read", async (route) => {
				const response = await route.fetch();
				received.resolve();
				await released.promise;
				await route.fulfill({ response });
			});
			try {
				await page.getByRole("treeitem", { name: "B.md", exact: true }).click();
				await received.promise;
				await expect(
					page.getByRole("progressbar", { name: "本文を読み込み中" }),
				).toBeVisible();
				await expect(page.locator("#reader")).toHaveAttribute(
					"aria-busy",
					"true",
				);
				expect(await readerGeometry(page)).toEqual(before);
				released.resolve();
				await expect(page.frameLocator("#content").locator("h1")).toBeVisible();
				await expect(page.locator("#reader-loading")).toBeHidden();
				await expect(page.locator("#reader")).toHaveAttribute(
					"aria-busy",
					"false",
				);
				expect(await readerGeometry(page)).toEqual(before);
			} finally {
				released.resolve();
				await page.unrouteAll({ behavior: "wait" });
			}
		});
	}
}

test("a failed read removes the loading indicator and keeps the error dismissible", async ({
	page,
	viewer,
}) => {
	const path = await openCopiedMarkdown(page, viewer.directory, {
		name: "loading-error.md",
		source: "# Original",
	});
	await unlink(path);
	await page.locator("#reload").click();
	await expect(page.getByRole("status")).toContainText("見つかりません");
	await expect(page.locator("#reader-loading")).toBeHidden();
	await expect(page.locator("#reader")).toHaveAttribute("aria-busy", "false");
	await page.getByRole("button", { name: "通知を閉じる", exact: true }).click();
	await expect(page.locator("#status")).toHaveCount(0);
});
