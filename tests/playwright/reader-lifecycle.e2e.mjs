import { expect } from "@playwright/test";
import { openFolder, test } from "./helpers.mjs";

test("switching readers revokes old Blob URLs and discards late image responses", async ({
	page,
	folder,
}) => {
	await page.addInitScript(() => {
		window.createdImages = [];
		window.revokedImages = [];
		const create = URL.createObjectURL.bind(URL);
		const revoke = URL.revokeObjectURL.bind(URL);
		URL.createObjectURL = (blob) => {
			const url = create(blob);
			window.createdImages.push(url);
			return url;
		};
		URL.revokeObjectURL = (url) => {
			window.revokedImages.push(url);
			revoke(url);
		};
	});
	await openFolder(page, folder);
	await expect(
		page.frameLocator("#content").getByRole("img", { name: "pixel" }),
	).toHaveAttribute("src", /^blob:/);
	const created = await page.evaluate(() => [...window.createdImages]);
	expect(created).toHaveLength(1);
	const received = Promise.withResolvers();
	const released = Promise.withResolvers();
	await page.route("**/api/image", async (route) => {
		const response = await route.fetch();
		received.resolve();
		await released.promise;
		await route.fulfill({ response });
	});
	try {
		await page.locator("#reload").click();
		await received.promise;
		await page
			.getByRole("treeitem", { name: "B.markdown", exact: true })
			.click();
		const heading = page
			.frameLocator("#content")
			.getByRole("heading", { name: "Second document" });
		await expect(heading).toBeVisible();
		expect(await page.evaluate(() => window.revokedImages)).toEqual(created);
		const response = page.waitForResponse("**/api/image");
		released.resolve();
		await (await response).finished();
		await page.evaluate(
			() =>
				new Promise((resolve) =>
					requestAnimationFrame(() => requestAnimationFrame(resolve)),
				),
		);
		await expect(heading).toBeVisible();
		await expect(page.frameLocator("#content").locator("img")).toHaveCount(0);
		expect(await page.evaluate(() => window.createdImages)).toEqual(created);
	} finally {
		released.resolve();
		await page.unrouteAll({ behavior: "wait" });
	}
});

test("detached reader documents no longer handle shortcuts or dropped files", async ({
	page,
	folder,
}) => {
	await openFolder(page, folder);
	await expect(page.frameLocator("#content").locator("body")).toHaveAttribute(
		"tabindex",
		"-1",
	);
	await page.locator("#content").evaluate((frame) => {
		window.retiredReader = frame.contentDocument;
	});
	await page.getByRole("treeitem", { name: "B.markdown", exact: true }).click();
	await expect(
		page
			.frameLocator("#content")
			.getByRole("heading", { name: "Second document" }),
	).toBeVisible();
	const message = await page.getByRole("status").textContent();
	const canceled = await page.evaluate(() => {
		const doc = window.retiredReader;
		const key = new KeyboardEvent("keydown", {
			key: "w",
			metaKey: true,
			bubbles: true,
			cancelable: true,
		});
		const drop = new DragEvent("drop", { bubbles: true, cancelable: true });
		doc.dispatchEvent(key);
		doc.dispatchEvent(drop);
		return [key.defaultPrevented, drop.defaultPrevented];
	});
	expect(canceled).toEqual([false, false]);
	await expect(page.getByRole("tab")).toHaveCount(2);
	await expect(page.getByRole("status")).toHaveText(message);
});
