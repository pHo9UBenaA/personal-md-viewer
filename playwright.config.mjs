import { defineConfig } from "@playwright/test";
export default defineConfig({
	testDir: "tests/playwright",
	testMatch: "**/*.e2e.mjs",
	use: {
		viewport: { width: 1280, height: 820 },
	},
	projects: [
		{ name: "chromium", use: { browserName: "chromium" } },
		{ name: "webkit", use: { browserName: "webkit" } },
	],
});
