import { expect } from "@playwright/test";
import { openCopiedMarkdown, test } from "./helpers.mjs";

test("the install manifest loads locally without weakening reader CSP or registering a service worker", async ({
	page,
	browserName,
	viewer,
}) => {
	const external = [];
	page.on("request", (request) => {
		if (
			!request.url().startsWith(new URL(viewer.url).origin) &&
			!request.url().startsWith("blob:")
		)
			external.push(request.url());
	});
	await openCopiedMarkdown(page, viewer.directory, {
		name: "web-app.md",
		source: "# Installed reader\n\nContent.",
	});
	await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
		"href",
		"/manifest.webmanifest",
	);
	if (browserName === "chromium") {
		const session = await page.context().newCDPSession(page);
		const manifest = await session.send("Page.getAppManifest");
		expect(manifest.errors).toEqual([]);
		expect(JSON.parse(manifest.data).id).toBe("/markdown-viewer");
		await session.detach();
	}
	const manifest = await (
		await page.request.get("/manifest.webmanifest")
	).json();
	expect(manifest.name).toBe("Markdown Viewer");
	expect(manifest.display).toBe("standalone");
	for (const icon of manifest.icons) {
		const response = await page.request.get(icon.src);
		expect(response.ok()).toBe(true);
		expect(response.headers()["content-type"]).toBe("image/png");
	}
	await expect(
		page
			.frameLocator("#content")
			.getByRole("heading", { name: "Installed reader" }),
	).toBeVisible();
	const policy = await page
		.frameLocator("#content")
		.locator('meta[http-equiv="Content-Security-Policy"]')
		.getAttribute("content");
	expect(policy).toContain("script-src 'none'");
	expect(policy).toContain("img-src blob:");
	expect(
		await page.evaluate(async () =>
			navigator.serviceWorker
				? (await navigator.serviceWorker.getRegistrations()).length
				: 0,
		),
	).toBe(0);
	expect(external).toEqual([]);
});
