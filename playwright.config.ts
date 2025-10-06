import type { PlaywrightTestConfig } from "@playwright/test";

const config: PlaywrightTestConfig = {
	testDir: "tests/playwright",
	testMatch: "**/*.e2e.ts",
	use: {
		baseURL: "http://127.0.0.1:3000",
	},
};

export default config;
