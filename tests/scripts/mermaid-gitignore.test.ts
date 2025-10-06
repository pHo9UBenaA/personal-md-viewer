/**
 * @file Ensures generated mermaid assets remain untracked.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const GITIGNORE_PATH = resolve(".gitignore");
const MERMAID_IGNORE_ENTRY = "public/scripts/mermaid/";

/**
 * Verify the generated mermaid directory stays ignored by git.
 */
describe(".gitignore for mermaid assets", () => {
	it("ignores the mermaid public directory", async () => {
		const patterns = await readFile(GITIGNORE_PATH, "utf8");
		expect(patterns).toContain(MERMAID_IGNORE_ENTRY);
	});
});
