import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createTestEnvironment } from "./helpers/environment";

let environment = createTestEnvironment();

beforeEach(() => {
	environment = createTestEnvironment();
});

afterEach(() => {
	environment.sources.resetSources();
});

describe("listMarkdownFiles", () => {
	test("returns markdown files from the docs source", async () => {
		const { listFiles } = environment.useMarkdownDocuments();
		const files = await listFiles();

		expect(files.length).toBeGreaterThan(0);
		expect(files).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					sourceKey: "docs",
					relativePath: "sample.md",
					urlPath: "docs/sample.md",
				}),
			]),
		);
	});

	test("includes files from a registered source", async () => {
		const root = await mkdtemp(join(tmpdir(), "markdown-viewer-"));
		const filePath = join(root, "extra.md");
		await writeFile(filePath, "# Extra\n");

		const { registerSource } = environment.useMarkdownSources();
		const registration = await registerSource(root);

		try {
			expect(registration.ok).toBe(true);
			if (!registration.ok) {
				return;
			}
			const source = registration.value;
			const { listFiles } = environment.useMarkdownDocuments();
			const files = await listFiles();
			expect(
				files.some(
					(file) =>
						file.sourceKey === source.key &&
						file.relativePath === "extra.md" &&
						file.urlPath === `${source.key}/extra.md`,
				),
			).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("renderMarkdownToHtml", () => {
	test("converts markdown to HTML", async () => {
		const { renderDocument } = environment.useMarkdownDocuments();
		const htmlResult = await renderDocument("docs/sample.md");

		expect(htmlResult.ok).toBe(true);
		if (!htmlResult.ok) {
			return;
		}

		expect(htmlResult.value).toContain("<h1>Sample Document</h1>");
	});
});
