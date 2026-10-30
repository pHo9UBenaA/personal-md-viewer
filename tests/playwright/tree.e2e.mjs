import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { createViewerServer } from "../../src/server.mjs";
import { closeServer, listenOnLoopback } from "../helpers/http.mjs";
import { openCopiedPath, openFolder, test } from "./helpers.mjs";

for (const allowHtml of [false, true]) {
	test(`tree starts with copied directories and direct Markdown files (allowHtml=${allowHtml})`, async ({
		page,
		viewer,
	}) => {
		const directory = await mkdtemp(join(viewer.directory, "tree-root-"));
		await mkdir(join(directory, "notes/content"), { recursive: true });
		await mkdir(join(directory, "work"));
		await writeFile(join(directory, "README.md"), "# Welcome");
		const nested = join(directory, "notes/content/Intro.md");
		await writeFile(nested, "# Introduction");
		await writeFile(join(directory, "work/Task.md"), "# Task");
		const server = await createViewerServer({
			contentDirectory: directory,
			allowHtml,
		});
		try {
			await page.goto(await listenOnLoopback(server));
			const topFolders = page.locator(
				"#file-list > .tree-folder > .tree-folder-row",
			);
			await expect(topFolders).toHaveText(["notes", "work"]);
			const directFile = page.locator("#file-list > .tree-file");
			await expect(directFile).toHaveText("README.md");
			await expect(directFile).toHaveAttribute("aria-level", "1");
			await expect(page.getByRole("tab")).toHaveCount(0);
			const notes = page.getByRole("treeitem", {
				name: "notes フォルダー",
				exact: true,
			});
			await expect(notes).toHaveAttribute("aria-expanded", "false");
			await notes.focus();
			await page.keyboard.press("ArrowRight");
			await expect(notes).toHaveAttribute("aria-expanded", "true");
			const content = page.getByRole("treeitem", {
				name: "content フォルダー",
				exact: true,
			});
			await expect(content).toBeVisible();
			await expect(content).toHaveAttribute("aria-level", "2");
			await expect(content).toHaveAttribute("aria-expanded", "false");

			await page.locator("#filter").fill("Intro.md");
			await page
				.getByRole("treeitem", { name: "Intro.md", exact: true })
				.click();
			await expect(page.frameLocator("#content").locator("h1")).toHaveText(
				"Introduction",
			);
			await page.locator("#filter").fill("");
			await expect(content).toHaveAttribute("aria-expanded", "false");
			await openCopiedPath(page, nested);
			await expect(topFolders).toHaveText(["notes", "work"]);
			await expect(page.locator("#file-list .tree-file")).toHaveCount(3);
			await page.reload();
			await expect(topFolders).toHaveText(["notes", "work"]);
			await expect(page.locator("#file-list .tree-file")).toHaveCount(3);
			await expect(page.frameLocator("#content").locator("h1")).toHaveText(
				"Introduction",
			);
		} finally {
			await closeServer(server);
		}
	});
}

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
