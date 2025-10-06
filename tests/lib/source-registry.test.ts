import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { createSourceRegistry } from "../../src/libs/source-registry";
import { DEFAULT_SOURCE_KEY } from "../../src/types/source";

const createTempDirectory = async () => {
	const root = await mkdtemp(join(tmpdir(), "markdown-viewer-registry-"));
	const filePath = join(root, "sample.md");
	await writeFile(filePath, "# Sample\n");
	return { root, filePath };
};

describe("createSourceRegistry", () => {
	test("initialises with the default docs source", () => {
		const registry = createSourceRegistry();
		const sources = registry.listSources();

		expect(sources.some((source) => source.key === DEFAULT_SOURCE_KEY)).toBe(
			true,
		);
	});

	test("registers new directories with generated keys", async () => {
		const registry = createSourceRegistry();
		const { root } = await createTempDirectory();

		try {
			const registration = await registry.registerSource(root);

			expect(registration.ok).toBe(true);
			if (!registration.ok) {
				return;
			}

			expect(registration.value.key).toMatch(/^source-/);
			expect(registration.value.rootPath).toBe(root);
			expect(registry.listSources()).toContainEqual(registration.value);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("reset restores registry to initial state", async () => {
		const registry = createSourceRegistry();
		const { root } = await createTempDirectory();

		try {
			await registry.registerSource(root);
			registry.reset();
			const sources = registry.listSources();

			expect(sources).toHaveLength(1);
			expect(sources[0]?.key).toBe(DEFAULT_SOURCE_KEY);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
