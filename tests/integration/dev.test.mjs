import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { requestWithExactHost } from "../helpers/http.mjs";
import { createMockChrome, createTestProject } from "../helpers/project.mjs";

const devTestOptions = { timeout: 20000 };
let project;
before(async () => {
	project = await createTestProject();
});
after(async () => {
	if (project) await rm(project, { recursive: true, force: true });
});

async function reservePort(port = 0) {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => resolve(server));
	});
}

async function occupyPortIfAvailable(port) {
	try {
		return await reservePort(port);
	} catch (error) {
		if (error.code === "EADDRINUSE") return null;
		throw error;
	}
}

async function closePortReservation(server) {
	if (server) await new Promise((resolve) => server.close(resolve));
}

async function selectTestPort() {
	const reservation = await reservePort();
	const port = reservation.address().port;
	await closePortReservation(reservation);
	return port;
}

function launchDev({ port, chromePath, openBrowser = false, args = [] } = {}) {
	const env = { ...process.env, VIEWER_APP_PATH: "", VIEWER_ORIGIN: "" };
	if (chromePath) env.CHROME_PATH = chromePath;
	if (port !== undefined) env.DEV_PORT = String(port);
	else delete env.DEV_PORT;
	const child = spawn(
		process.execPath,
		["scripts/dev.mjs", ...(openBrowser ? [] : ["--no-open"]), ...args],
		{
			cwd: project,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	return { child, exited: once(child, "exit") };
}

async function waitForDevReady(child) {
	return new Promise((resolve, reject) => {
		let output = "";
		const timer = setTimeout(
			() => reject(new Error(`Dev readiness timed out:\n${output}`)),
			17000,
		);
		child.stdout.on("data", (data) => {
			output += data;
			if (output.includes("Dev ready:")) {
				clearTimeout(timer);
				resolve(output);
			}
		});
		child.stderr.on("data", (data) => {
			output += data;
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("exit", () => {
			clearTimeout(timer);
			reject(new Error(`Dev exited before readiness:\n${output}`));
		});
	});
}

async function stopDev({ child, exited }) {
	child.kill("SIGTERM");
	await exited;
}

async function assertPortReleased(port) {
	// Rebinding proves no orphaned watch process retains the port.
	const reservation = await reservePort(port);
	await closePortReservation(reservation);
}

function requestViewer(port) {
	return requestWithExactHost(`http://127.0.0.1:${port}`);
}

function readyPort(output) {
	const port = Number(
		output.match(/Dev ready: http:\/\/127\.0\.0\.1:(\d+)/)?.[1],
	);
	assert.ok(Number.isInteger(port) && port > 0, output);
	return port;
}

test(
	"dev serves the reader directly and releases its port on exit",
	devTestOptions,
	async () => {
		const port = await selectTestPort();
		const dev = launchDev({ port });
		try {
			assert.equal(readyPort(await waitForDevReady(dev.child)), port);
			const response = await requestViewer(port);
			assert.equal(response.status, 200);
			assert.match(await response.text(), /viewer-token/);
			for (const headers of [
				{ Host: `untrusted.example:${port}` },
				{ Origin: "https://untrusted.example" },
				{ "Sec-Fetch-Site": "cross-site" },
			]) {
				const denied = await requestWithExactHost(`http://127.0.0.1:${port}`, {
					headers,
				});
				assert.equal(denied.status, 403);
			}
		} finally {
			await stopDev(dev);
		}
		await assertPortReleased(port);
	},
);

test(
	"dev selects a free port when its default port is occupied",
	devTestOptions,
	async () => {
		const occupied = await occupyPortIfAvailable(8080);
		const dev = launchDev();
		try {
			const port = readyPort(await waitForDevReady(dev.child));
			assert.notEqual(port, 8080);
			assert.equal((await requestViewer(port)).status, 200);
		} finally {
			await stopDev(dev);
			await closePortReservation(occupied);
		}
	},
);

test("dev accepts port zero", devTestOptions, async () => {
	const dev = launchDev({ port: 0 });
	let port;
	try {
		port = readyPort(await waitForDevReady(dev.child));
		assert.equal((await requestViewer(port)).status, 200);
	} finally {
		await stopDev(dev);
	}
	await assertPortReleased(port);
});

test(
	"dev fails rather than changing an occupied fixed port",
	devTestOptions,
	async () => {
		const reservation = await reservePort();
		const dev = launchDev({ port: reservation.address().port });
		try {
			await assert.rejects(
				waitForDevReady(dev.child),
				/Dev exited before readiness/,
			);
			assert.equal((await dev.exited)[0], 1);
		} finally {
			await stopDev(dev);
			await closePortReservation(reservation);
		}
	},
);

test(
	"dev replaces orphaned children after its previous supervisor is killed",
	{
		...devTestOptions,
		skip: process.platform === "win32",
	},
	async () => {
		const port = await selectTestPort();
		const first = launchDev({ port });
		let replacement;
		try {
			await waitForDevReady(first.child);
			first.child.kill("SIGKILL");
			await first.exited;
			replacement = launchDev({ port });
			assert.equal(readyPort(await waitForDevReady(replacement.child)), port);
		} finally {
			if (!first.child.killed) await stopDev(first);
			if (replacement) await stopDev(replacement);
			await first.exited;
		}
		await assertPortReleased(port);
	},
);

for (const { name, hideNotices, args, expected } of [
	{
		name: "CLI flag preserves configured paths",
		hideNotices: false,
		args: ["--no-notices"],
		expected: false,
	},
	{
		name: "config hides notices",
		hideNotices: true,
		args: [],
		expected: false,
	},
	{
		name: "false config keeps notices",
		hideNotices: false,
		args: [],
		expected: true,
	},
]) {
	test(`dev notice settings: ${name}`, devTestOptions, async () => {
		const port = await selectTestPort();
		const path = "content/configured-notice.md";
		await writeFile(join(project, path), "# Configured notice");
		await writeFile(
			join(project, "dev.local.json"),
			JSON.stringify({ paths: [path], hideNotices }),
		);
		const dev = launchDev({ port, args });
		try {
			await waitForDevReady(dev.child);
			const html = await (await requestViewer(port)).text();
			assert.ok(html.includes(`data-show-notices="${expected}"`));
			const token = html.match(/name="viewer-token" content="([^"]+)"/)[1];
			const response = await requestWithExactHost(
				`http://127.0.0.1:${port}/api/initial`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-Viewer-Token": token,
					},
					body: "{}",
				},
			);
			assert.equal(response.status, 200);
			assert.deepEqual(
				(await response.json()).documents.map((doc) => doc.name),
				["configured-notice.md"],
			);
		} finally {
			await stopDev(dev);
			await rm(join(project, "dev.local.json"), { force: true });
			await rm(join(project, path), { force: true });
		}
		await assertPortReleased(port);
	});
}

async function waitUntil(read, accept) {
	const deadline = Date.now() + 8000;
	while (Date.now() < deadline) {
		const value = await read();
		if (accept(value)) return value;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assert.fail("Condition was not met before the deadline");
}

test(
	"dev opens the direct app URL once and does not reopen Chrome on watch restarts",
	{
		...devTestOptions,
		skip: process.platform === "win32",
	},
	async () => {
		const port = await selectTestPort();
		const chrome = await createMockChrome(project);
		const dev = launchDev({
			port,
			openBrowser: true,
			chromePath: chrome.executable,
		});
		try {
			await waitForDevReady(dev.child);
			const log = await waitUntil(
				() => readFile(chrome.log, "utf8").catch(() => ""),
				(text) => text.endsWith("\n"),
			);
			assert.deepEqual(log.trim().split("\n").map(JSON.parse), [
				[`--app=http://127.0.0.1:${port}`],
			]);
			const html = await (await requestViewer(port)).text();
			const token = html.match(/name="viewer-token" content="([^"]+)"/)[1];
			const theme = join(project, "public/scripts/theme.js");
			await writeFile(
				theme,
				`${await readFile(theme, "utf8")}\n// Restart test\n`,
			);
			await waitUntil(
				async () => {
					try {
						return await (await requestViewer(port)).text();
					} catch {
						return "";
					}
				},
				(text) => text.includes("viewer-token") && !text.includes(token),
			);
			assert.equal(await readFile(chrome.log, "utf8"), log);
		} finally {
			await stopDev(dev);
		}
		await assertPortReleased(port);
	},
);

test(
	"dev --no-open disables Chrome launch while still starting the reader",
	{
		...devTestOptions,
		skip: process.platform === "win32",
	},
	async () => {
		const port = await selectTestPort();
		const chrome = await createMockChrome(project);
		await rm(chrome.log, { force: true });
		const dev = launchDev({ port, chromePath: chrome.executable });
		try {
			await waitForDevReady(dev.child);
			assert.equal((await requestViewer(port)).status, 200);
			await new Promise((resolve) => setTimeout(resolve, 200));
			await assert.rejects(readFile(chrome.log), { code: "ENOENT" });
		} finally {
			await stopDev(dev);
		}
		await assertPortReleased(port);
	},
);
