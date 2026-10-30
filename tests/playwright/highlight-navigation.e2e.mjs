import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createViewerServer } from "../../src/server.mjs";
import { closeServer, listenOnLoopback } from "../helpers/http.mjs";

test("a late highlight save preserves the newly selected tab and its scroll position", async ({
	page,
}) => {
	const root = await mkdtemp(join(tmpdir(), "viewer-highlight-navigation-"));
	const highlightedFile = join(root, "A.md");
	await writeFile(highlightedFile, "# First\n\n**important words**");
	await writeFile(
		join(root, "B.md"),
		`# Second\n\n${"Reading paragraph.\n\n".repeat(100)}`,
	);
	const server = await createViewerServer({
		contentDirectory: root,
		initialPaths: [root],
	});
	const url = await listenOnLoopback(server);
	const saveReceived = Promise.withResolvers();
	const saveReleased = Promise.withResolvers();
	await page.route("**/api/highlight", async (route) => {
		const response = await route.fetch();
		saveReceived.resolve();
		await saveReleased.promise;
		await route.fulfill({ response });
	});
	try {
		await page.goto(url);
		await page.locator("#filter").fill(".md");
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
		await page.getByRole("button", { name: "黄色のマーカー" }).click();
		await saveReceived.promise;

		await page.getByRole("treeitem", { name: "B.md", exact: true }).click();
		await expect(
			page.frameLocator("#content").getByRole("heading", { name: "Second" }),
		).toBeVisible();
		await page
			.locator("#content")
			.evaluate((frame) => frame.contentWindow.scrollTo(0, 600));
		await expect
			.poll(() =>
				page
					.locator("#content")
					.evaluate((frame) => frame.contentWindow.scrollY),
			)
			.toBe(600);

		saveReleased.resolve();
		await expect(page.locator("body")).not.toHaveAttribute("aria-busy", "true");
		await expect(
			page.getByRole("tab", { name: "B.md", exact: true }),
		).toHaveAttribute("aria-selected", "true");
		await expect
			.poll(() =>
				page
					.locator("#content")
					.evaluate((frame) => frame.contentWindow.scrollY),
			)
			.toBe(600);
		expect(await readFile(highlightedFile, "utf8")).toContain(
			'<mark data-mdv-color="yellow">important words</mark>',
		);
	} finally {
		saveReleased.resolve();
		await page.unrouteAll({ behavior: "wait" });
		await closeServer(server);
		await rm(root, { recursive: true, force: true });
	}
});
