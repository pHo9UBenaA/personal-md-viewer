import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { createViewerServer } from "../../src/server.mjs";
import { closeServer, listenOnLoopback } from "../helpers/http.mjs";
import { openFolder, test } from "./helpers.mjs";

test("back and forward restore copied files and open tabs during the session", async ({
	folder,
	page,
}) => {
	await openFolder(page, folder);
	await page.getByRole("treeitem", { name: "B.markdown" }).click();
	await expect(page.getByRole("tab")).toHaveCount(2);
	const third = join(folder, "C.md");
	await writeFile(third, "# Third document");
	await page.getByRole("button", { name: /コマンドパレット/ }).click();
	await page.locator("#command").fill(third);
	await page.locator("#command").press("Enter");
	await expect(page.getByRole("tab")).toHaveCount(3);
	await expect(
		page.frameLocator("#content").getByRole("heading", {
			name: "Third document",
		}),
	).toBeVisible();
	await page.evaluate(() => history.back());
	await expect(page.getByRole("tab")).toHaveCount(2);
	await expect(
		page.frameLocator("#content").getByRole("heading", {
			name: "Second document",
		}),
	).toBeVisible();
	await expect(page.getByRole("treeitem", { name: "C.md" })).toBeVisible();
	await page.evaluate(() => history.back());
	await expect(page.getByRole("tab")).toHaveCount(1);
	await expect(
		page.frameLocator("#content").getByRole("heading", {
			name: "First document",
		}),
	).toBeVisible();
	await page.evaluate(() => history.back());
	await expect(page.getByRole("tab")).toHaveCount(0);
	await expect(page.getByRole("treeitem", { name: "C.md" })).toBeVisible();
	await page.evaluate(() => history.forward());
	await expect(page.getByRole("tab")).toHaveCount(1);
	await page.evaluate(() => history.forward());
	await expect(page.getByRole("tab")).toHaveCount(2);
	await page.evaluate(() => history.forward());
	await expect(page.getByRole("tab")).toHaveCount(3);
	await expect(
		page.frameLocator("#content").getByRole("heading", {
			name: "Third document",
		}),
	).toBeVisible();
	await page.getByRole("button", { name: "すべて閉じる" }).click();
	await expect(page.getByRole("tab")).toHaveCount(0);
	await expect(page.getByRole("treeitem", { name: "C.md" })).toBeVisible();
	await page.evaluate(() => history.back());
	await expect(page.getByRole("tab")).toHaveCount(3);
	await expect(
		page.frameLocator("#content").getByRole("heading", {
			name: "Third document",
		}),
	).toBeVisible();
	await page.evaluate(() => history.forward());
	await expect(page.getByRole("tab")).toHaveCount(0);
	await expect(page.getByRole("treeitem", { name: "C.md" })).toBeVisible();
});

test("reload and history navigation reopen copied path tabs", async ({
	folder,
	page,
}) => {
	await openFolder(page, folder);
	await page.getByRole("treeitem", { name: "B.markdown" }).click();
	await page.reload();
	await expect(page.getByRole("tab")).toHaveCount(2);
	await expect(page.getByRole("tab", { name: "B.markdown" })).toHaveAttribute(
		"aria-selected",
		"true",
	);
	await expect(
		page.frameLocator("#content").getByRole("heading", {
			name: "Second document",
		}),
	).toBeVisible();
	await page.evaluate(() => history.back());
	await expect(page.getByRole("tab")).toHaveCount(1);
	await expect(
		page.frameLocator("#content").getByRole("heading", {
			name: "First document",
		}),
	).toBeVisible();
	await page
		.frameLocator("#content")
		.getByRole("link", { name: "Next" })
		.click();
	await expect(
		page.frameLocator("#content").getByRole("heading", {
			name: "Second document",
		}),
	).toBeVisible();
	await page.reload();
	await expect(page.getByRole("tab")).toHaveCount(2);
	await expect(
		page
			.frameLocator("#content")
			.getByRole("heading", { name: "Second document" }),
	).toBeVisible();
});

test("initial folders remain in the tree after restoring tabs on reload", async ({
	page,
}) => {
	const root = await mkdtemp(join(tmpdir(), "viewer-initial-folders-"));
	const first = join(root, "first-folder");
	const second = join(root, "second-folder");
	await mkdir(first);
	await mkdir(second);
	await writeFile(join(first, "A.md"), "# First note");
	await writeFile(join(first, "B.md"), "# Unopened note");
	await writeFile(join(second, "C.md"), "# Selected note");
	const server = await createViewerServer({
		contentDirectory: root,
		initialPaths: [first, second],
	});
	const url = await listenOnLoopback(server);
	try {
		await page.goto(url);
		await expect(page.locator("#file-list .tree-file")).toHaveCount(3);
		await page.locator("#filter").fill("C.md");
		await page.getByRole("treeitem", { name: "C.md", exact: true }).click();
		await page.reload();
		await expect(page.locator("#file-list .tree-file")).toHaveCount(3);
		await expect(page.getByRole("tab", { name: "C.md" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		await page.locator("#filter").fill("B.md");
		await page.getByRole("treeitem", { name: "B.md", exact: true }).click();
		await expect(
			page.frameLocator("#content").getByRole("heading", {
				name: "Unopened note",
			}),
		).toBeVisible();
	} finally {
		await closeServer(server);
		await rm(root, { recursive: true, force: true });
	}
});

test("forged history cannot reopen a file outside the copy directory", async ({
	page,
}) => {
	const outside = await mkdtemp(join(tmpdir(), "viewer-outside-"));
	const path = join(outside, "secret.md");
	await writeFile(path, "# Outside secret");
	try {
		await page.goto("/");
		await expect(page.getByRole("status")).toContainText("pnpm copy-docs");
		await page.evaluate(
			({ path, root }) => {
				history.replaceState(
					{
						...history.state,
						active: path,
						tabs: [path],
						paths: [{ path, root }],
					},
					"",
				);
			},
			{ path, root: outside },
		);
		await page.reload();
		await expect(page.getByRole("tab")).toHaveCount(0);
		await expect(page.getByRole("status")).toContainText(
			"コピーしたファイルだけ",
		);
		await expect(page.getByText("Outside secret")).toHaveCount(0);
	} finally {
		await rm(outside, { recursive: true, force: true });
	}
});

test("deleted path tabs are skipped during history restoration", async ({
	folder,
	page,
}) => {
	await openFolder(page, folder);
	await page.getByRole("treeitem", { name: "B.markdown" }).click();
	const file = join(folder, "nested/B.markdown");
	const original = await readFile(file);
	try {
		await rm(file);
		await page.reload();
		await expect(page.getByRole("tab")).toHaveCount(1);
		await expect(page.getByRole("status")).toContainText(
			"復元できませんでした",
		);
		await expect(
			page.frameLocator("#content").getByRole("heading", {
				name: "First document",
			}),
		).toBeVisible();
	} finally {
		await writeFile(file, original);
	}
});
