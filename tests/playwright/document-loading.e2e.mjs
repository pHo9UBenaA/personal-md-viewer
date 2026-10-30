import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { openCopiedPath, openFolder, test } from "./helpers.mjs";

test("copied folders load documents lazily and reject a drop onto the reader", async ({
	page,
	viewer,
}) => {
	const many = await mkdtemp(join(viewer.directory, "many-"));
	await Promise.all(
		Array.from({ length: 201 }, (_, index) =>
			writeFile(
				join(many, `${String(index).padStart(3, "0")}.md`),
				`# Document ${index}`,
			),
		),
	);
	await page.goto("/");
	let reads = 0;
	page.on("request", (request) => {
		if (request.url().endsWith("/api/read")) reads++;
	});
	await openCopiedPath(page, many);
	await expect(page.getByRole("tab")).toHaveCount(1);
	await expect(page.locator(".tree-file")).toHaveCount(201);
	await page.locator("#file-list > .tree-folder > .tree-folder-row").click();
	await expect(
		page
			.frameLocator("#content")
			.getByRole("heading", { name: "Document 0", exact: true }),
	).toBeVisible();
	expect(reads).toBe(1);
	await page.getByRole("treeitem", { name: "200.md", exact: true }).click();
	await expect(page.getByRole("tab")).toHaveCount(2);
	await expect(
		page
			.frameLocator("#content")
			.getByRole("heading", { name: "Document 200", exact: true }),
	).toBeVisible();
	expect(reads).toBe(2);
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
	await expect(page.getByRole("status")).toContainText(
		"ドロップは利用できません",
	);
	await expect(page.getByRole("tab")).toHaveCount(2);
	await expect(page.locator(".tree-file")).toHaveCount(201);
	await expect(
		page
			.frameLocator("#content")
			.getByRole("heading", { name: "Dropped document" }),
	).toHaveCount(0);
});

test("late read responses cannot replace the current document; reload reads disk changes", async ({
	folder,
	page,
}) => {
	await openFolder(page, folder);
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
		await page
			.getByRole("treeitem", { name: "B.markdown", exact: true })
			.click();
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
