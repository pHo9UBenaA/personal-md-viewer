import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { createViewerServer } from "../../src/server.mjs";
import { closeServer, listenOnLoopback } from "../helpers/http.mjs";
import { test } from "./helpers.mjs";

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
		await expect(page.frameLocator("#content").locator("body")).toHaveAttribute(
			"tabindex",
			"-1",
		);
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

		await expect(page.frameLocator("#content").locator("body")).toHaveAttribute(
			"tabindex",
			"-1",
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
		await expect(page.frameLocator("#content").locator("body")).toHaveAttribute(
			"tabindex",
			"-1",
		);
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
