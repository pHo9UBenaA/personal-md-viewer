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
		let output = "";
		try {
			await new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(output)), 17000);
				child.stdout.on("data", (data) => {
					output += data;
					if (output.includes("Dev ready:")) {
						clearTimeout(timer);
						resolve();
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
