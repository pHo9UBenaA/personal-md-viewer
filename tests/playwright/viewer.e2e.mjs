import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

let folder;
test("imports over 200 documents lazily and accepts a drop onto the reader", async ({
	page,
}) => {
	await page.goto("/");
	await expect(page.getByRole("status")).toContainText("パス入力");
	let renders = 0;
	page.on("request", (request) => {
		if (request.url().endsWith("/api/render")) renders++;
	});
	await page.locator("#files").setInputFiles(
		Array.from({ length: 201 }, (_, index) => ({
			name: `${String(index).padStart(3, "0")}.md`,
			mimeType: "text/markdown",
			buffer: Buffer.from(`# Document ${index}`),
		})),
	);
	await expect(page.getByRole("tab")).toHaveCount(201);
	await expect(
		page
			.frameLocator("#content")
			.getByRole("heading", { name: "Document 0", exact: true }),
	).toBeVisible();
	expect(renders).toBe(1);
	await page.getByRole("tab", { name: "200.md", exact: true }).click();
	await expect(
		page
			.frameLocator("#content")
			.getByRole("heading", { name: "Document 200", exact: true }),
	).toBeVisible();
	expect(renders).toBe(2);
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
	await expect(page.getByRole("tab")).toHaveCount(202);
	await expect(
		page
			.frameLocator("#content")
			.getByRole("heading", { name: "Dropped document" }),
	).toBeVisible();
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
	await page.getByRole("tab", { name: "B.markdown", exact: true }).click();
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
test.beforeAll(async () => {
	folder = await mkdtemp(join(tmpdir(), "viewer-browser-日本語-"));
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
	await expect(page.getByRole("status")).toContainText("パス入力");
	await page
		.getByLabel("ファイル・フォルダーのパス", { exact: true })
		.fill(folder);
	await page.locator("#recursive").check();
	await page
		.locator("#open-form")
		.getByRole("button", { name: "開く", exact: true })
		.click();
	await expect(page.getByRole("tab")).toHaveCount(2);
	await expect(
		page
			.frameLocator("#content")
			.getByRole("heading", { name: "First document", exact: true }),
	).toBeVisible();
}
test("folder tabs, relative links, local images, no remote requests or HTML execution", async ({
	page,
}) => {
	const remote = [];
	page.on("request", (request) => {
		if (request.url().startsWith("https://")) remote.push(request.url());
	});
	await openFolder(page);
	await expect(page.frameLocator("#content").locator("img")).toHaveAttribute(
		"src",
		/^blob:/,
	);
	await expect(
		page.frameLocator("#content").locator(".image-note"),
	).toContainText("外部画像");
	expect(await page.evaluate(() => window.pwned)).toBeUndefined();
	expect(remote).toEqual([]);
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
test("palette keyboard search, source view, close active tab and close all", async ({
	page,
}) => {
	await openFolder(page);
	await page.keyboard.press("Control+k");
	await expect(page.getByRole("dialog")).toBeVisible();
	await page.locator("#command").fill("B.markdown");
	await page.locator("#command").press("Enter");
	await expect(page.getByRole("dialog")).not.toBeVisible();
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
	await expect(page.frameLocator("#content").locator("pre")).toContainText(
		"# First document",
	);
	await page.getByRole("button", { name: "すべて閉じる" }).click();
	await expect(
		page.getByRole("heading", { name: "パスから、すぐ読む。" }),
	).toBeVisible();
});
test("native folder input reads file content without pretending it has absolute paths", async ({
	page,
}) => {
	await page.goto("/");
	await expect(page.getByRole("status")).toContainText("パス入力");
	await page.locator("#folder").setInputFiles(folder);
	await expect(page.getByRole("tab")).toHaveCount(2);
	await expect(
		page
			.frameLocator("#content")
			.getByRole("heading", { name: "First document", exact: true }),
	).toBeVisible();
	await expect(page.frameLocator("#content").locator("img")).toHaveAttribute(
		"src",
		/^blob:/,
	);
	await expect(page.getByRole("button", { name: "再読み込み" })).toBeDisabled();
	await page
		.frameLocator("#content")
		.getByRole("link", { name: "Next" })
		.click();
	await expect(
		page
			.frameLocator("#content")
			.getByRole("heading", { name: "Second document" }),
	).toBeVisible();
});
test("missing paths are recoverable and mobile opening remains usable", async ({
	page,
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto("/");
	await expect(page.getByRole("status")).toContainText("パス入力");
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
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= innerWidth,
		),
	).toBe(true);
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
		await page.getByRole("tab", { name: "B.markdown", exact: true }).click();
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
