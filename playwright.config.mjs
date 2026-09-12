import { defineConfig } from "@playwright/test";
export default defineConfig({
	testDir: "tests/playwright",
	testMatch: "**/*.e2e.mjs",
	use: {
		baseURL: "http://127.0.0.1:3198",
		viewport: { width: 1280, height: 820 },
	},
	webServer: {
		command: "node src/index.mjs",
		port: 3198,
		env: { PORT: "3198" },
		reuseExistingServer: false,
	},
	projects: [
		{ name: "chromium", use: { browserName: "chromium" } },
		{ name: "webkit", use: { browserName: "webkit" } },
	],
});
