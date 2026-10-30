import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { createViewerServer } from "../../src/server.mjs";
import { closeServer, listenOnLoopback } from "../helpers/http.mjs";
import {
	openCopiedMarkdown,
	openCopiedPath,
	openFolder,
	test,
} from "./helpers.mjs";

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
		await openCopiedPath(page, join(root, "details.md"));
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

test("reader loads local images without making remote requests or executing raw HTML", async ({
	folder,
	page,
}) => {
	const remoteRequests = [];
	page.on("request", (request) => {
		if (request.url().startsWith("https://"))
			remoteRequests.push(request.url());
	});
	await openFolder(page, folder);
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
	folder,
	page,
}) => {
	await openFolder(page, folder);
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
	folder,
	page,
}) => {
	await openFolder(page, folder);
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

test("source view survives tab closing and closed documents remain in the tree", async ({
	folder,
	page,
}) => {
	await openFolder(page, folder);
	await page.getByRole("treeitem", { name: "B.markdown", exact: true }).click();
	await expect(
		page
			.frameLocator("#content")
			.getByRole("heading", { name: "Second document" }),
	).toBeVisible();
	await page.getByRole("button", { name: "Raw", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Preview", exact: true }),
	).toBeVisible();
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
	await expect(page.locator("#empty")).toContainText(
		"マーカーはコピーに保存し、元ファイルは変更しません。",
	);
	await expect(page.locator("#empty")).toContainText(
		"コピー後は「コマンドパレット」で content/ を開き直すか、",
	);
	await expect(page.locator("#empty")).toContainText(
		"サーバーを再起動し、⌘⇧R / Ctrl+Shift+R でこのページ全体を再読み込みしてください。",
	);
});

test("focus mode fills the viewport and can be toggled from the reader", async ({
	folder,
	page,
}) => {
	await openFolder(page, folder);
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
