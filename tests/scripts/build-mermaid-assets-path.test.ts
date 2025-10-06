/**
 * @file Guards the mermaid asset build script output location.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT_PATH = resolve("scripts/build-mermaid-assets.mjs");
const EXPECTED_PUBLIC_DIR = "public/scripts/mermaid";

/**
 * Verify the script copies the dist bundle into the mermaid directory within public assets.
 */
describe("mermaid asset build script", () => {
	it("copies assets into the mermaid directory", async () => {
		const source = await readFile(SCRIPT_PATH, "utf8");
		expect(source).toContain(
			`const PUBLIC_MERMAID_DIR = "${EXPECTED_PUBLIC_DIR}";`,
		);
	});
});
