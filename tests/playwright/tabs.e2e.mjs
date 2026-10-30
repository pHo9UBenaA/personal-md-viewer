import { mkdtemp, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { expect } from "@playwright/test";
import { openCopiedPath, test } from "./helpers.mjs";

async function openTabs(page, viewer) {
	const directory = await mkdtemp(join(viewer.directory, "tabs-"));
	for (const name of ["A", "B", "C", "D"])
		await writeFile(join(directory, `${name}.md`), `# Document ${name}`);
	await page.goto("/");
	await openCopiedPath(page, directory);
	await expect(page.getByRole("tab")).toHaveCount(1);
	await expect(page.locator("#file-list > .tree-folder")).toHaveAttribute(
		"aria-expanded",
		"false",
	);
	await page.locator("#filter").fill(".md");
	for (const name of ["B", "C", "D"])
		await page
			.getByRole("treeitem", { name: `${name}.md`, exact: true })
			.click();
	await expect(page.frameLocator("#content").locator("h1")).toHaveText(
		"Document D",
	);
	return directory;
}

const tab = (page, name) =>
	page.getByRole("tab", { name: `${name}.md`, exact: true });
const batch = (page) => page.locator('.tab[data-batch-selected="true"]');
const names = (page) => page.getByRole("tab").allTextContents();

// Synthetic key events test Viewer handlers, not Chrome's native reserved-key routing.
async function closeWithCommand(
	page,
	{ inReader = false, repeat = false } = {},
) {
	// The parent makes the body focusable when the reader's listeners are installed.
	if (inReader)
		await expect(page.frameLocator("#content").locator("body")).toHaveAttribute(
			"tabindex",
			"-1",
		);
	return page.evaluate(
		({ inReader, repeat }) => {
			const target = inReader
				? document.getElementById("content").contentDocument.body
				: document;
			return !target.dispatchEvent(
				new KeyboardEvent("keydown", {
					key: "w",
					code: "KeyW",
					metaKey: true,
					bubbles: true,
					cancelable: true,
					repeat,
				}),
			);
		},
		{ inReader, repeat },
	);
}

test("Shift-click selects a range and Command+W closes it in one history step", async ({
	page,
	viewer,
}) => {
	const directory = await openTabs(page, viewer);
	await tab(page, "A").click();
	await tab(page, "C").click({ modifiers: ["Shift"] });
	await expect(batch(page)).toHaveCount(3);
	await expect(tab(page, "C")).toHaveAttribute("aria-selected", "true");
	const historyLength = await page.evaluate(() => history.length);
	expect(await closeWithCommand(page, { inReader: true })).toBe(true);
	await expect(page.getByRole("tab")).toHaveCount(1);
	await expect(tab(page, "D")).toHaveAttribute("aria-selected", "true");
	expect(await page.evaluate(() => history.length)).toBe(historyLength + 1);
	await page.evaluate(() => history.back());
	await expect(page.getByRole("tab")).toHaveCount(4);
	await expect(tab(page, "C")).toHaveAttribute("aria-selected", "true");
	await expect(batch(page)).toHaveCount(1);
	// Closing a tab never removes its copied file.
	await page.getByRole("treeitem", { name: "A.md", exact: true }).click();
	await expect(page.frameLocator("#content").locator("h1")).toHaveText(
		"Document A",
	);
	await expect(page.locator("#document-path")).toHaveText(
		join(directory, "A.md"),
	);
});

test("normal clicks reset ranges; Delete and Command+W leave an empty Viewer open", async ({
	page,
	viewer,
}) => {
	await openTabs(page, viewer);
	await tab(page, "A").click();
	await tab(page, "C").click({ modifiers: ["Shift"] });
	await tab(page, "B").click();
	await expect(batch(page)).toHaveCount(1);
	await tab(page, "B").press("Shift+End");
	await expect(batch(page)).toHaveCount(3);
	await page.keyboard.press("Delete");
	await expect(page.getByRole("tab")).toHaveCount(1);
	await expect(tab(page, "A")).toBeFocused();
	expect(await closeWithCommand(page, { repeat: true })).toBe(true);
	await expect(page.getByRole("tab")).toHaveCount(1);
	await closeWithCommand(page);
	await expect(page.getByRole("tab")).toHaveCount(0);
	await expect(page.locator("#empty")).toBeVisible();
	expect(await closeWithCommand(page)).toBe(true);
	await expect(page.locator("#filter")).toBeFocused();
});

test("tab menus preserve selected ranges and copy paths for the clicked tab", async ({
	page,
	viewer,
}) => {
	const directory = await openTabs(page, viewer);
	await page.evaluate(() =>
		Object.defineProperty(navigator, "clipboard", {
			value: {
				writeText: async (text) => {
					window.copiedPath = text;
				},
			},
			configurable: true,
		}),
	);
	await tab(page, "A").click();
	await tab(page, "C").click({ modifiers: ["Shift"] });
	await tab(page, "B").click({ button: "right" });
	await expect(batch(page)).toHaveCount(3);
	await expect(tab(page, "C")).toHaveAttribute("aria-selected", "true");
	await page
		.getByRole("menuitem", { name: "絶対パスをコピー", exact: true })
		.click();
	expect(await page.evaluate(() => window.copiedPath)).toBe(
		join(directory, "B.md"),
	);
	await tab(page, "B").press("Shift+F10");
	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("Enter");
	expect(await page.evaluate(() => window.copiedPath)).toBe(
		`${basename(directory)}/B.md`,
	);
	await tab(page, "B").click({ button: "right" });
	await page.keyboard.press("Escape");
	await expect(page.getByRole("menu")).toBeHidden();
	await expect(tab(page, "B")).toBeFocused();
	await tab(page, "B").click({ button: "right" });
	await page
		.getByRole("menuitem", { name: "選択したタブを閉じる (3)", exact: true })
		.click();
	await expect(page.getByRole("tab")).toHaveCount(1);
	await expect(tab(page, "D")).toHaveAttribute("aria-selected", "true");
});

test("right-click outside the selection resets it; menu utilities use that tab", async ({
	page,
	viewer,
}) => {
	const directory = await openTabs(page, viewer);
	await tab(page, "B").click();
	await tab(page, "C").click({ modifiers: ["Shift"] });
	await tab(page, "A").click({ button: "right" });
	await expect(batch(page)).toHaveCount(1);
	await expect(tab(page, "C")).toHaveAttribute("aria-selected", "true");
	await expect(
		page.getByRole("menuitem", { name: "左へ移動", exact: true }),
	).toBeDisabled();
	await page.getByRole("menuitem", { name: "右へ移動", exact: true }).click();
	expect(await names(page)).toEqual(["B.md", "A.md", "C.md", "D.md"]);
	await writeFile(join(directory, "A.md"), "# Updated A");
	await tab(page, "A").click({ button: "right" });
	await page.getByRole("menuitem", { name: "再読み込み", exact: true }).click();
	await expect(page.frameLocator("#content").locator("h1")).toHaveText(
		"Updated A",
	);
	await tab(page, "A").click({ button: "right" });
	await page
		.getByRole("menuitem", { name: "右側のタブを閉じる", exact: true })
		.click();
	expect(await names(page)).toEqual(["B.md", "A.md"]);
	await tab(page, "A").click({ button: "right" });
	await page
		.getByRole("menuitem", { name: "ほかのタブを閉じる", exact: true })
		.click();
	expect(await names(page)).toEqual(["A.md"]);
	await tab(page, "A").click({ button: "right" });
	await page
		.getByRole("menuitem", { name: "すべて閉じる", exact: true })
		.click();
	await expect(page.getByRole("tab")).toHaveCount(0);
});

test("clipboard failures are reported and clicking the reader dismisses tab menus", async ({
	page,
	viewer,
}) => {
	await openTabs(page, viewer);
	await page.evaluate(() =>
		Object.defineProperty(navigator, "clipboard", {
			value: {
				writeText: async () => {
					throw new Error("Permission denied");
				},
			},
			configurable: true,
		}),
	);
	await tab(page, "B").click({ button: "right" });
	await page
		.getByRole("menuitem", { name: "絶対パスをコピー", exact: true })
		.click();
	await expect(page.getByRole("status")).toContainText(
		"パスをコピーできませんでした",
	);
	await tab(page, "B").click({ button: "right" });
	await page.frameLocator("#content").locator("h1").click();
	await expect(page.getByRole("menu")).toBeHidden();
});

test("dragging tabs reorders without reloading the reader and survives history and reload", async ({
	page,
	viewer,
}) => {
	await openTabs(page, viewer);
	await page.evaluate(() => {
		window.savedReader = document.getElementById("content");
	});
	await tab(page, "C")
		.locator("..")
		.dragTo(tab(page, "A").locator(".."), { targetPosition: { x: 2, y: 12 } });
	await expect
		.poll(() => names(page))
		.toEqual(["C.md", "A.md", "B.md", "D.md"]);
	expect(
		await page.evaluate(
			() => window.savedReader === document.getElementById("content"),
		),
	).toBe(true);
	await expect(tab(page, "D")).toHaveAttribute("aria-selected", "true");
	await page.evaluate(() => history.back());
	await expect
		.poll(() => names(page))
		.toEqual(["A.md", "B.md", "C.md", "D.md"]);
	await page.evaluate(() => history.forward());
	await expect
		.poll(() => names(page))
		.toEqual(["C.md", "A.md", "B.md", "D.md"]);
	await page.reload();
	await expect
		.poll(() => names(page))
		.toEqual(["C.md", "A.md", "B.md", "D.md"]);
	await expect(tab(page, "D")).toHaveAttribute("aria-selected", "true");
});

test("a forged tab drop cannot import files or reorder existing tabs", async ({
	page,
	viewer,
}) => {
	await openTabs(page, viewer);
	await page.locator("#tabs").evaluate((element) => {
		const transfer = new DataTransfer();
		transfer.setData(
			"application/x-mdv-tab",
			document.querySelector(".tab").dataset.key,
		);
		element.dispatchEvent(
			new DragEvent("drop", {
				bubbles: true,
				cancelable: true,
				dataTransfer: transfer,
			}),
		);
	});
	await expect(page.getByRole("status")).toContainText(
		"ドロップは利用できません",
	);
	expect(await names(page)).toEqual(["A.md", "B.md", "C.md", "D.md"]);
});

test("reader shortcuts reload only the active tab and focus search outside editing", async ({
	page,
	viewer,
}) => {
	const directory = await openTabs(page, viewer);
	await writeFile(join(directory, "D.md"), "# Reloaded D");
	const navigation = await page.evaluate(() => performance.timeOrigin);
	await page.frameLocator("#content").locator("body").press("Meta+r");
	await expect(page.frameLocator("#content").locator("h1")).toHaveText(
		"Reloaded D",
	);
	expect(await page.evaluate(() => performance.timeOrigin)).toBe(navigation);
	await expect(page.getByRole("tab")).toHaveCount(4);
	await page.frameLocator("#content").locator("body").press("Meta+Shift+F");
	await expect(page.locator("#sidebar")).toBeHidden();
	await page.frameLocator("#content").locator("body").press("/");
	await expect(page.locator("#filter")).toBeFocused();
	await expect(page.locator("#sidebar")).toBeVisible();
	await page.locator("#filter").fill("A");
	await page.keyboard.press("/");
	await expect(page.locator("#filter")).toHaveValue("A/");
	await page.getByRole("button", { name: /コマンドパレット/ }).click();
	await page.locator("#command").press("/");
	await expect(page.locator("#command")).toHaveValue("/");
	await closeWithCommand(page);
	await expect(page.getByRole("tab")).toHaveCount(4);
	await page.locator("#palette-close").click();
	const consumed = await page
		.frameLocator("#content")
		.locator("body")
		.evaluate(
			(element) =>
				!element.dispatchEvent(
					new KeyboardEvent("keydown", {
						key: "/",
						isComposing: true,
						bubbles: true,
						cancelable: true,
					}),
				),
		);
	expect(consumed).toBe(false);
	await page.getByRole("button", { name: "Raw", exact: true }).click();
	await page.frameLocator("#content").locator("pre").press("/");
	await expect(page.locator("#filter")).toBeFocused();
});

test("shortcut details open a separate browser tab with no shortcut interception", async ({
	page,
}) => {
	await page.goto("/");
	await expect(page.locator("#empty input")).toHaveCount(0);
	const popupPromise = page.waitForEvent("popup");
	await page.getByRole("link", { name: "ショートカットの詳細" }).click();
	const popup = await popupPromise;
	await expect(popup).toHaveURL(/\/shortcuts$/);
	await expect(
		popup.getByRole("heading", { name: "Viewer のショートカット" }),
	).toBeVisible();
	expect(await popup.evaluate(() => window.opener)).toBeNull();
	expect(
		await popup.evaluate(
			() =>
				!document.dispatchEvent(
					new KeyboardEvent("keydown", {
						key: "w",
						metaKey: true,
						cancelable: true,
						bubbles: true,
					}),
				),
		),
	).toBe(false);
	await popup.close();
});
