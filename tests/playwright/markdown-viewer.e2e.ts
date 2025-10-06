import { spawn } from "node:child_process";
import { expect, type Page, test } from "@playwright/test";

const startServer = async () => {
	const server = spawn("bun", ["src/index.ts"], {
		env: {
			...process.env,
			PORT: "3000",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});

	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => {
			reject(new Error("Server did not start within timeout"));
		}, 5000);

		const onReady = (data: Buffer) => {
			if (data.toString().includes("Markdown viewer running")) {
				clearTimeout(timeout);
				server.stdout?.off("data", onReady);
				server.stderr?.off("data", onError);
				resolve();
			}
		};

		const onError = (data: Buffer) => {
			clearTimeout(timeout);
			server.stdout?.off("data", onReady);
			server.stderr?.off("data", onError);
			reject(new Error(data.toString()));
		};

		server.stdout?.on("data", onReady);
		server.stderr?.on("data", onError);
		server.on("exit", (code) => {
			clearTimeout(timeout);
			reject(new Error(`Server exited early with code ${code}`));
		});
	});

	return server;
};

const stopServer = (server: ReturnType<typeof spawn>) => {
	server.kill();
};

let serverProcess: ReturnType<typeof spawn> | undefined;

test.beforeAll(async () => {
	serverProcess = await startServer();
});

test.afterAll(() => {
	if (serverProcess) {
		stopServer(serverProcess);
	}
});

const visitHome = (page: Page) => async () => {
	await page.goto("/");
};

const navigateToFile = (page: Page) => async (relativePath: string) => {
	await visitHome(page)();
	await page.getByRole("link", { name: relativePath }).click();
};

test.describe("markdown viewer", () => {
	const linkLabel = "docs/postgresql_explain/Explain_EXPLAIN.md";

	test("lists markdown files on the index page", async ({ page }) => {
		await visitHome(page)();

		const link = page.getByRole("link", { name: linkLabel });

		await expect(link).toHaveAttribute(
			"href",
			`/view?path=${encodeURIComponent(linkLabel)}`,
		);
	});

	test("renders markdown content with navigation and base tag", async ({
		page,
	}) => {
		await navigateToFile(page)(linkLabel);

		await expect(page.getByRole("heading", { name: "Page 1" })).toBeVisible();
		await expect(
			page.getByRole("link", { name: "← Back to list" }),
		).toHaveAttribute("href", "/");

		const baseHref = await page.locator("head base").getAttribute("href");

		expect(baseHref).toBe("/files/docs/postgresql_explain/");
	});

	test("serves image assets referenced from markdown", async ({ page }) => {
		await navigateToFile(page)(linkLabel);

		const firstImage = page.locator("article img").first();
		const imageSrc = await firstImage.getAttribute("src");

		expect(imageSrc).toBe("images/page_1_img_1.png");

		const response = await page.request.get(
			`/files/docs/postgresql_explain/${imageSrc}`,
		);

		expect(response.ok()).toBe(true);
	});
});
