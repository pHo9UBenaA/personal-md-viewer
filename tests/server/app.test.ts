/**
 * @file Verifies the observable behaviour of the Hono-based markdown viewer app.
 */

import { describe, expect, test } from "vitest";
import { createMarkdownViewerApp } from "../../src/server/app";
import { createTestEnvironment } from "../helpers/environment";

const buildApp = () => {
	const environment = createTestEnvironment();
	return createMarkdownViewerApp(environment);
};

describe("createMarkdownViewerApp", () => {
	test("GET / returns the index page", async () => {
		const app = buildApp();
		const response = await app.request("/");

		expect(response.status).toBe(200);
		const body = await response.text();
		expect(body).toContain("<h1>Markdown files</h1>");
		expect(body).toContain(
			'<link rel="stylesheet" href="/assets/global.css" />',
		);
		expect(body).toContain(
			'<script type="module" src="/scripts/mermaid.client.js" defer></script>',
		);
	});

	test("GET /view serves a markdown page", async () => {
		const app = buildApp();
		const response = await app.request("/view?path=docs/sample.md");

		expect(response.status).toBe(200);
		const body = await response.text();
		expect(body).toContain("<h1>Sample Document</h1>");
	});

	test("GET /view without path returns bad request", async () => {
		const app = buildApp();
		const response = await app.request("/view");

		expect(response.status).toBe(400);
		const body = await response.text();
		expect(body).toContain("Missing path parameter");
	});

	test("GET /assets/global.css returns global stylesheet", async () => {
		const app = buildApp();
		const response = await app.request("/assets/global.css");

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/css");
		const body = await response.text();
		expect(body).toContain("body");
	});

	test("GET /scripts/mermaid.client.js returns mermaid script", async () => {
		const app = buildApp();
		const response = await app.request("/scripts/mermaid.client.js");

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/javascript");
		const body = await response.text();
		expect(body).toContain("mermaid");
	});
});
