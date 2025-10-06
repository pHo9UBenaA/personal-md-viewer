/**
 * @file Ensures the bundled mermaid client references the local mermaid bundle path.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const CLIENT_SCRIPT_PATH = resolve("public/scripts/mermaid.client.js");
const EXPECTED_MODULE_PATH = "/scripts/mermaid/mermaid.esm.min.mjs";

/**
 * Validate that the mermaid client uses the local bundle distributed during build.
 */
describe("mermaid client asset path", () => {
	it("references the local mermaid bundle", async () => {
		const contents = await readFile(CLIENT_SCRIPT_PATH, "utf8");
		expect(contents).toContain(
			`const MERMAID_MODULE_PATH = "${EXPECTED_MODULE_PATH}";`,
		);
	});
});
