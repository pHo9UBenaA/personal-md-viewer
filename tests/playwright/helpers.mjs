import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as baseTest, expect } from "@playwright/test";
import { createViewerServer } from "../../src/server.mjs";
import { closeServer, listenOnLoopback } from "../helpers/http.mjs";

// No test reads the user's content/. Each worker owns an initially empty copy directory.
export const test = baseTest.extend({
	folder: async ({ viewer }, use) => {
		const directory = await mkdtemp(
			join(viewer.directory, "viewer-browser-日本語-"),
		);
		try {
			await mkdir(join(directory, "nested"));
			await writeFile(
				join(directory, "A # %.md"),
				"# First document\n\n[Next](nested/B.markdown#second-document)\n\n## Outline entry\n\n![pixel](pixel.png)\n\n![tracker](https://example.com/tracker.png)\n\n<script>parent.pwned = true</script>",
			);
			await writeFile(
				join(directory, "nested/B.markdown"),
				"# Second document\n\nWorks.",
			);
			await writeFile(
				join(directory, "pixel.png"),
				Buffer.from(
					"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=",
					"base64",
				),
			);
			await use(directory);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	},
	tabDirectory: async ({ viewer }, use) => {
		const directory = await mkdtemp(join(viewer.directory, "tab-documents-"));
		try {
			for (const name of ["A", "B", "C"])
				await writeFile(
					join(directory, `${name}.md`),
					`# ${name}\n\n${"Paragraph.\n\n".repeat(80)}`,
				);
			await use(directory);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	},
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

export const activeTab = (page) =>
	page.locator('[role="tab"][aria-selected="true"]');

export async function openFolder(page, folder) {
	await page.goto("/");
	await expect(page.getByRole("status")).toContainText("pnpm copy-docs");
	await expect(page.locator("#open-form")).toHaveCount(0);
	await expect(page.locator("#palette-recursive")).toBeChecked();
	await openCopiedPath(page, folder);
	await expect(page.getByRole("tab")).toHaveCount(1);
	const rootFolder = page.locator("#file-list > .tree-folder");
	await expect(rootFolder).toHaveAttribute("aria-expanded", "false");
	await rootFolder.locator(":scope > .tree-folder-row").click();
	await page
		.getByRole("treeitem", { name: "nested フォルダー", exact: true })
		.locator(":scope > .tree-folder-row")
		.click();
	await expect(
		page.getByRole("treeitem", { name: "B.markdown" }),
	).toBeVisible();
	await expect(
		page
			.frameLocator("#content")
			.getByRole("heading", { name: "First document", exact: true }),
	).toBeVisible();
}

export async function openTabs(page, directory) {
	await page.goto("/");
	await openCopiedPath(page, directory);
	await page.locator("#filter").fill(".md");
	for (const name of ["B", "C"])
		await page
			.getByRole("treeitem", { name: `${name}.md`, exact: true })
			.click();
	await expect(page.frameLocator("#content").locator("h1")).toHaveText("C");
	await expect(page.frameLocator("#content").locator("body")).toHaveAttribute(
		"tabindex",
		"-1",
	);
	return directory;
}
