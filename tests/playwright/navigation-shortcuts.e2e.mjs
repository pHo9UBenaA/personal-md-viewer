import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { createViewerServer } from "../../src/server.mjs";
import { closeServer, listenOnLoopback } from "../helpers/http.mjs";
import { activeTab, openCopiedPath, openTabs, test } from "./helpers.mjs";
import { command } from "./keyboard.mjs";

async function openLongTabs(page, viewer) {
	const directory = await mkdtemp(join(viewer.directory, "navigation-"));
	for (const name of ["A", "B", "C"])
		await writeFile(
			join(directory, `${name}.md`),
			`# ${name}\n\n${"Reading paragraph.\n\n".repeat(200)}`,
		);
	await page.goto("/");
	await openCopiedPath(page, directory);
	await expect(page.locator("#palette")).toBeHidden();
	await page.locator("#filter").fill(".md");
	for (const name of ["B", "C", "A"])
		await page
			.getByRole("treeitem", { name: `${name}.md`, exact: true })
			.click();
	await expect(page.frameLocator("#content").locator("h1")).toHaveText("A");
}

async function scrollTo(page, y) {
	await expect(page.frameLocator("#content").locator("body")).toHaveAttribute(
		"tabindex",
		"-1",
	);
	await page
		.locator("#content")
		.evaluate((frame, y) => frame.contentWindow.scrollTo(0, y), y);
}
const scrollY = (page) =>
	page.locator("#content").evaluate((frame) => frame.contentWindow.scrollY);
async function expectReaderFocus(page) {
	await expect
		.poll(() =>
			page
				.locator("#content")
				.evaluate(
					(frame) =>
						document.activeElement === frame &&
						frame.contentDocument.activeElement === frame.contentDocument.body,
				),
		)
		.toBe(true);
}

test("Ctrl+Tab follows tab order, wraps, clears batch selection and restores scroll", async ({
	page,
	viewer,
}) => {
	await openLongTabs(page, viewer);
	await scrollTo(page, 320);
	await page.frameLocator("#content").locator("body").press("Control+Tab");
	await expect(page.frameLocator("#content").locator("h1")).toHaveText("B");
	await expectReaderFocus(page);
	await scrollTo(page, 640);
	await page.keyboard.press("Control+Shift+Tab");
	await expect(page.frameLocator("#content").locator("h1")).toHaveText("A");
	await expect.poll(() => scrollY(page)).toBe(320);
	await page.keyboard.press("Control+Shift+Tab");
	await expect(page.frameLocator("#content").locator("h1")).toHaveText("C");
	await page.keyboard.press("Control+Tab");
	await expect(page.frameLocator("#content").locator("h1")).toHaveText("A");
	await page
		.getByRole("tab", { name: "C.md", exact: true })
		.click({ modifiers: ["Shift"] });
	await expect(page.locator('.tab[data-batch-selected="true"]')).toHaveCount(3);
	await page.keyboard.press("Control+Tab");
	await expect(
		page.getByRole("tab", { name: "A.md", exact: true }),
	).toHaveAttribute("aria-selected", "true");
	await expect(page.locator('.tab[data-batch-selected="true"]')).toHaveCount(1);
});

test("Raw and Preview keep separate per-tab scroll positions", async ({
	page,
	viewer,
}) => {
	await openLongTabs(page, viewer);
	await scrollTo(page, 500);
	await page.getByRole("button", { name: "Raw", exact: true }).click();
	await expect(page.frameLocator("#content").locator("pre")).toBeVisible();
	await scrollTo(page, 800);
	await page.frameLocator("#content").locator("body").press("Control+Tab");
	await expect(page.frameLocator("#content").locator("pre")).toContainText(
		"# B",
	);
	await page.keyboard.press("Control+Shift+Tab");
	await expect(page.frameLocator("#content").locator("pre")).toContainText(
		"# A",
	);
	await expect.poll(() => scrollY(page)).toBe(800);
	await page.getByRole("button", { name: "Preview", exact: true }).click();
	await expect(page.frameLocator("#content").locator("h1")).toHaveText("A");
	await expect.poll(() => scrollY(page)).toBe(500);
});

