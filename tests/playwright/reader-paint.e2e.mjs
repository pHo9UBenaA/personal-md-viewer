import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { openTabs, test } from "./helpers.mjs";

for (const sourceMode of [false, true]) {
	test(`${sourceMode ? "Raw" : "Preview"} waits for fonts and scroll restoration before painting`, async ({
		page,
		tabDirectory,
	}) => {
		await writeFile(
			join(tabDirectory, "C.md"),
			`# C\n\n${"日本語 Paragraph. `code`\n\n".repeat(80)}`,
		);
		await openTabs(page, tabDirectory);
		if (sourceMode)
			await page.getByRole("button", { name: "Raw", exact: true }).click();
		await expect(page.frameLocator("#content").locator("body")).toHaveAttribute(
			"tabindex",
			"-1",
		);
		await page.locator("#content").evaluate((frame) => {
			frame.contentWindow.scrollTo(0, 640);
		});
		await page.getByRole("tab", { name: "B.md", exact: true }).click();
		await expect(page.frameLocator("#content").locator("body")).toHaveAttribute(
			"tabindex",
			"-1",
		);

		// Routing disables the HTTP cache: exercise the cold/slow font path too.
		const received = Promise.withResolvers();
		const released = Promise.withResolvers();
		await page.route("**/fonts/BIZUDGothic-Regular.woff2*", async (route) => {
			const response = await route.fetch();
			received.resolve();
			await released.promise;
			await route.fulfill({ response });
		});
		try {
			await page.getByRole("tab", { name: "C.md", exact: true }).click();
			await received.promise;
			await expect(page.locator("#content")).toHaveCSS("visibility", "hidden");
			released.resolve();
			await expect(page.locator("#content")).toHaveCSS("visibility", "visible");
			expect(
				await page.locator("#content").evaluate((frame) => ({
					fonts: frame.contentDocument.fonts.status,
					y: frame.contentWindow.scrollY,
				})),
			).toEqual({ fonts: "loaded", y: 640 });
		} finally {
			released.resolve();
			await page.unrouteAll({ behavior: "wait" });
		}
	});
}

test("a failed font request does not leave the reader hidden", async ({
	page,
	tabDirectory,
}) => {
	await openTabs(page, tabDirectory);
	await page.route("**/fonts/BIZUDGothic-Regular.woff2*", (route) =>
		route.abort(),
	);
	await page.getByRole("button", { name: "Raw", exact: true }).click();
	await expect(page.locator("#content")).toHaveCSS("visibility", "visible");
	await expect(page.frameLocator("#content").locator("pre")).toContainText(
		"# C",
	);
	expect(
		await page
			.locator("#content")
			.evaluate((frame) =>
				[...frame.contentDocument.fonts].some(
					(font) => font.family === "BIZ UDGothic" && font.status === "error",
				),
			),
	).toBe(true);
});
