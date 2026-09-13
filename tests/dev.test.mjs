import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { request } from "node:http";
import { createServer } from "node:net";
import { test } from "node:test";

async function reservePort() {
	const server = createServer();
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return server;
}

async function occupyPort(port) {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", (error) =>
			error.code === "EADDRINUSE" ? resolve(null) : reject(error),
		);
		server.listen(port, "127.0.0.1", () => resolve(server));
	});
}

async function readyOutput(child) {
	return new Promise((resolve, reject) => {
		let output = "";
		const timer = setTimeout(() => reject(new Error(output)), 17000);
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
			reject(new Error(output));
		});
	});
}

test(
	"dev supervises Caddy and the reader and releases both ports on exit",
	{
		skip: spawnSync("caddy", ["version"]).status !== 0,
		timeout: 20000,
	},
	async () => {
		const reservations = await Promise.all([reservePort(), reservePort()]);
		const ports = reservations.map((server) => server.address().port);
		await Promise.all(
			reservations.map(
				(server) => new Promise((resolve) => server.close(resolve)),
			),
		);
		const child = spawn(process.execPath, ["scripts/dev.mjs"], {
			env: {
				...process.env,
				DEV_PORT: String(ports[0]),
				DEV_BACKEND_PORT: String(ports[1]),
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		const exit = once(child, "exit");
		try {
			await readyOutput(child);
			const result = await new Promise((resolve, reject) => {
				const req = request(
					`http://127.0.0.1:${ports[0]}`,
					{ headers: { Host: `md.localhost:${ports[0]}` } },
					(response) => {
						let body = "";
						response.setEncoding("utf8");
						response.on("data", (chunk) => {
							body += chunk;
						});
						response.on("end", () =>
							resolve({ status: response.statusCode, body }),
						);
					},
				);
				req.on("error", reject);
				req.end();
			});
			assert.equal(result.status, 200);
			assert.match(result.body, /viewer-token/);
		} finally {
			child.kill("SIGTERM");
			await exit;
		}
		// Binding both again confirms no orphaned Caddy or Node watch process remains.
		for (const port of ports) {
			const probe = createServer();
			probe.listen(port, "127.0.0.1");
			await once(probe, "listening");
			await new Promise((resolve) => probe.close(resolve));
		}
	},
);

test(
	"dev selects free ports when both default ports are occupied",
	{
		skip: spawnSync("caddy", ["version"]).status !== 0,
		timeout: 20000,
	},
	async () => {
		const occupied = await Promise.all([occupyPort(8080), occupyPort(3100)]);
		const child = spawn(process.execPath, ["scripts/dev.mjs"], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		const exit = once(child, "exit");
		try {
			const output = await readyOutput(child);
			const port = Number(
				output.match(/Dev ready: http:\/\/md\.localhost:(\d+)/)?.[1],
			);
			assert.ok(Number.isInteger(port) && port > 0 && port !== 8080);
			const response = await new Promise((resolve, reject) => {
				const req = request(
					`http://127.0.0.1:${port}`,
					{ headers: { Host: `md.localhost:${port}` } },
					resolve,
				);
				req.on("error", reject);
				req.end();
			});
			assert.equal(response.statusCode, 200);
			response.resume();
		} finally {
			child.kill("SIGTERM");
			await exit;
			await Promise.all(
				occupied.map(
					(server) => server && new Promise((resolve) => server.close(resolve)),
				),
			);
		}
	},
);

test(
	"dev replaces orphaned children after its previous supervisor is killed",
	{
		skip:
			process.platform === "win32" ||
			spawnSync("caddy", ["version"]).status !== 0,
		timeout: 20000,
	},
	async () => {
		const reservations = await Promise.all([reservePort(), reservePort()]);
		const ports = reservations.map((server) => server.address().port);
		await Promise.all(
			reservations.map(
				(server) => new Promise((resolve) => server.close(resolve)),
			),
		);
		const env = {
			...process.env,
			DEV_PORT: String(ports[0]),
			DEV_BACKEND_PORT: String(ports[1]),
		};
		const first = spawn(process.execPath, ["scripts/dev.mjs"], {
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const firstExit = once(first, "exit");
		let second;
		let secondExit;
		try {
			await readyOutput(first);
			first.kill("SIGKILL");
			await firstExit;
			second = spawn(process.execPath, ["scripts/dev.mjs"], {
				env,
				stdio: ["ignore", "pipe", "pipe"],
			});
			secondExit = once(second, "exit");
			assert.match(
				await readyOutput(second),
				new RegExp(`Dev ready: http://md\\.localhost:${ports[0]}\\b`),
			);
		} finally {
			if (!first.killed) first.kill("SIGTERM");
			if (second) {
				second.kill("SIGTERM");
				await secondExit;
			}
			await firstExit;
		}
		for (const port of ports) {
			const probe = createServer();
			probe.listen(port, "127.0.0.1");
			await once(probe, "listening");
			await new Promise((resolve) => probe.close(resolve));
		}
	},
);
