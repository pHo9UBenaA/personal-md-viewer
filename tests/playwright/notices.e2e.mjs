import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { createViewerServer } from "../../src/server.mjs";
import { closeServer, listenOnLoopback } from "../helpers/http.mjs";
import { openCopiedMarkdown, openCopiedPath, test } from "./helpers.mjs";

for (const width of [320, 1280]) {
	test(`dismissed notices leave no DOM or space at ${width}px and stay dismissed during reading`, async ({
		page,
		viewer,
	}) => {
		await page.setViewportSize({ width, height: 900 });
		await openCopiedMarkdown(page, viewer.directory, {
			name: `notices-${width}.md`,
			source: "# Notices\n\nText.",
		});
		await expect(page.locator("#status")).toContainText("コピーを閲覧中");
		const before = await page.locator(".workspace").boundingBox();
		await page
			.getByRole("button", { name: "ショートカットの案内を閉じる" })
			.click();
		await expect(page.locator("#shortcut-notice")).toHaveCount(0);
		await expect(page.locator("#status")).toContainText("コピーを閲覧中");
		await page
			.getByRole("button", { name: "通知を閉じる", exact: true })
			.click();
		await expect(page.locator("#status")).toHaveCount(0);
		await expect(page.frameLocator("#content").locator("body")).toBeFocused();
		expect((await page.locator("#notices").boundingBox()).height).toBe(0);
		expect(
			(await page.locator(".workspace").boundingBox()).height,
		).toBeGreaterThan(before.height);
		const otherPath = join(viewer.directory, `notice-other-${width}.md`);
		await writeFile(otherPath, "# Other notice document");
		await openCopiedPath(page, otherPath);
		await expect(page.locator("#status")).toHaveCount(0);
		await page
			.getByRole("tab", { name: `notices-${width}.md`, exact: true })
			.click();
		await expect(page.locator("#status")).toHaveCount(0);
		await page.locator("#reload").click();
		await expect(page.locator("#status")).toHaveCount(0);
		await page.getByRole("button", { name: "Raw", exact: true }).click();
		await expect(page.frameLocator("#content").locator("pre")).toContainText(
			"# Notices",
		);
		await expect(page.locator("#status")).toHaveCount(0);
		await page.getByRole("button", { name: "Preview", exact: true }).click();
		await expect(page.locator("#status")).toHaveCount(0);
		await page.reload();
		await expect(page.locator("#shortcut-notice")).toBeVisible();
		await expect(page.locator("#status")).toContainText("コピーを閲覧中");
	});
}

test("errors reappear after dismissing notices, and can also be removed", async ({
	page,
	viewer,
}) => {
	const path = await openCopiedMarkdown(page, viewer.directory, {
		name: "notice-errors.md",
		source: "# Original",
	});
	await expect(page.locator("#status")).toContainText("コピーを閲覧中");
	await page.getByRole("button", { name: "通知を閉じる", exact: true }).click();
	await page
		.getByRole("button", { name: "ショートカットの案内を閉じる" })
		.click();
	for (let attempt = 0; attempt < 2; attempt++) {
		if (attempt === 0) await unlink(path);
		await page.locator("#reload").click();
		await expect(page.locator("#status")).toHaveAttribute("data-error", "true");
		await expect(page.getByRole("status")).toContainText("見つかりません");
		await page
			.getByRole("button", { name: "通知を閉じる", exact: true })
			.click();
		await expect(page.locator("#status")).toHaveCount(0);
	}
	await writeFile(path, "# Updated");
	await page.locator("#reload").click();
	await expect(
		page.frameLocator("#content").getByRole("heading", { name: "Updated" }),
	).toBeVisible();
	await expect(page.locator("#status")).toHaveCount(0);
});

for (const allowHtml of [false, true]) {
	test(`no-notices omits both notices but keeps errors, results and shortcut help (allowHtml=${allowHtml})`, async ({
		page,
		viewer,
	}) => {
		const path = join(viewer.directory, `no-notices-${allowHtml}.md`);
		await writeFile(path, "# Quiet reader\n\nContent.");
		const server = await createViewerServer({
			contentDirectory: viewer.directory,
			initialPaths: [path],
			hideNotices: true,
			allowHtml,
		});
		try {
			await page.goto(await listenOnLoopback(server));
			await expect(
				page
					.frameLocator("#content")
					.getByRole("heading", { name: "Quiet reader" }),
			).toBeVisible();
			await expect(page.locator("#shortcut-notice, #status")).toHaveCount(0);
			expect((await page.locator("#notices").boundingBox()).height).toBe(0);
			await page.locator("#palette-open").click();
			const popupPromise = page.waitForEvent("popup");
			await page.getByRole("link", { name: "ショートカットの詳細" }).click();
			const popup = await popupPromise;
			await expect(popup).toHaveURL(/\/shortcuts$/);
			expect(await popup.evaluate(() => window.opener)).toBeNull();
			await popup.close();
			await page.keyboard.press("Escape");
			await page.locator(".close-tab").click();
			await expect(page.getByRole("status")).toContainText("タブを閉じました");
			await page.locator("#reopen-closed").click();
			await expect(
				page
					.frameLocator("#content")
					.getByRole("heading", { name: "Quiet reader" }),
			).toBeVisible();
			await expect(page.locator("#status")).toHaveCount(0);
			await expect(page.locator("#shortcut-notice")).toHaveCount(0);
			await unlink(path);
			await page.locator("#reload").click();
			await expect(page.locator("#status")).toHaveAttribute(
				"data-error",
				"true",
			);
			await page
				.getByRole("button", { name: "通知を閉じる", exact: true })
				.click();
			await expect(page.locator("#status")).toHaveCount(0);
		} finally {
			await closeServer(server);
		}
	});
}
