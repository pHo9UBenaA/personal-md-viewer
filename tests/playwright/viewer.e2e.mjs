import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { createViewerServer } from "../../src/server.mjs";
import { closeServer, listenOnLoopback } from "../helpers/http.mjs";
import { openCopiedMarkdown, test } from "./helpers.mjs";

let folder;
test("trusted HTML opens details without executing scripts", async ({
	page,
}) => {
	const root = await mkdtemp(join(tmpdir(), "viewer-trusted-html-"));
	await writeFile(
		join(root, "details.md"),
		"<!-- 作業用本文 -->\n\n<details>\n<summary>詳細</summary>\n\n**本文**\n\n</details>\n<script>parent.__rawHtmlRan = true</script>",
	);
	const server = await createViewerServer({
		contentDirectory: root,
		allowHtml: true,
	});
	const url = await listenOnLoopback(server);
	try {
		await page.goto(url);
		const details = page.frameLocator("#content").locator("details");
		await expect(details.locator("summary")).toBeVisible();
		await expect(details.locator("strong")).toBeHidden();
		await details.locator("summary").click();
		await expect(details.locator("strong")).toBeVisible();
		expect(await page.evaluate(() => window.__rawHtmlRan)).toBeUndefined();
	} finally {
		await closeServer(server);
		await rm(root, { recursive: true, force: true });
	}
});
test("fenced code wraps long lines without horizontal scrolling", async ({
	page,
	viewer,
}) => {
	await page.setViewportSize({ width: 500, height: 820 });
	await openCopiedMarkdown(page, viewer.directory, {
		name: "code.md",
		source: `\`\`\`txt\n${"longword".repeat(100)}\n${"word ".repeat(100)}\n\`\`\``,
	});
	const pre = page.frameLocator("#content").locator("pre");
	await expect(pre).toBeVisible();
	await expect(pre).toHaveCSS("white-space", "pre-wrap");
	const dimensions = await pre.evaluate((element) => ({
		scrollWidth: element.scrollWidth,
		clientWidth: element.clientWidth,
	}));
	expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
});
test("copied folders load documents lazily and reject a drop onto the reader", async ({
	page,
	viewer,
}) => {
	const many = await mkdtemp(join(viewer.directory, "many-"));
	await Promise.all(
		Array.from({ length: 201 }, (_, index) =>
			writeFile(
				join(many, `${String(index).padStart(3, "0")}.md`),
				`# Document ${index}`,
			),
		),
	);
	await page.goto("/");
	let reads = 0;
	page.on("request", (request) => {
		if (request.url().endsWith("/api/read")) reads++;
	});
	await page.locator("#path").fill(many);
	await page.locator("#open-form button").click();
	await expect(page.getByRole("tab")).toHaveCount(1);
	await expect(page.locator(".tree-file")).toHaveCount(201);
	await expect(
		page
			.frameLocator("#content")
			.getByRole("heading", { name: "Document 0", exact: true }),
	).toBeVisible();
	expect(reads).toBe(1);
	await page.getByRole("treeitem", { name: "200.md", exact: true }).click();
	await expect(page.getByRole("tab")).toHaveCount(2);
	await expect(
		page
			.frameLocator("#content")
			.getByRole("heading", { name: "Document 200", exact: true }),
	).toBeVisible();
	expect(reads).toBe(2);
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
	await expect(page.getByRole("status")).toContainText(
		"ドロップは利用できません",
	);
	await expect(page.getByRole("tab")).toHaveCount(2);
	await expect(page.locator(".tree-file")).toHaveCount(201);
	await expect(
		page
			.frameLocator("#content")
			.getByRole("heading", { name: "Dropped document" }),
	).toHaveCount(0);
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
test("highlights can be added, recolored, and removed without leaving focus mode", async ({
	page,
}) => {
	const root = await mkdtemp(join(tmpdir(), "viewer-highlights-"));
	const file = join(root, "highlights.md");
	const source =
		"# Marker test\n\nChoose **important words** now." +
		"\n\nMore text.".repeat(100);
	await writeFile(file, source);
	const server = await createViewerServer({
		contentDirectory: root,
		initialPaths: [file],
	});
	const url = await listenOnLoopback(server);
	try {
		await page.goto(url);
		const focus = page.locator("#focus-toggle");
		await focus.click();
		await page
			.frameLocator("#content")
			.locator("strong")
			.evaluate((element) => {
				const range = document.createRange();
				range.selectNodeContents(element);
				const selection = getSelection();
				selection.removeAllRanges();
				selection.addRange(range);
			});
		const toolbar = page.getByRole("toolbar", { name: "マーカーの色" });
		await expect(toolbar).toBeVisible();
		const selectionBox = await page.locator("#content").evaluate((frame) => {
			const frameBox = frame.getBoundingClientRect();
			const rangeBox = frame.contentWindow
				.getSelection()
				.getRangeAt(0)
				.getBoundingClientRect();
			return {
				x: frameBox.left + rangeBox.left,
				y: frameBox.top + rangeBox.top,
			};
		});
		const popupBox = await toolbar.boundingBox();
		expect(Math.abs(popupBox.x - selectionBox.x)).toBeLessThan(250);
		expect(popupBox.y + popupBox.height).toBeLessThan(selectionBox.y);
		await page
			.locator("#content")
			.evaluate((frame) => frame.contentWindow.scrollTo(0, 600));
		await expect(toolbar).toBeHidden();
		await page
			.locator("#content")
			.evaluate((frame) => frame.contentWindow.scrollTo(0, 0));
		await expect(toolbar).toBeVisible();
		await page.setViewportSize({ width: 390, height: 844 });
		await expect
			.poll(async () => (await toolbar.boundingBox()).x)
			.toBeGreaterThanOrEqual(0);
		const mobileBox = await toolbar.boundingBox();
		expect(mobileBox.x + mobileBox.width).toBeLessThanOrEqual(390);
		await expect(
			page.getByRole("button", { name: "マーカーを外す" }),
		).toBeDisabled();
		await page.getByRole("button", { name: "黄色のマーカー" }).click();
		await expect(focus).toHaveAttribute("aria-pressed", "true");
		const mark = page.frameLocator("#content").locator("mark");
		await expect(mark).toHaveAttribute("data-mdv-color", "yellow");
		expect(await readFile(file, "utf8")).toContain(
			'<mark data-mdv-color="yellow">important words</mark>',
		);

		await mark.click();
		await expect(toolbar).toBeVisible();
		await expect(
			page.getByRole("button", { name: "黄色のマーカー" }),
		).toHaveAttribute("aria-pressed", "true");
		await expect(
			page.getByRole("button", { name: "マーカーを外す" }),
		).toBeEnabled();
		await page.getByRole("button", { name: "青のマーカー" }).click();
		await expect(mark).toHaveAttribute("data-mdv-color", "blue");
		await mark.click();
		await expect(
			page.getByRole("button", { name: "青のマーカー" }),
		).toHaveAttribute("aria-pressed", "true");
		await page.getByRole("button", { name: "マーカーを外す" }).click();
		await expect(mark).toHaveCount(0);
		await expect(focus).toHaveAttribute("aria-pressed", "true");
		expect(await readFile(file, "utf8")).toBe(source);
	} finally {
		await closeServer(server);
		await rm(root, { recursive: true, force: true });
	}
});
test.beforeAll(async ({ viewer }) => {
	folder = await mkdtemp(join(viewer.directory, "viewer-browser-日本語-"));
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
	await expect(page.getByRole("status")).toContainText("pnpm copy-docs");
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
test("file tree preserves collapsed folders while filtering and supports keyboard expansion", async ({
	page,
}) => {
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
});

test("file tree selection opens tabs and returns to cached documents", async ({
	page,
}) => {
	await openFolder(page);
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

test("reader loads local images without making remote requests or executing raw HTML", async ({
	page,
}) => {
	const remoteRequests = [];
	page.on("request", (request) => {
		if (request.url().startsWith("https://"))
			remoteRequests.push(request.url());
	});
	await openFolder(page);
	await expect(
		page.frameLocator("#content").getByRole("img", { name: "pixel" }),
	).toHaveAttribute("src", /^blob:/);
	await expect(
		page.frameLocator("#content").locator(".image-note"),
	).toContainText("外部画像");
	expect(await page.evaluate(() => window.pwned)).toBeUndefined();
	expect(remoteRequests).toEqual([]);
});

test("reader CSP blocks injected scripts and event handlers", async ({
	page,
}) => {
	await openFolder(page);
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
});

test("relative Markdown links open the target document in an app tab", async ({
	page,
}) => {
	await openFolder(page);
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
test("palette keyboard search opens the matching document and ignores blank queries", async ({
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
});

test("palette limits results while the tree filter keeps all matches", async ({
	page,
	viewer,
}) => {
	const directory = await mkdtemp(join(viewer.directory, "palette-limit-"));
	try {
		await Promise.all(
			Array.from({ length: 25 }, (_, index) =>
				writeFile(
					join(directory, `entry-${String(index).padStart(2, "0")}.md`),
					`# Entry ${index}`,
				),
			),
		);
		await page.goto("/");
		await page.locator("#path").fill(directory);
		await page.locator("#open-form button").click();
		await expect(page.locator(".tree-file")).toHaveCount(25);
		await page.locator("#filter").fill("  ENTRY-  ");
		await expect(page.locator(".tree-file")).toHaveCount(25);
		await page.getByRole("button", { name: /開く・検索/ }).click();
		await page.locator("#command").fill("  ENTRY-  ");
		await expect(page.locator("#results button")).toHaveCount(20);
		await expect(page.locator("#results button").first()).toContainText(
			"entry-00.md",
		);
		await expect(page.locator("#results button").last()).toContainText(
			"entry-19.md",
		);
		await page.locator("#command").press("ArrowDown");
		await page.locator("#command").press("Enter");
		await expect(
			page
				.frameLocator("#content")
				.getByRole("heading", { name: "Entry 1", exact: true }),
		).toBeVisible();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("source view survives tab closing and closed documents remain in the tree", async ({
	page,
}) => {
	await openFolder(page);
	await page.getByRole("treeitem", { name: "B.markdown", exact: true }).click();
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
		page.getByRole("heading", { name: "コピーした文書", exact: true }),
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
test("back and forward restore copied files and open tabs during the session", async ({
	page,
}) => {
	await openFolder(page);
	await page.getByRole("treeitem", { name: "B.markdown" }).click();
	await expect(page.getByRole("tab")).toHaveCount(2);
	const third = join(folder, "C.md");
	await writeFile(third, "# Third document");
	await page.getByRole("button", { name: /開く・検索/ }).click();
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
		await page.getByRole("treeitem", { name: "C.md", exact: true }).click();
		await page.reload();
		await expect(page.locator("#file-list .tree-file")).toHaveCount(3);
		await expect(page.getByRole("tab", { name: "C.md" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
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
test("sidebar width stays within bounds and recovers its preferred width after a narrow viewport", async ({
	page,
}) => {
	await openFolder(page);
	const resizer = page.getByRole("separator", { name: "サイドバーの幅" });
	await resizer.focus();
	await page.keyboard.press("Home");
	await expect(resizer).toHaveAttribute("aria-valuenow", "180");
	await page.keyboard.press("ArrowLeft");
	await expect(resizer).toHaveAttribute("aria-valuenow", "180");
	await page.keyboard.press("End");
	await expect(resizer).toHaveAttribute("aria-valuenow", "600");
	await page.keyboard.press("ArrowRight");
	await expect(resizer).toHaveAttribute("aria-valuenow", "600");
	await page.setViewportSize({ width: 800, height: 820 });
	await expect(resizer).toHaveAttribute("aria-valuenow", "474");
	await expect(resizer).toHaveAttribute("aria-valuemax", "474");
	await page.setViewportSize({ width: 1280, height: 820 });
	await expect(resizer).toHaveAttribute("aria-valuenow", "600");
	await expect(resizer).toHaveAttribute("aria-valuemax", "600");
});

test("sidebar resizing works when browser storage is unavailable", async ({
	page,
}) => {
	await page.addInitScript(() => {
		for (const method of ["getItem", "setItem"])
			Storage.prototype[method] = () => {
				throw new DOMException("Storage blocked", "SecurityError");
			};
	});
	await openFolder(page);
	const resizer = page.getByRole("separator", { name: "サイドバーの幅" });
	await expect(resizer).toHaveAttribute("aria-valuenow", "250");
	await resizer.focus();
	await page.keyboard.press("ArrowRight");
	await expect(resizer).toHaveAttribute("aria-valuenow", "270");
});

test("file pickers are absent and outside paths are rejected in both forms", async ({
	page,
}) => {
	await page.goto("/");
	await expect(page.locator('input[type="file"]')).toHaveCount(0);
	await page.locator("#path").fill("/outside/not-copied.md");
	await page.locator("#open-form button").click();
	await expect(page.getByRole("status")).toContainText(
		"コピーしたファイルだけ",
	);
	await page.getByRole("button", { name: /開く・検索/ }).click();
	await page.locator("#command").fill("/outside/not-copied.md");
	await page.locator("#command").press("Enter");
	await expect(page.getByRole("status")).toContainText(
		"コピーしたファイルだけ",
	);
	await expect(page.getByRole("tab")).toHaveCount(0);
	await page.locator("#palette-close").click();
	await page.evaluate(() =>
		document.dispatchEvent(
			new DragEvent("drop", { bubbles: true, cancelable: true }),
		),
	);
	await expect(page.getByRole("status")).toContainText(
		"ドロップは利用できません",
	);
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
	await expect(page.getByRole("status")).toContainText("pnpm copy-docs");
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
	const dimensions = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		viewportWidth: innerWidth,
	}));
	expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.viewportWidth);
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
