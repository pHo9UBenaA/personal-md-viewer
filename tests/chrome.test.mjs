import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { chromeCandidates, openChromeApp } from "../src/chrome.mjs";

test("Chrome discovery supports standard installations and an explicit override", () => {
	assert.deepEqual(
		chromeCandidates({ platform: "darwin", env: {}, home: "/home/reader" }),
		[
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/home/reader/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		],
	);
	assert.deepEqual(
		chromeCandidates({ platform: "linux", env: { PATH: "/one:/two" } }),
		[
			"/one/google-chrome",
			"/one/google-chrome-stable",
			"/two/google-chrome",
			"/two/google-chrome-stable",
		],
	);
	assert.deepEqual(
		chromeCandidates({
			platform: "win32",
			env: { LOCALAPPDATA: "C:\\Users\\Reader\\AppData\\Local" },
		}),
		[
			"C:\\Users\\Reader\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
		],
	);
	assert.deepEqual(
		chromeCandidates({ env: { CHROME_PATH: "/custom/Chrome with spaces" } }),
		["/custom/Chrome with spaces"],
	);
	assert.deepEqual(chromeCandidates({ platform: "unsupported", env: {} }), []);
});

test("app launch passes one URL argument without a shell or relaxed browser security", async () => {
	const env = { PATH: "/one:/two" };
	const attempts = [];
	let spawnCall;
	let unreferenced = false;
	await openChromeApp("http://md.localhost:8080", {
		platform: "linux",
		env,
		checkExecutable: async (path) => {
			attempts.push(path);
			return path === "/two/google-chrome";
		},
		spawnProcess: (...args) => {
			spawnCall = args;
			const child = new EventEmitter();
			child.unref = () => {
				unreferenced = true;
			};
			process.nextTick(() => child.emit("spawn"));
			return child;
		},
	});
	assert.deepEqual(attempts, [
		"/one/google-chrome",
		"/one/google-chrome-stable",
		"/two/google-chrome",
	]);
	assert.deepEqual(spawnCall, [
		"/two/google-chrome",
		["--app=http://md.localhost:8080"],
		{ env, detached: true, stdio: "ignore" },
	]);
	assert.equal(unreferenced, true);
});

test("missing or unlaunchable Chrome is reported to the caller", async () => {
	await assert.rejects(
		openChromeApp("http://127.0.0.1:3000", {
			env: { CHROME_PATH: "/missing" },
			checkExecutable: async () => false,
			spawnProcess: () => {
				assert.fail("must not spawn a missing executable");
			},
		}),
		/Google Chrome が見つかりません/,
	);
	await assert.rejects(
		openChromeApp("http://127.0.0.1:3000", {
			env: { CHROME_PATH: "/unlaunchable" },
			checkExecutable: async () => true,
			spawnProcess: () => {
				const child = new EventEmitter();
				process.nextTick(() =>
					child.emit("error", new Error("permission denied")),
				);
				return child;
			},
		}),
		/permission denied/,
	);
});
