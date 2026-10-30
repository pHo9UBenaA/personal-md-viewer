import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { requestWithExactHost } from "./helpers/http.mjs";
import { createMockChrome, createTestProject } from "./helpers/project.mjs";

const hasCaddy = spawnSync("caddy", ["version"]).status === 0;
const devTestOptions = { skip: !hasCaddy, timeout: 20000 };
let project;
before(async () => {
	if (hasCaddy) project = await createTestProject();
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

async function selectTestPorts() {
	const reservations = await Promise.all([reservePort(), reservePort()]);
	const [proxyPort, backendPort] = reservations.map(
		(server) => server.address().port,
	);
	await Promise.all(reservations.map(closePortReservation));
	return { proxyPort, backendPort };
}

function launchDev({
	proxyPort,
	backendPort,
	chromePath,
	openBrowser = false,
} = {}) {
	const env = { ...process.env };
	if (chromePath) env.CHROME_PATH = chromePath;
	if (proxyPort !== undefined) env.DEV_PORT = String(proxyPort);
	if (backendPort !== undefined) env.DEV_BACKEND_PORT = String(backendPort);
	const child = spawn(
		process.execPath,
		["scripts/dev.mjs", ...(openBrowser ? [] : ["--no-open"])],
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

async function assertPortsReleased({ proxyPort, backendPort }) {
	// Rebinding proves no orphaned proxy or watch process retains either port.
	for (const port of [proxyPort, backendPort]) {
		const reservation = await reservePort(port);
		await closePortReservation(reservation);
	}
}

function requestProxy(port) {
	return requestWithExactHost(`http://127.0.0.1:${port}`, {
		headers: { Host: `md.localhost:${port}` },
	});
}

test(
	"dev supervises Caddy and the reader and releases both ports on exit",
	devTestOptions,
	async () => {
		const ports = await selectTestPorts();
		const dev = launchDev(ports);
		try {
			await waitForDevReady(dev.child);
			const response = await requestProxy(ports.proxyPort);
			assert.equal(response.status, 200);
			assert.match(await response.text(), /viewer-token/);
		} finally {
			await stopDev(dev);
		}
		await assertPortsReleased(ports);
	},
);

test(
	"dev selects free ports when both default ports are occupied",
	devTestOptions,
	async () => {
		const occupied = await Promise.all([
			occupyPortIfAvailable(8080),
			occupyPortIfAvailable(3100),
		]);
		const dev = launchDev();
		try {
			const output = await waitForDevReady(dev.child);
			const port = Number(
				output.match(/Dev ready: http:\/\/md\.localhost:(\d+)/)?.[1],
			);
			assert.ok(Number.isInteger(port) && port > 0, output);
			assert.notEqual(port, 8080, output);
			assert.equal((await requestProxy(port)).status, 200);
		} finally {
			await stopDev(dev);
			await Promise.all(occupied.map(closePortReservation));
		}
	},
);

test(
	"dev replaces orphaned children after its previous supervisor is killed",
	{
		...devTestOptions,
		skip: !hasCaddy || process.platform === "win32",
	},
	async () => {
		const ports = await selectTestPorts();
		const first = launchDev(ports);
		let replacement;
		try {
			await waitForDevReady(first.child);
			first.child.kill("SIGKILL");
			await first.exited;
			replacement = launchDev(ports);
			assert.match(
				await waitForDevReady(replacement.child),
				new RegExp(`Dev ready: http://md\\.localhost:${ports.proxyPort}\\b`),
			);
		} finally {
			if (!first.child.killed) await stopDev(first);
			if (replacement) await stopDev(replacement);
			await first.exited;
		}
		await assertPortsReleased(ports);
	},
);

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
	"dev opens the public app URL once and does not reopen Chrome on watch restarts",
	{
		...devTestOptions,
		skip: !hasCaddy || process.platform === "win32",
	},
	async () => {
		const ports = await selectTestPorts();
		const chrome = await createMockChrome(project);
		const dev = launchDev({
			...ports,
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
				[`--app=http://md.localhost:${ports.proxyPort}`],
			]);
			const html = await (await requestProxy(ports.proxyPort)).text();
			const token = html.match(/name="viewer-token" content="([^"]+)"/)[1];
			const theme = join(project, "public/theme.js");
			await writeFile(
				theme,
				`${await readFile(theme, "utf8")}\n// Restart test\n`,
			);
			await waitUntil(
				async () => {
					try {
						return await (await requestProxy(ports.proxyPort)).text();
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
		await assertPortsReleased(ports);
	},
);

test(
	"dev --no-open disables Chrome launch while still starting the proxy",
	{
		...devTestOptions,
		skip: !hasCaddy || process.platform === "win32",
	},
	async () => {
		const ports = await selectTestPorts();
		const chrome = await createMockChrome(project);
		await rm(chrome.log, { force: true });
		const dev = launchDev({ ...ports, chromePath: chrome.executable });
		try {
			await waitForDevReady(dev.child);
			assert.equal((await requestProxy(ports.proxyPort)).status, 200);
			await new Promise((resolve) => setTimeout(resolve, 200));
			await assert.rejects(readFile(chrome.log), { code: "ENOENT" });
		} finally {
			await stopDev(dev);
		}
		await assertPortsReleased(ports);
	},
);
