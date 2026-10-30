import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { createViewerServer } from "../../src/server.mjs";
import { closeServer, listenOnLoopback } from "../helpers/http.mjs";
import { openCopiedMarkdown, openCopiedPath, test } from "./helpers.mjs";

async function openTabs(page, viewer) {
	const directory = await mkdtemp(join(viewer.directory, "zed-controls-"));
	for (const name of ["A", "B", "C"])
		await writeFile(
			join(directory, `${name}.md`),
			`# ${name}\n\n${"Paragraph.\n\n".repeat(80)}`,
		);
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

const activeTab = (page) => page.locator('[role="tab"][aria-selected="true"]');
async function command(
	page,
	key,
	{ shift = false, target = "document", composing = false } = {},
) {
	return page.evaluate(
		({ key, shift, target, composing }) => {
			const element =
				target === "reader"
					? document.getElementById("content").contentDocument.body
					: target === "input"
						? document.getElementById("find-query")
						: document;
			return !element.dispatchEvent(
				new KeyboardEvent("keydown", {
					key,
					metaKey: true,
					shiftKey: shift,
					isComposing: composing,
					bubbles: true,
					cancelable: true,
				}),
			);
		},
		{ key, shift, target, composing },
	);
}

test("Cmd+B toggles the sidebar without losing its width; slash reveals it", async ({
	page,
	viewer,
}) => {
	await openTabs(page, viewer);
	const resizer = page.locator("#sidebar-resizer");
	await resizer.focus();
	await page.keyboard.press("ArrowRight");
	const width = await resizer.getAttribute("aria-valuenow");
	await command(page, "b", { target: "reader" });
	await expect(page.locator("#sidebar")).toBeHidden();
	await expect(page.locator("#sidebar-toggle")).toHaveAttribute(
		"aria-expanded",
		"false",
	);
	await command(page, "b", { target: "reader" });
	await expect(page.locator("#sidebar")).toBeVisible();
	await expect(resizer).toHaveAttribute("aria-valuenow", width);
	await page.locator("#sidebar-toggle").click();
	await page.frameLocator("#content").locator("body").press("/");
	await expect(page.locator("#filter")).toBeFocused();
	await page.locator("#focus-toggle").click();
	await command(page, "b", { target: "reader" });
	await expect(page.locator("#sidebar")).toBeVisible();
	await expect(page.locator("#focus-toggle")).toHaveAttribute(
		"aria-pressed",
		"false",
	);
});

test("Cmd+P opens the palette; Cmd+Shift+V toggles Raw and Preview", async ({
	page,
	viewer,
}) => {
	await openTabs(page, viewer);
	expect(await command(page, "p", { target: "reader" })).toBe(true);
	await expect(
		page.getByRole("dialog", { name: "コマンドパレット" }),
	).toBeVisible();
	await page.keyboard.press("Escape");
	await command(page, "v", { shift: true, target: "reader" });
	await expect(page.frameLocator("#content").locator("pre")).toContainText(
		"# C",
	);
	await expect(page.frameLocator("#content").locator("body")).toHaveAttribute(
		"tabindex",
		"-1",
	);
	await command(page, "v", { shift: true, target: "reader" });
	await expect(page.frameLocator("#content").locator("h1")).toHaveText("C");
	await command(page, "f");
	await expect(page.locator("#find-query")).toBeFocused();
	expect(await command(page, "v", { shift: true, target: "input" })).toBe(
		false,
	);
	expect(await command(page, "b", { target: "input" })).toBe(false);
	await expect(
		page.getByRole("button", { name: "Raw", exact: true }),
	).toBeVisible();
});

test("reopening a batch restores order and link scope, with fresh lazy content", async ({
	page,
	viewer,
}) => {
	const directory = await openTabs(page, viewer);
	await page.locator("#close-all").click();
	await writeFile(join(directory, "B.md"), "# Updated B");
	let restores = 0;
	let reads = 0;
	page.on("request", (request) => {
		if (request.url().endsWith("/api/restore")) restores++;
		if (request.url().endsWith("/api/read")) reads++;
	});
	const before = await page.evaluate(() => history.length);
	await command(page, "t", { shift: true });
	await expect(page.getByRole("tab")).toHaveCount(3);
	expect(await page.getByRole("tab").allTextContents()).toEqual([
		"A.md",
		"B.md",
		"C.md",
	]);
	await expect(page.frameLocator("#content").locator("h1")).toHaveText("C");
	await expect(activeTab(page)).toHaveText("C.md");
	await expect(page.locator('.tab[data-batch-selected="true"]')).toHaveCount(1);
	expect(restores).toBe(3);
	expect(reads).toBe(1);
	expect(await page.evaluate(() => history.length)).toBe(before + 1);
	await page.getByRole("tab", { name: "B.md", exact: true }).click();
	await expect(page.frameLocator("#content").locator("h1")).toHaveText(
		"Updated B",
	);
	await expect(page.locator("#reopen-closed")).toBeDisabled();
});

test("reopening skips a copied file replaced by an outside symlink", async ({
	page,
	viewer,
}) => {
	const directory = await openTabs(page, viewer);
	const outside = await mkdtemp(join(tmpdir(), "viewer-reopen-outside-"));
	try {
		await writeFile(join(outside, "secret.md"), "# Must not display");
		await page.locator("#close-all").click();
		await rm(join(directory, "B.md"));
		await symlink(join(outside, "secret.md"), join(directory, "B.md"));
		await page.locator("#reopen-closed").click();
		await expect(page.getByRole("tab")).toHaveCount(2);
		await expect(page.getByRole("status")).toContainText(
			"復元できませんでした",
		);
		await expect(page.frameLocator("#content").locator("h1")).toHaveText("C");
		expect(await page.getByRole("tab").allTextContents()).toEqual([
			"A.md",
			"C.md",
		]);
	} finally {
		await rm(outside, { recursive: true, force: true });
	}
});

test("a late reopen cannot replace a newer navigation and remains available to retry", async ({
	page,
	viewer,
}) => {
	await openTabs(page, viewer);
	await page
		.getByRole("button", { name: "B.md を閉じる", exact: true })
		.click();
	const received = Promise.withResolvers();
	const released = Promise.withResolvers();
	await page.route("**/api/restore", async (route) => {
		const response = await route.fetch();
		received.resolve();
		await released.promise;
		await route.fulfill({ response });
	});
	try {
		await command(page, "t", { shift: true });
		await received.promise;
		await page.getByRole("treeitem", { name: "A.md", exact: true }).click();
		await expect(page.frameLocator("#content").locator("h1")).toHaveText("A");
		released.resolve();
		await expect(page.locator("body")).not.toHaveAttribute("aria-busy", "true");
		expect(await page.getByRole("tab").allTextContents()).toEqual([
			"A.md",
			"C.md",
		]);
		await expect(page.locator("#reopen-closed")).toBeEnabled();
	} finally {
		released.resolve();
		await page.unrouteAll({ behavior: "wait" });
	}
	await page.locator("#reopen-closed").click();
	await expect(page.frameLocator("#content").locator("h1")).toHaveText("B");
	expect(await page.getByRole("tab").allTextContents()).toEqual([
		"A.md",
		"B.md",
		"C.md",
	]);
});

test("dialogs and composition block new shortcuts", async ({
	page,
	viewer,
}) => {
	await openTabs(page, viewer);
	await page.locator("#palette-open").click();
	for (const [key, shift] of [
		["b", false],
		["t", true],
		["v", true],
		["f", false],
		["g", false],
	])
		await command(page, key, { shift });
	await expect(page.locator("#command")).toBeFocused();
	await expect(page.locator("#find-bar")).toBeHidden();
	await expect(activeTab(page)).toHaveText("C.md");
	await page.keyboard.press("Escape");
	expect(await command(page, "b", { composing: true })).toBe(false);
	await expect(page.locator("#sidebar")).toBeVisible();
});

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
	viewer,
}) => {
	await openTabs(page, viewer);
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
