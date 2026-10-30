import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as baseTest, expect } from "@playwright/test";
import { createViewerServer } from "../../src/server.mjs";
import { closeServer, listenOnLoopback } from "../helpers/http.mjs";

// No test reads the user's content/. Each worker owns an initially empty copy directory.
export const test = baseTest.extend({
	viewer: [
		async ({ browserName }, use) => {
			const directory = await realpath(
				await mkdtemp(join(tmpdir(), `viewer-e2e-${browserName}-`)),
			);
			const server = await createViewerServer({ contentDirectory: directory });
			try {
				const url = await listenOnLoopback(server);
				await use({ directory, url });
			} finally {
				await closeServer(server);
				await rm(directory, { recursive: true, force: true });
			}
		},
		{ scope: "worker" },
	],
	baseURL: async ({ viewer }, use) => use(viewer.url),
});

export async function openCopiedPath(page, path) {
	await page.locator("#palette-open").click();
	await page.locator("#command").fill(path);
	const opened = page.waitForResponse("**/api/open");
	await page.locator("#command").press("Enter");
	if ((await opened).ok()) await expect(page.locator("#palette")).toBeHidden();
}

export async function openCopiedMarkdown(page, directory, { name, source }) {
	const path = join(directory, name);
	await writeFile(path, source);
	await page.goto("/");
	await openCopiedPath(page, path);
	await expect(page.getByRole("tab", { name, exact: true })).toBeVisible();
	return path;
}
