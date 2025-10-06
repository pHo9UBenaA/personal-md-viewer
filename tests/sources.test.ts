import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { createMarkdownSources } from "../src/sources";

describe("createMarkdownSources", () => {
	test("includes docs directory by default", () => {
		const sources = createMarkdownSources();
		const listed = sources.listSources();

		expect(listed.some((source) => source.key === "docs")).toBe(true);
	});

	test("allows registering a new directory", async () => {
		const sources = createMarkdownSources();
		const root = await mkdtemp(join(tmpdir(), "markdown-viewer-"));
		const filePath = join(root, "example.md");
		await writeFile(filePath, "# Example\n");

		const registration = await sources.registerSource(root);

		try {
			expect(registration.ok).toBe(true);
			if (!registration.ok) {
				return;
			}
			expect(registration.value.rootPath).toBe(root);
			expect(registration.value.key).toMatch(/^source-/);
			expect(sources.listSources()).toContainEqual(registration.value);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("keeps instances isolated", async () => {
		const sharedRoot = await mkdtemp(
			join(tmpdir(), "markdown-viewer-isolated-"),
		);
		const filePath = join(sharedRoot, "isolated.md");
		await writeFile(filePath, "# Isolated\n");

		const first = createMarkdownSources();
		const second = createMarkdownSources();
		await first.registerSource(sharedRoot);

		try {
			expect(first.listSources().length).toBeGreaterThan(
				second.listSources().length,
			);
			expect(
				second.listSources().some((source) => source.rootPath === sharedRoot),
			).toBe(false);
		} finally {
			await rm(sharedRoot, { recursive: true, force: true });
		}
	});
});
