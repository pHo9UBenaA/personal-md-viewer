import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createViewerServer } from "../../src/server.mjs";

let folder;
test("trusted HTML opens details without executing scripts", async ({
	page,
}) => {
	const server = await createViewerServer({ allowHtml: true });
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	try {
		await page.goto(`http://127.0.0.1:${server.address().port}`);
		await page.locator("#files").setInputFiles({
			name: "details.md",
			mimeType: "text/markdown",
			buffer: Buffer.from(
				"<!-- 作業用本文 -->\n\n<details>\n<summary>詳細</summary>\n\n**本文**\n\n</details>\n<script>parent.__rawHtmlRan = true</script>",
			),
		});
		const details = page.frameLocator("#content").locator("details");
		await expect(details.locator("summary")).toBeVisible();
		await expect(details.locator("strong")).toBeHidden();
		await details.locator("summary").click();
		await expect(details.locator("strong")).toBeVisible();
		expect(await page.evaluate(() => window.__rawHtmlRan)).toBeUndefined();
	} finally {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	}
});
test("imports over 200 documents lazily and accepts a drop onto the reader", async ({
	page,
}) => {
	await page.goto("/");
	await expect(page.getByRole("status")).toContainText("パス入力");
	let renders = 0;
	page.on("request", (request) => {
		if (request.url().endsWith("/api/render")) renders++;
	});
	await page.locator("#files").setInputFiles(
		Array.from({ length: 201 }, (_, index) => ({
			name: `${String(index).padStart(3, "0")}.md`,
			mimeType: "text/markdown",
			buffer: Buffer.from(`# Document ${index}`),
		})),
	);
	await expect(page.getByRole("tab")).toHaveCount(1);
	await expect(page.getByRole("treeitem")).toHaveCount(201);
	await expect(
		page
			.frameLocator("#content")
			.getByRole("heading", { name: "Document 0", exact: true }),
	).toBeVisible();
	expect(renders).toBe(1);
	await page.getByRole("treeitem", { name: "200.md", exact: true }).click();
	await expect(page.getByRole("tab")).toHaveCount(2);
	await expect(
		page
			.frameLocator("#content")
			.getByRole("heading", { name: "Document 200", exact: true }),
	).toBeVisible();
	expect(renders).toBe(2);
	await page.evaluate(() => {
		const frame = document.getElementById("content").contentDocument;
		const transfer = new DataTransfer();
		transfer.items.add(
			new File(["# Dropped document"], "dropped.md", { type: "text/markdown" }),
		);
		frame.dispatchEvent(
			new DragEvent("drop", {
				dataTransfer: transfer,
				bubbles: true,
				cancelable: true,
			}),
		);
	});
	await expect(page.getByRole("tab")).toHaveCount(3);
	await expect(page.getByRole("treeitem")).toHaveCount(202);
	await expect(
		page
			.frameLocator("#content")
			.getByRole("heading", { name: "Dropped document" }),
	).toBeVisible();
});
test("theme persists and syncs the reader and browser tabs", async ({
	page,
}) => {
	await page.emulateMedia({ colorScheme: "light" });
	await openFolder(page);
	const toggle = page.getByRole("button", {
		name: "ダークモード",
		exact: true,
	});
	await expect(toggle).toHaveAttribute("aria-pressed", "false");
	await expect(page.frameLocator("#content").locator("html")).toHaveCSS(
		"color-scheme",
		"light",
	);
	await toggle.click();
	await expect(page.frameLocator("#content").locator("html")).toHaveCSS(
		"color-scheme",
		"dark",
	);
	await page.getByRole("treeitem", { name: "B.markdown", exact: true }).click();
	await expect(
		page
			.frameLocator("#content")
			.getByRole("heading", { name: "Second document" }),
	).toBeVisible();
	await expect(page.frameLocator("#content").locator("html")).toHaveCSS(
		"color-scheme",
		"dark",
	);
	const popupPromise = page.waitForEvent("popup");
	await page.getByRole("link", { name: "別タブで開く" }).click();
	const popup = await popupPromise;
	await expect(
		popup
			.frameLocator("#content")
			.getByRole("heading", { name: "Second document" }),
	).toBeVisible();
	await expect(
		popup.getByRole("button", { name: "ダークモード", exact: true }),
	).toHaveAttribute("aria-pressed", "true");
	await toggle.click();
	await expect(popup.frameLocator("#content").locator("html")).toHaveCSS(
		"color-scheme",
		"light",
	);
	await popup.close();
	await page.emulateMedia({ colorScheme: "dark" });
	await page.reload();
	await expect(toggle).toHaveAttribute("aria-pressed", "false");
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(toggle).toBeVisible();
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-pressed", "true");
});
test.beforeAll(async () => {
	folder = await mkdtemp(join(tmpdir(), "viewer-browser-日本語-"));
	await mkdir(join(folder, "nested"));
	await writeFile(
		join(folder, "A # %.md"),
		"# First document\n\n[Next](nested/B.markdown#second-document)\n\n## Outline entry\n\n![pixel](pixel.png)\n\n![tracker](https://example.com/tracker.png)\n\n<script>parent.pwned = true</script>",
	);
	await writeFile(
		join(folder, "nested/B.markdown"),
		"# Second document\n\nWorks.",
	);
	await writeFile(
		join(folder, "pixel.png"),
		Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=",
			"base64",
		),
	);
});
test.afterAll(async () => {
	await rm(folder, { recursive: true, force: true });
});
async function openFolder(page) {
	await page.goto("/");
	await expect(page.getByRole("status")).toContainText("パス入力");
	await expect(page.locator("#recursive")).toBeChecked();
	await expect(page.locator("#palette-recursive")).toBeChecked();
	await page
		.getByLabel("ファイル・フォルダーのパス", { exact: true })
		.fill(folder);
	await page
		.locator("#open-form")
		.getByRole("button", { name: "開く", exact: true })
		.click();
	await expect(page.getByRole("tab")).toHaveCount(1);
	await expect(
		page.getByRole("treeitem", { name: "B.markdown" }),
	).toBeVisible();
	await expect(
		page
			.frameLocator("#content")
			.getByRole("heading", { name: "First document", exact: true }),
	).toBeVisible();
}
test("folder tabs, relative links, local images, no remote requests or HTML execution", async ({
	page,
}) => {
	const remote = [];
	page.on("request", (request) => {
		if (request.url().startsWith("https://")) remote.push(request.url());
	});
	await openFolder(page);
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
	await expect(page.frameLocator("#content").locator("img")).toHaveAttribute(
		"src",
		/^blob:/,
	);
	await expect(
		page.frameLocator("#content").locator(".image-note"),
	).toContainText("外部画像");
	expect(await page.evaluate(() => window.pwned)).toBeUndefined();
	expect(remote).toEqual([]);
	// Even if active markup reached the iframe, its stricter CSP blocks scripts.
	await page.evaluate(() => {
		const doc = document.getElementById("content").contentDocument;
		const script = doc.createElement("script");
		script.textContent = "parent.cspBypassed = true";
		doc.body.append(script);
		const img = doc.createElement("img");
		img.setAttribute("onerror", "parent.cspBypassed = true");
		doc.body.append(img);
		img.dispatchEvent(new Event("error"));
	});
	expect(await page.evaluate(() => window.cspBypassed)).toBeUndefined();
	await page
		.frameLocator("#content")
		.getByRole("link", { name: "Next" })
		.click();
	await expect(
		page
			.frameLocator("#content")
			.getByRole("heading", { name: "Second document" }),
	).toBeVisible();
	await expect(page.getByRole("tab")).toHaveCount(2);
});
test("palette keyboard search, source view, close active tab and close all", async ({
	page,
}) => {
	await openFolder(page);
	await page.keyboard.press("Control+Shift+P");
	await expect(page.getByRole("dialog")).toBeVisible();
	await expect(page.locator("#results button")).toHaveCount(0);
	await page.locator("#command").fill("  ");
	await expect(page.locator("#results button")).toHaveCount(0);
	expect(
		await page
			.locator("#palette")
			.evaluate((element) => element.getBoundingClientRect().width),
	).toBeGreaterThan(700);
	const commandBox = await page.locator("#command").boundingBox();
	expect(commandBox.width).toBeGreaterThan(500);
	expect(commandBox.height).toBeGreaterThanOrEqual(48);
	await page.locator("#command").fill("B.markdown");
	await expect(page.locator("#results button")).toHaveCount(1);
	await page.locator("#command").press("Enter");
	await expect(page.getByRole("dialog")).not.toBeVisible();
	await expect(
		page
			.frameLocator("#content")
			.getByRole("heading", { name: "Second document" }),
	).toBeVisible();
	await page.getByRole("button", { name: "ソース", exact: true }).click();
	await expect(page.frameLocator("#content").locator("pre")).toContainText(
		"# Second document",
	);
	await page
		.getByRole("button", { name: "nested/B.markdown を閉じる", exact: true })
		.click();
	await expect(page.getByRole("tab")).toHaveCount(1);
	await expect(
		page.getByRole("treeitem", { name: "B.markdown" }),
	).toBeVisible();
	await expect(page.frameLocator("#content").locator("pre")).toContainText(
		"# First document",
	);
	await page
		.getByRole("button", { name: "A # %.md を閉じる", exact: true })
		.click();
	await expect(page.getByRole("tab")).toHaveCount(0);
	await page.getByRole("treeitem", { name: "B.markdown" }).click();
	await expect(page.getByRole("tab")).toHaveCount(1);
	await page.getByRole("button", { name: "すべて閉じる" }).click();
	await expect(page.getByRole("tab")).toHaveCount(0);
	await expect(
		page.getByRole("treeitem", { name: "B.markdown" }),
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "パスから、すぐ読む。" }),
	).toBeVisible();
});
test("focus mode fills the viewport and can be toggled from the reader", async ({
	page,
}) => {
	await openFolder(page);
	const toggle = page.locator("#focus-toggle");
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-pressed", "true");
	await expect(page.locator(".toolbar")).toBeHidden();
	await expect(page.locator("#sidebar")).toBeHidden();
	await expect(page.locator("#tabs")).toBeHidden();
	const frameWidth = await page
		.locator("#content")
		.evaluate((element) => element.getBoundingClientRect().width);
	expect(frameWidth).toBe(1280);
	await expect(
		page.frameLocator("#content").getByRole("heading", {
			name: "First document",
		}),
	).toBeVisible();
	await page.frameLocator("#content").locator("body").press("Control+Shift+F");
	await expect(page.locator(".toolbar")).toBeVisible();
	await expect(toggle).toHaveAttribute("aria-pressed", "false");
	await toggle.click();
	await page.keyboard.press("Escape");
	await expect(page.locator(".toolbar")).toBeVisible();
	await expect(page.getByRole("tab")).toHaveCount(1);
});
test("Command+Left collapses the hovered tree without closing the active tab", async ({
	page,
}) => {
	await openFolder(page);
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
test("back and forward restore imported files and open tabs during the session", async ({
	page,
}) => {
	await openFolder(page);
	await page.getByRole("treeitem", { name: "B.markdown" }).click();
	await expect(page.getByRole("tab")).toHaveCount(2);
	await page.locator("#files").setInputFiles({
		name: "C.md",
		mimeType: "text/markdown",
		buffer: Buffer.from("# Third document"),
	});
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
test("reload and history navigation reopen path tabs, while imports need selection again", async ({
	page,
}) => {
	await openFolder(page);
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
	await page.locator("#files").setInputFiles({
		name: "C.md",
		mimeType: "text/markdown",
		buffer: Buffer.from("# Imported document"),
	});
	await expect(page.getByRole("tab")).toHaveCount(3);
	await page.reload();
	await expect(page.getByRole("tab")).toHaveCount(2);
	await expect(page.getByRole("status")).toContainText(
		"再度取り込んでください",
	);
	await expect(
		page.frameLocator("#content").getByRole("heading", {
			name: "Second document",
		}),
	).toBeVisible();
});
test("an imported-only history entry explains why it cannot survive reload", async ({
	page,
}) => {
	await page.goto("/");
	await page.locator("#files").setInputFiles({
		name: "imported.md",
		mimeType: "text/markdown",
		buffer: Buffer.from("# Imported document"),
	});
	await expect(page.getByRole("tab")).toHaveCount(1);
	await page.reload();
	await expect(page.getByRole("tab")).toHaveCount(0);
	await expect(page.getByRole("status")).toContainText(
		"再度取り込んでください",
	);
	await page.locator("#files").setInputFiles({
		name: "imported.md",
		mimeType: "text/markdown",
		buffer: Buffer.from("# Imported again"),
	});
	await expect(
		page.frameLocator("#content").getByRole("heading", {
			name: "Imported again",
		}),
	).toBeVisible();
});
test("deleted path tabs are skipped during history restoration", async ({
	page,
}) => {
	await openFolder(page);
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
test("sidebar width can be dragged, adjusted by keyboard, and restored", async ({
	page,
}) => {
	await openFolder(page);
	const sidebar = page.locator("#sidebar");
	const resizer = page.getByRole("separator", { name: "サイドバーの幅" });
	const originalWidth = await sidebar.evaluate(
		(element) => element.getBoundingClientRect().width,
	);
	const handle = await resizer.boundingBox();
	await page.mouse.move(handle.x + handle.width / 2, handle.y + 80);
	await page.mouse.down();
	await page.mouse.move(handle.x + handle.width / 2 + 120, handle.y + 80);
	await page.mouse.up();
	await expect(resizer).toHaveAttribute(
		"aria-valuenow",
		String(originalWidth + 120),
	);
	await resizer.focus();
	await page.keyboard.press("ArrowLeft");
	const adjustedWidth = originalWidth + 100;
	await expect(resizer).toHaveAttribute("aria-valuenow", String(adjustedWidth));
	await page.reload();
	await expect(resizer).toHaveAttribute("aria-valuenow", String(adjustedWidth));
	await expect
		.poll(() =>
			sidebar.evaluate((element) => element.getBoundingClientRect().width),
		)
		.toBe(adjustedWidth);
	await page.setViewportSize({ width: 390, height: 820 });
	await page.setViewportSize({ width: 1280, height: 820 });
	await expect(resizer).toHaveAttribute("aria-valuenow", String(adjustedWidth));
});
test("native folder input reads file content without pretending it has absolute paths", async ({
	page,
}) => {
	await page.goto("/");
	await expect(page.getByRole("status")).toContainText("パス入力");
	await page.locator("#add-menu summary").click();
	await expect(
		page.getByRole("button", { name: "ファイルを選択" }),
	).toBeVisible();
	const chooser = page.waitForEvent("filechooser");
	await page.getByRole("button", { name: "フォルダーを選択" }).click();
	await (await chooser).setFiles(folder);
	await expect(page.locator("#add-menu")).not.toHaveAttribute("open", "");
	await expect(page.getByRole("tab")).toHaveCount(1);
	await expect(
		page.getByRole("treeitem", { name: "nested フォルダー" }),
	).toBeVisible();
	await expect(
		page
			.frameLocator("#content")
			.getByRole("heading", { name: "First document", exact: true }),
	).toBeVisible();
	await expect(page.frameLocator("#content").locator("img")).toHaveAttribute(
		"src",
		/^blob:/,
	);
	await expect(page.getByRole("button", { name: "再読み込み" })).toBeDisabled();
	await page
		.frameLocator("#content")
		.getByRole("link", { name: "Next" })
		.click();
	await expect(
		page
			.frameLocator("#content")
			.getByRole("heading", { name: "Second document" }),
	).toBeVisible();
});
test("palette includes subfolders by default and the checkbox can opt out", async ({
	page,
}) => {
	await page.goto("/");
	await page.getByRole("button", { name: /開く・検索/ }).click();
	await expect(page.locator("#palette-recursive")).toBeChecked();
	await page.locator("#command").fill(folder);
	await page.locator("#command").press("Enter");
	await expect(page.getByRole("tab")).toHaveCount(1);
	await page.getByRole("button", { name: /開く・検索/ }).click();
	await page.locator("#palette-recursive").uncheck();
	const request = page.waitForRequest("**/api/open");
	await page.locator("#command").fill(folder);
	await page.locator("#command").press("Enter");
	expect((await request).postDataJSON().recursive).toBe(false);
});
test("missing paths are recoverable and mobile opening remains usable", async ({
	page,
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto("/");
	await expect(page.getByRole("status")).toContainText("パス入力");
	await page.locator("#path").fill(join(folder, "missing.md"));
	await page.locator("#open-form button").click();
	await expect(page.getByRole("status")).toContainText("見つかりません");
	await page.locator("#path").fill(join(folder, "A # %.md"));
	await page.locator("#open-form button").click();
	await expect(
		page
			.frameLocator("#content")
			.getByRole("heading", { name: "First document", exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("tree", { name: "ファイルツリー" }),
	).toBeVisible();
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= innerWidth,
		),
	).toBe(true);
});

test("late read responses cannot replace the current document; reload reads disk changes", async ({
	page,
}) => {
	await openFolder(page);
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	let markStarted;
	const started = new Promise((resolve) => {
		markStarted = resolve;
	});
	await page.route("**/api/read", async (route) => {
		const response = await route.fetch();
		markStarted();
		await gate;
		await route.fulfill({ response });
	});
	try {
		await page
			.getByRole("treeitem", { name: "B.markdown", exact: true })
			.click();
		await started;
		await page.getByRole("tab", { name: "A # %.md", exact: true }).click();
		const heading = page
			.frameLocator("#content")
			.getByRole("heading", { name: "First document", exact: true });
		await expect(heading).toBeVisible();
		const lateResponse = page.waitForResponse("**/api/read");
		release();
		await (await lateResponse).finished();
		// Let the delivered fetch continuation and iframe rendering run before asserting.
		await page.evaluate(
			() =>
				new Promise((resolve) =>
					requestAnimationFrame(() => requestAnimationFrame(resolve)),
				),
		);
		await expect(heading).toBeVisible();
		await expect(
			page.getByRole("tab", { name: "A # %.md", exact: true }),
		).toHaveAttribute("aria-selected", "true");
	} finally {
		release();
		await page.unrouteAll({ behavior: "wait" });
	}
	const file = join(folder, "A # %.md");
	const original = await readFile(file);
	try {
		await writeFile(file, "# Updated on disk");
		await page.getByRole("button", { name: "再読み込み", exact: true }).click();
		await expect(
			page
				.frameLocator("#content")
				.getByRole("heading", { name: "Updated on disk" }),
		).toBeVisible();
	} finally {
		await writeFile(file, original);
	}
});
