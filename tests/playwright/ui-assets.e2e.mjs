import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { createViewerServer } from "../../src/server.mjs";
import { closeServer, listenOnLoopback } from "../helpers/http.mjs";
import { test } from "./helpers.mjs";

test("theme icons load only local SVG assets without external requests", async ({
	page,
	viewer,
}) => {
	await page.emulateMedia({ colorScheme: "light" });
	const icons = new Set();
	const externalRequests = [];
	page.on("response", (response) => {
		if (response.url().includes("/icons/") && response.ok())
			icons.add(new URL(response.url()).pathname);
	});
	page.on("request", (request) => {
		if (!request.url().startsWith(new URL(viewer.url).origin))
			externalRequests.push(request.url());
	});
	await page.goto("/");
	const toggle = page.getByRole("button", {
		name: "ダークモードに切り替える",
		exact: true,
	});
	await expect(toggle).toHaveAttribute("title", "ダークモードに切り替える");
	await expect.poll(() => icons.has("/icons/moon.svg")).toBe(true);
	await toggle.click();
	await expect(
		page.getByRole("button", { name: "ライトモードに切り替える", exact: true }),
	).toBeVisible();
	await expect.poll(() => icons.has("/icons/sun.svg")).toBe(true);
	expect(externalRequests).toEqual([]);
});

test("UI SVG permission does not enable SVG images or active HTML in the reader", async ({
	page,
	viewer,
}) => {
	const path = join(viewer.directory, "trusted-icons.md");
	await writeFile(
		path,
		'<p>Trusted content</p>\n<button onclick="parent.eventRan = true">Test</button>\n<script>parent.scriptRan = true</script>',
	);
	const server = await createViewerServer({
		contentDirectory: viewer.directory,
		initialPaths: [path],
		allowHtml: true,
	});
	const url = await listenOnLoopback(server);
	try {
		await page.goto(url);
		await page
			.frameLocator("#content")
			.getByRole("button", { name: "Test", exact: true })
			.click();
		await page.locator("#content").evaluate((frame) => {
			const doc = frame.contentDocument;
			frame.contentWindow.imageBlocked = false;
			doc.addEventListener("securitypolicyviolation", (event) => {
				if (event.violatedDirective === "img-src")
					frame.contentWindow.imageBlocked = true;
			});
			const image = doc.createElement("img");
			image.src = `${location.origin}/icons/sun.svg`;
			doc.body.append(image);
		});
		await expect
			.poll(() =>
				page
					.locator("#content")
					.evaluate((frame) => frame.contentWindow.imageBlocked),
			)
			.toBe(true);
		expect(
			await page.evaluate(() => window.eventRan || window.scriptRan),
		).toBeUndefined();
		const policy = await page
			.frameLocator("#content")
			.locator('meta[http-equiv="Content-Security-Policy"]')
			.getAttribute("content");
		expect(policy).toContain("script-src 'none'");
		expect(policy).toContain("img-src blob:");
	} finally {
		await closeServer(server);
	}
});
