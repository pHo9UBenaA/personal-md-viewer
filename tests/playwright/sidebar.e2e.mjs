import { expect } from "@playwright/test";
import { openFolder, test } from "./helpers.mjs";

test("sidebar width can be dragged, adjusted by keyboard, and restored", async ({
	folder,
	page,
}) => {
	await openFolder(page, folder);
	const sidebar = page.locator("#sidebar");
	const resizer = page.getByRole("separator", { name: "サイドバーの幅" });
	const originalWidth = await sidebar.evaluate(
		(element) => element.getBoundingClientRect().width,
	);
	const handle = await resizer.boundingBox();
	await page.mouse.move(handle.x + handle.width / 2, handle.y + 80);
	await page.mouse.down();
	await page.mouse.move(handle.x + handle.width / 2 + 120, handle.y + 80);
	await page.mouse.up();
	await expect(resizer).toHaveAttribute(
		"aria-valuenow",
		String(originalWidth + 120),
	);
	await resizer.focus();
	await page.keyboard.press("ArrowLeft");
	const adjustedWidth = originalWidth + 100;
	await expect(resizer).toHaveAttribute("aria-valuenow", String(adjustedWidth));
	await page.reload();
	await expect(resizer).toHaveAttribute("aria-valuenow", String(adjustedWidth));
	await expect
		.poll(() =>
			sidebar.evaluate((element) => element.getBoundingClientRect().width),
		)
		.toBe(adjustedWidth);
	await page.setViewportSize({ width: 390, height: 820 });
	await page.setViewportSize({ width: 1280, height: 820 });
	await expect(resizer).toHaveAttribute("aria-valuenow", String(adjustedWidth));
});

test("sidebar width stays within bounds and recovers its preferred width after a narrow viewport", async ({
	folder,
	page,
}) => {
	await openFolder(page, folder);
	const resizer = page.getByRole("separator", { name: "サイドバーの幅" });
	await resizer.focus();
	await page.keyboard.press("Home");
	await expect(resizer).toHaveAttribute("aria-valuenow", "180");
	await page.keyboard.press("ArrowLeft");
	await expect(resizer).toHaveAttribute("aria-valuenow", "180");
	await page.keyboard.press("End");
	await expect(resizer).toHaveAttribute("aria-valuenow", "600");
	await page.keyboard.press("ArrowRight");
	await expect(resizer).toHaveAttribute("aria-valuenow", "600");
	await page.setViewportSize({ width: 800, height: 820 });
	await expect(resizer).toHaveAttribute("aria-valuenow", "474");
	await expect(resizer).toHaveAttribute("aria-valuemax", "474");
	await page.setViewportSize({ width: 1280, height: 820 });
	await expect(resizer).toHaveAttribute("aria-valuenow", "600");
	await expect(resizer).toHaveAttribute("aria-valuemax", "600");
});

test("sidebar resizing works when browser storage is unavailable", async ({
	folder,
	page,
}) => {
	await page.addInitScript(() => {
		for (const method of ["getItem", "setItem"])
			Storage.prototype[method] = () => {
				throw new DOMException("Storage blocked", "SecurityError");
			};
	});
	await openFolder(page, folder);
	const resizer = page.getByRole("separator", { name: "サイドバーの幅" });
	await expect(resizer).toHaveAttribute("aria-valuenow", "250");
	await resizer.focus();
	await page.keyboard.press("ArrowRight");
	await expect(resizer).toHaveAttribute("aria-valuenow", "270");
});
