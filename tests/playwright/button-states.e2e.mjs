import { expect } from "@playwright/test";
import { openCopiedMarkdown, test } from "./helpers.mjs";

for (const theme of ["dark", "light"]) {
	test(`subtle buttons distinguish enabled, disabled and keyboard focus in ${theme} mode`, async ({
		page,
		viewer,
	}) => {
		await page.emulateMedia({ colorScheme: theme });
		await openCopiedMarkdown(page, viewer.directory, {
			name: `button-${theme}.md`,
			source: "# Button states",
		});
		await page.mouse.move(1, 1);
		const expected = await page.locator("html").evaluate((element) => {
			const probe = document.createElement("span");
			probe.style.backgroundColor = "var(--hover)";
			element.append(probe);
			const colors = {
				text: getComputedStyle(element).color,
				hover: getComputedStyle(probe).backgroundColor,
			};
			probe.remove();
			return colors;
		});
		for (const id of ["palette-open", "close-all", "reload", "theme-toggle"]) {
			const button = page.locator(`#${id}`);
			await expect(button).toBeEnabled();
			await expect(button).toHaveCSS("border-color", "rgba(0, 0, 0, 0)");
			await expect(button).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
			await expect(button).toHaveCSS("color", expected.text);
			await expect(button).toHaveCSS("opacity", "1");
		}
		const close = page.locator("#close-all");
		await close.hover();
		await expect(close).toHaveCSS("background-color", expected.hover);
		await close.click();
		await expect(close).toBeDisabled();
		await expect(close).toHaveCSS("opacity", "0.5");
		await expect(close).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
		// Enter keyboard modality; native Tab stops depend on WebKit's platform settings.
		await page.keyboard.press("Tab");
		const reopen = page.locator("#reopen-closed");
		await reopen.focus();
		await expect(reopen).toBeFocused();
		await expect(reopen).toHaveCSS("outline-style", "solid");
		await expect(reopen).toHaveCSS("outline-width", "2px");
	});
}
