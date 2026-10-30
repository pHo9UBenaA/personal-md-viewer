import { expect } from "@playwright/test";
import { openCopiedMarkdown, test } from "./helpers.mjs";

test("self-hosted BIZ UD faces cover Japanese and Latin in regular and bold", async ({
	page,
	viewer,
	browserName,
}) => {
	const external = [];
	const loadedFonts = new Set();
	const viewerOrigin = new URL(viewer.url).origin;
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (url.origin !== viewerOrigin && url.protocol !== "blob:")
			external.push(url.href);
	});
	page.on("response", (response) => {
		if (response.ok() && response.url().endsWith(".woff2"))
			loadedFonts.add(new URL(response.url()).pathname);
	});
	await openCopiedMarkdown(page, viewer.directory, {
		name: "日本語-Latin.md",
		source:
			"# 日本語 Latin ABC\n\n日本語 ABC 123\n\n**太字 Bold 456**\n\n`日本語 ABC 123`",
	});
	await expect(page.frameLocator("#content").locator("body")).toHaveAttribute(
		"tabindex",
		"-1",
	);
	await expect(page.locator("#reload")).toHaveCSS(
		"font-family",
		/^"?BIZ UDPGothic/,
	);
	await expect(page.frameLocator("#content").locator("body")).toHaveCSS(
		"font-family",
		/^"?BIZ UDPGothic/,
	);
	await expect(page.frameLocator("#content").locator("code")).toHaveCSS(
		"font-family",
		/^"?BIZ UDGothic/,
	);
	const probes = await page.evaluate(async () => {
		const container = document.createElement("div");
		container.style.cssText =
			"position:fixed;bottom:0;left:0;pointer-events:none";
		document.body.append(container);
		const probes = [];
		for (const family of ["BIZ UDPGothic", "BIZ UDGothic"]) {
			for (const weight of [400, 700]) {
				for (const text of [
					"Latin ABC xyz 123",
					"日本語ひらがなカタカナ漢字",
				]) {
					await document.fonts.load(`${weight} 13px "${family}"`, text);
					const span = document.createElement("span");
					span.id = `font-probe-${probes.length}`;
					span.style.font = `${weight} 13px "${family}"`;
					span.textContent = text;
					container.append(span);
					probes.push({ id: span.id, family, weight });
				}
			}
		}
		await document.fonts.ready;
		// Paint the new spans before querying the fonts used for their glyphs.
		await new Promise((resolve) =>
			requestAnimationFrame(() => requestAnimationFrame(resolve)),
		);
		return probes;
	});
	if (browserName === "chromium") {
		const session = await page.context().newCDPSession(page);
		await session.send("DOM.enable");
		await session.send("CSS.enable");
		const { root } = await session.send("DOM.getDocument");
		for (const probe of probes) {
			const { nodeId } = await session.send("DOM.querySelector", {
				nodeId: root.nodeId,
				selector: `#${probe.id}`,
			});
			const { fonts } = await session.send("CSS.getPlatformFontsForNode", {
				nodeId,
			});
			expect(fonts.length, JSON.stringify(probe)).toBeGreaterThan(0);
			for (const font of fonts) {
				expect(font.isCustomFont, JSON.stringify(probe)).toBe(true);
				expect(font.familyName).toBe(probe.family);
				expect(font.postScriptName).toContain(
					probe.weight === 700 ? "Bold" : "Regular",
				);
			}
		}
		await session.detach();
	}
	const widths = await page.evaluate(() => {
		const context = document.createElement("canvas").getContext("2d");
		context.font = '15px "BIZ UDGothic"';
		context.fontKerning = "none";
		return {
			latin: context.measureText("AA").width,
			japanese: context.measureText("日").width,
			narrow: context.measureText("iii").width,
			wide: context.measureText("WWW").width,
		};
	});
	expect(widths.latin).toBeCloseTo(widths.japanese, 2);
	expect(widths.narrow).toBeCloseTo(widths.wide, 2);
	for (const family of ["BIZUDPGothic", "BIZUDGothic"]) {
		for (const weight of ["Regular", "Bold"])
			expect(loadedFonts.has(`/fonts/${family}-${weight}.woff2`)).toBe(true);
	}
	await page.getByRole("button", { name: "Raw", exact: true }).click();
	await expect(page.frameLocator("#content").locator("pre")).toHaveCSS(
		"font-family",
		/^"?BIZ UDGothic/,
	);
	await expect(page.frameLocator("#content").locator("pre")).toHaveCSS(
		"font-size",
		"15px",
	);
	await expect(page.frameLocator("#content").locator("body")).toHaveAttribute(
		"tabindex",
		"-1",
	);
	expect(external).toEqual([]);
});
