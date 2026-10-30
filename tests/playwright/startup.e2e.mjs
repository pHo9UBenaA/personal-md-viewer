import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { createViewerServer } from "../../src/server.mjs";
import { closeServer, listenOnLoopback } from "../helpers/http.mjs";
import { test } from "./helpers.mjs";

async function expectHomeNotice(page, hideNotices) {
	if (hideNotices) {
		await expect(page.locator("#shortcut-notice, #status")).toHaveCount(0);
		expect((await page.locator("#notices").boundingBox()).height).toBe(0);
	} else await expect(page.getByRole("status")).toContainText("ファイル一覧");
}

for (const scope of ["all", "folder", "file"]) {
	for (const hideNotices of [false, true]) {
		test(`fresh ${scope} startup shows the home page without reading a document (hideNotices=${hideNotices})`, async ({
			page,
			viewer,
		}) => {
			const directory = await mkdtemp(join(viewer.directory, "startup-"));
			const first = join(directory, "A.md");
			await writeFile(first, "# First note");
			await writeFile(join(directory, "B.md"), "# Second note");
			const initialPaths =
				scope === "all" ? [] : [scope === "file" ? first : directory];
			const server = await createViewerServer({
				contentDirectory: directory,
				initialPaths,
				hideNotices,
			});
			try {
				const url = await listenOnLoopback(server);
				let reads = 0;
				page.on("request", (request) => {
					if (request.url().endsWith("/api/read")) reads++;
				});
				await page.goto(url);
				await expect(page.locator("#file-list .tree-file")).toHaveCount(
					scope === "file" ? 1 : 2,
				);
				await expect(page.locator("#empty")).toBeVisible();
				await expect(page.getByRole("tab")).toHaveCount(0);
				await expect(page.locator("#reader")).toBeHidden();
				await expect(page.locator("#close-all")).toBeDisabled();
				expect(reads).toBe(0);
				await expectHomeNotice(page, hideNotices);

				await page.reload();
				await expectHomeNotice(page, hideNotices);
				await expect(page.locator("#empty")).toBeVisible();
				expect(reads).toBe(0);
				await page.locator("#filter").fill("A.md");
				await page.getByRole("treeitem", { name: "A.md", exact: true }).click();
				await expect(page.frameLocator("#content").locator("h1")).toHaveText(
					"First note",
				);
				await expect(page.locator("#close-all")).toBeEnabled();

				await page.goBack();
				await expect(page.locator("#empty")).toBeVisible();
				await expectHomeNotice(page, hideNotices);
				await page.goForward();
				await expect(page.frameLocator("#content").locator("h1")).toHaveText(
					"First note",
				);

				await page.reload();
				await expect(page.frameLocator("#content").locator("h1")).toHaveText(
					"First note",
				);
				await expect(page.locator("#close-all")).toBeEnabled();
				await page.locator("#close-all").click();
				await expect(page.locator("#empty")).toBeVisible();
				await expect(page.locator("#close-all")).toBeDisabled();
				const readsBeforeReload = reads;
				await page.reload();
				await expectHomeNotice(page, hideNotices);
				await expect(page.getByRole("tab")).toHaveCount(0);
				expect(reads).toBe(readsBeforeReload);

				const freshPage = await page.context().newPage();
				try {
					await freshPage.goto(url);
					await expectHomeNotice(freshPage, hideNotices);
					await expect(freshPage.locator("#empty")).toBeVisible();
					await expect(freshPage.getByRole("tab")).toHaveCount(0);
				} finally {
					await freshPage.close();
				}
			} finally {
				await closeServer(server);
			}
		});
	}
}