test("Ctrl+@ toggles tree search and actual reader focus without resetting scroll", async ({
	page,
	viewer,
}) => {
	await openLongTabs(page, viewer);
	await scrollTo(page, 400);
	await page.frameLocator("#content").locator("body").press("Control+Shift+2");
	await expect(page.locator("#filter")).toBeFocused();
	await page.keyboard.press("Control+Shift+2");
	await expectReaderFocus(page);
	await expect.poll(() => scrollY(page)).toBe(400);
	await page.keyboard.press("PageDown");
	await expect.poll(() => scrollY(page)).toBeGreaterThan(400);
	await page.frameLocator("#content").locator("body").press("Meta+Shift+F");
	await expect(page.locator("#sidebar")).toBeHidden();
	await page
		.frameLocator("#content")
		.locator("body")
		.evaluate((element) =>
			element.dispatchEvent(
				new KeyboardEvent("keydown", {
					key: "@",
					code: "BracketLeft",
					ctrlKey: true,
					bubbles: true,
					cancelable: true,
				}),
			),
		);
	await expect(page.locator("#filter")).toBeFocused();
	await expect(page.locator("#sidebar")).toBeVisible();
	const bracketConsumed = await page.locator("#filter").evaluate(
		(element) =>
			!element.dispatchEvent(
				new KeyboardEvent("keydown", {
					key: "[",
					code: "BracketLeft",
					ctrlKey: true,
					bubbles: true,
					cancelable: true,
				}),
			),
	);
	expect(bracketConsumed).toBe(false);
});

test("navigation shortcuts do not escape dialogs or interrupt composition", async ({
	page,
	viewer,
}) => {
	await openLongTabs(page, viewer);
	await page.locator("#palette-open").click();
	await page.locator("#command").press("Control+Tab");
	await page.locator("#command").press("Control+Shift+2");
	await expect(page.locator("#command")).toBeFocused();
	await expect(
		page.getByRole("tab", { name: "A.md", exact: true }),
	).toHaveAttribute("aria-selected", "true");
	await page.keyboard.press("Escape");
	const consumed = await page
		.frameLocator("#content")
		.locator("body")
		.evaluate(
			(element) =>
				!element.dispatchEvent(
					new KeyboardEvent("keydown", {
						key: "Tab",
						ctrlKey: true,
						isComposing: true,
						bubbles: true,
						cancelable: true,
					}),
				),
		);
	expect(consumed).toBe(false);
	await page.locator("#close-all").click();
	await page.locator("#filter").press("Control+Shift+2");
	await expect(page.locator("#filter")).toBeFocused();
	await page.keyboard.press("Control+Tab");
	await expect(page.getByRole("tab")).toHaveCount(0);
});

test("trusted HTML editing keeps slash input and supports focus toggling", async ({
	page,
	viewer,
}) => {
	const path = join(viewer.directory, "editing-shortcuts.md");
	await writeFile(path, '<input aria-label="Editable"><p>Content</p>');
	const server = await createViewerServer({
		contentDirectory: viewer.directory,
		initialPaths: [path],
		allowHtml: true,
	});
	const url = await listenOnLoopback(server);
	try {
		await page.goto(url);
		await openCopiedPath(page, path);
		const input = page
			.frameLocator("#content")
			.getByRole("textbox", { name: "Editable", exact: true });
		await expect(page.frameLocator("#content").locator("body")).toHaveAttribute(
			"tabindex",
			"-1",
		);
		await input.fill("text");
		await input.press("/");
		await expect(input).toHaveValue("text/");
		await input.press("Control+Shift+2");
		await expect(page.locator("#filter")).toBeFocused();
		await page.keyboard.press("Control+Shift+2");
		await expectReaderFocus(page);
	} finally {
		await closeServer(server);
	}
});

test("Cmd+B toggles the sidebar without losing its width; slash reveals it", async ({
	page,
	tabDirectory,
}) => {
	await openTabs(page, tabDirectory);
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
	tabDirectory,
}) => {
	await openTabs(page, tabDirectory);
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

test("dialogs and composition block new shortcuts", async ({
	page,
	tabDirectory,
}) => {
	await openTabs(page, tabDirectory);
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
