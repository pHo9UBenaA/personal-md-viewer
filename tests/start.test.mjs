import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createMockChrome, createTestProject } from "./helpers/project.mjs";

let project;
let chrome;
before(async () => {
	project = await createTestProject();
	chrome = await createMockChrome(project);
});
after(async () => {
	if (project) await rm(project, { recursive: true, force: true });
});

async function launch(args = [], chromePath = chrome.executable) {
	await rm(chrome.log, { force: true });
	const child = spawn(process.execPath, ["src/index.mjs", ...args], {
		cwd: project,
		env: {
			...process.env,
			PORT: "0",
			VIEWER_ORIGIN: "",
			CHROME_PATH: chromePath,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	const exited = once(child, "exit");
	let errors = "";
	child.stderr.on("data", (data) => {
		errors += data;
	});
	const ready = new Promise((resolve, reject) => {
		let output = "";
		const timer = setTimeout(
			() => reject(new Error(`Startup timed out: ${output}\n${errors}`)),
			10000,
		);
		child.stdout.on("data", (data) => {
			output += data;
			const match = output.match(/Markdown viewer: (http:\/\/[^\s]+)\n/);
			if (match) {
				clearTimeout(timer);
				resolve(match[1]);
			}
		});
		child.once("exit", () => {
			clearTimeout(timer);
			reject(new Error(`Server exited: ${errors}`));
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
	return { child, exited, ready, errors: () => errors };
}

async function waitUntil(read, accept) {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		const value = await read();
		if (accept(value)) return value;
		await new Promise((resolve) => setTimeout(resolve, 30));
	}
	assert.fail("Condition was not met before the deadline");
}

const cliOptions = { skip: process.platform === "win32", timeout: 15000 };

test(
	"start opens Chrome app mode at the actual bound port",
	cliOptions,
	async () => {
		const server = await launch();
		try {
			const url = await server.ready;
			const response = await fetch(url);
			assert.equal(response.status, 200);
			assert.match(await response.text(), /data-show-notices="true"/);
			const launches = await waitUntil(
				() => readFile(chrome.log, "utf8").catch(() => ""),
				(text) => text.endsWith("\n"),
			);
			assert.deepEqual(launches.trim().split("\n").map(JSON.parse), [
				[`--app=${url}`],
			]);
		} finally {
			server.child.kill("SIGTERM");
			await server.exited;
		}
	},
);

test(
	"--no-open starts the server without launching Chrome or treating the flag as a path",
	cliOptions,
	async () => {
		const server = await launch(["--no-open"]);
		try {
			const url = await server.ready;
			assert.equal((await fetch(url)).status, 200);
			await new Promise((resolve) => setTimeout(resolve, 200));
			await assert.rejects(readFile(chrome.log), { code: "ENOENT" });
			assert.equal(server.errors(), "");
		} finally {
			server.child.kill("SIGTERM");
			await server.exited;
		}
	},
);

test("--no-notices hides only the onboarding notices", cliOptions, async () => {
	const server = await launch(["--no-open", "--no-notices"]);
	try {
		const url = await server.ready;
		const response = await fetch(url);
		assert.equal(response.status, 200);
		assert.match(await response.text(), /data-show-notices="false"/);
		assert.equal(server.errors(), "");
	} finally {
		server.child.kill("SIGTERM");
		await server.exited;
	}
});

test(
	"missing Chrome leaves a usable server and reports its URL",
	cliOptions,
	async () => {
		const server = await launch([], join(project, "missing-chrome"));
		try {
			const url = await server.ready;
			const errors = await waitUntil(server.errors, (text) =>
				text.includes("Chrome の自動起動に失敗"),
			);
			assert.ok(errors.includes(url));
			assert.equal((await fetch(url)).status, 200);
		} finally {
			server.child.kill("SIGTERM");
			await server.exited;
		}
	},
);
