import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { createViewerServer } from "../../src/server.mjs";
import { closeServer, listenOnLoopback } from "../helpers/http.mjs";
import { openCopiedMarkdown, test } from "./helpers.mjs";

async function selectText(locator) {
	await locator.evaluate((element) => {
		const range = document.createRange();
		range.selectNodeContents(element);
		getSelection().removeAllRanges();
		getSelection().addRange(range);
	});
}

for (const allowHtml of [false, true]) {
	test(`table markers save the selected repeated cell (allowHtml=${allowHtml})`, async ({
		page,
		viewer,
	}) => {
		const file = join(viewer.directory, `table-${allowHtml}.md`);
		const source =
			"Before\n\n| 分類 | 目的 |\n|---|---|\n| 共通鍵暗号 | 機密性 |\n| 公開鍵暗号 | 機密性 |\n\nAfter";
		await writeFile(file, source);
		const server = await createViewerServer({
			contentDirectory: viewer.directory,
			initialPaths: [file],
			allowHtml,
		});
		const url = await listenOnLoopback(server);
		try {
			await page.goto(url);
			const cells = page.frameLocator("#content").locator("td");
			await selectText(cells.last());
			await expect(page.locator("#highlight-toolbar")).toBeVisible();
			await page.getByRole("button", { name: "黄色のマーカー" }).click();
			await expect(cells.last().locator("mark")).toHaveText("機密性");
			const offset = source.lastIndexOf("機密性");
			expect(await readFile(file, "utf8")).toBe(
				`${source.slice(0, offset)}<mark data-mdv-color="yellow">機密性</mark>${source.slice(offset + 3)}`,
			);
			await expect(cells.nth(1).locator("mark")).toHaveCount(0);
			await selectText(page.frameLocator("#content").locator("th").first());
			await expect(page.locator("#highlight-toolbar")).toBeVisible();
			await page.getByRole("button", { name: "青のマーカー" }).click();
			await expect(page.frameLocator("#content").locator("th mark")).toHaveText(
				"分類",
			);
			await selectText(page.frameLocator("#content").locator("p").last());
			await expect(page.locator("#highlight-toolbar")).toBeVisible();
		} finally {
			await closeServer(server);
		}
	});
}

test("selecting or focusing outside the preview clears the marker action", async ({
	page,
	viewer,
}) => {
	const file = await openCopiedMarkdown(page, viewer.directory, {
		name: "boundaries.md",
		source: "Preview text",
	});
	const toolbar = page.locator("#highlight-toolbar");
	const paragraph = page.frameLocator("#content").locator("p");
	await selectText(paragraph);
	await expect(toolbar).toBeVisible();
	await selectText(page.locator("#document-path"));
	await expect(toolbar).toBeHidden();
	await expect
		.poll(() =>
			page
				.locator("#content")
				.evaluate((frame) => frame.contentWindow.getSelection().toString()),
		)
		.toBe("");
	await page.locator("#document-path").dblclick();
	await expect(toolbar).toBeHidden();
	await paragraph.click();
	await selectText(paragraph);
	await expect(toolbar).toBeVisible();
	await page.locator("#filter").focus();
	await expect(toolbar).toBeHidden();
	expect(await readFile(file, "utf8")).toBe("Preview text");
});
