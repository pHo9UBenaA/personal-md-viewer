import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { createViewerServer } from "../../src/server.mjs";
import { closeServer, listenOnLoopback } from "../helpers/http.mjs";
import { openCopiedMarkdown, openTabs, test } from "./helpers.mjs";
import { command } from "./keyboard.mjs";

test("reader search is literal, case-insensitive and never changes marker text nodes", async ({
	page,
	viewer,
}) => {
	const path = await openCopiedMarkdown(page, viewer.directory, {
		name: "find.md",
		source:
			'# Search\n\nneedle first\n\n**NEEDLE** second\n\n`[a+b]`\n\n<mark data-mdv-color="yellow">needle saved</mark>\n\n**bold** and plain\n\nprefix\n\nsuffix\n\nhard  \nbreak',
	});
	await expect(page.frameLocator("#content").locator("body")).toHaveAttribute(
		"tabindex",
		"-1",
	);
	await page.locator("#content").evaluate((frame) => {
		window.findBody = frame.contentDocument.body.innerHTML;
	});
	await command(page, "f", { target: "reader" });
	await page.locator("#find-query").fill("needle");
	await expect(page.locator("#find-count")).toHaveText("1 / 3");
	await command(page, "g", { target: "input" });
	await expect(page.locator("#find-count")).toHaveText("2 / 3");
	await command(page, "g", { shift: true, target: "input" });
	await expect(page.locator("#find-count")).toHaveText("1 / 3");
	await page.locator("#find-query").press("Shift+Enter");
	await expect(page.locator("#find-count")).toHaveText("3 / 3");
	expect(
		await page
			.locator("#content")
			.evaluate(
				(frame) => frame.contentWindow.CSS.highlights.get("mdv-find").size,
			),
	).toBe(1);
	expect(
		await page
			.locator("#content")
			.evaluate(
				(frame) => window.findBody === frame.contentDocument.body.innerHTML,
			),
	).toBe(true);
	await page.locator("#find-query").fill("[a+b]");
	await expect(page.locator("#find-count")).toHaveText("1 / 1");
	await page.locator("#find-query").fill("bold and plain");
	await expect(page.locator("#find-count")).toHaveText("1 / 1");
	await page.locator("#find-query").fill("prefixsuffix");
	await expect(page.locator("#find-count")).toHaveText("0 / 0");
	await page.locator("#find-query").fill("hardbreak");
	await expect(page.locator("#find-count")).toHaveText("0 / 0");
	await page.locator("#find-query").fill("absent");
	await expect(page.locator("#find-count")).toHaveText("0 / 0");
	await expect(page.locator("#find-next")).toBeDisabled();
	await page.locator("#find-query").fill("needle");
	await page.frameLocator("#content").locator("mark").click();
	await page
		.getByRole("button", { name: "ピンクのマーカー", exact: true })
		.click();
	await expect(page.frameLocator("#content").locator("mark")).toHaveAttribute(
		"data-mdv-color",
		"pink",
	);
	expect(await readFile(path, "utf8")).toContain(
		'<mark data-mdv-color="pink">needle saved</mark>',
	);
	await expect(page.locator("#find-count")).toHaveText("1 / 3");
	await page.locator("#find-query").focus();
	await page.keyboard.press("Escape");
	await expect(page.locator("#find-bar")).toBeHidden();
	expect(
		await page
			.locator("#content")
			.evaluate((frame) => frame.contentWindow.CSS.highlights.has("mdv-find")),
	).toBe(false);
});

test("trusted HTML search skips hidden text and refreshes when details open", async ({
	page,
	viewer,
}) => {
	const path = join(viewer.directory, "trusted-find.md");
	await writeFile(
		path,
		"<p>needle visible</p><span hidden>needle invisible</span><details><summary>Details</summary><p>needle folded</p></details><script>parent.findScriptRan = true</script>",
	);
	const server = await createViewerServer({
		contentDirectory: viewer.directory,
		initialPaths: [path],
		allowHtml: true,
	});
	const url = await listenOnLoopback(server);
	try {
		await page.goto(url);
		await expect(page.frameLocator("#content").locator("body")).toHaveAttribute(
			"tabindex",
			"-1",
		);
		await command(page, "f");
		await page.locator("#find-query").fill("needle");
		await expect(page.locator("#find-count")).toHaveText("1 / 1");
		await page.frameLocator("#content").locator("summary").click();
		await expect(page.locator("#find-count")).toHaveText("1 / 2");
		expect(await page.evaluate(() => window.findScriptRan)).toBeUndefined();
	} finally {
		await closeServer(server);
	}
});

test("search follows tabs and Raw view without discarding its query", async ({
	page,
	tabDirectory,
}) => {
	await openTabs(page, tabDirectory);
	await command(page, "f");
	await page.locator("#find-query").fill("Paragraph");
	await expect(page.locator("#find-count")).toHaveText("1 / 80");
	await page.getByRole("tab", { name: "A.md", exact: true }).click();
	await expect(page.frameLocator("#content").locator("h1")).toHaveText("A");
	await expect(page.locator("#find-count")).toHaveText("1 / 80");
	await command(page, "v", { shift: true, target: "reader" });
	await expect(page.frameLocator("#content").locator("pre")).toContainText(
		"# A",
	);
	await expect(page.locator("#find-count")).toHaveText("1 / 80");
	await page.locator("#close-all").click();
	await expect(page.locator("#find-bar")).toBeHidden();
});
