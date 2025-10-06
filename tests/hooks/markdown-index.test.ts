import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createTestEnvironment } from "../helpers/environment";

let environment = createTestEnvironment();

beforeEach(() => {
	environment = createTestEnvironment();
});

afterEach(() => {
	environment.sources.resetSources();
});

describe("useMarkdownIndex", () => {
	test("returns default docs section with navigation tree", async () => {
		const { sections } = await environment.useMarkdownIndex();
		const docsSection = sections.find(
			(section) => section.source.key === "docs",
		);

		expect(docsSection).toBeDefined();
		expect(docsSection?.files.length).toBeGreaterThan(0);
		expect(docsSection?.tree).toBeDefined();
	});

	test("includes registered sources with their files", async () => {
		const root = await mkdtemp(join(tmpdir(), "markdown-viewer-"));
		const filePath = join(root, "hook-example.md");
		await writeFile(filePath, "# Hook Example\n");

		const { registerSource } = environment.useMarkdownSources();
		const registration = await registerSource(root);

		try {
			expect(registration.ok).toBe(true);
			if (!registration.ok) {
				return;
			}

			const { sections } = await environment.useMarkdownIndex();
			const hookSection = sections.find(
				(section) => section.source.key === registration.value.key,
			);

			expect(hookSection).toBeDefined();
			expect(hookSection?.files.map((file) => file.relativePath)).toContain(
				"hook-example.md",
			);
			expect(hookSection?.tree).toBeDefined();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
