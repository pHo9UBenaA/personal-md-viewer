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

function recordingSpawn(calls) {
	return (...args) => {
		calls.push(args);
		const child = new EventEmitter();
		child.unref = () => {};
		process.nextTick(() => child.emit("spawn"));
		return child;
	};
}

test("macOS prefers the installed Viewer app without launching another Chrome window", async () => {
	const env = {};
	const notices = [];
	const result = await openChromeApp("http://md.localhost:8080", {
		platform: "darwin",
		env,
		home: "/test home",
		findWebApp: async (url, options) => {
			assert.equal(url, "http://md.localhost:8080");
			assert.deepEqual(options, { appPath: undefined, home: "/test home" });
			return "/apps/Viewer.app";
		},
		openWebApp: async (path, options) => {
			assert.equal(path, "/apps/Viewer.app");
			assert.deepEqual(options, { env });
		},
		spawnProcess: () => assert.fail("must not launch Chrome app mode"),
		onNotice: (message) => notices.push(message),
	});
	assert.deepEqual(result, { mode: "web-app", path: "/apps/Viewer.app" });
	assert.match(notices[0], /Viewer app:/);
});

test("an uninstalled macOS app falls back and explains the one-time installation", async () => {
	const calls = [],
		notices = [];
	assert.deepEqual(
		await openChromeApp("http://md.localhost:8080", {
			platform: "darwin",
			env: {},
			findWebApp: async () => null,
			checkExecutable: async () => true,
			spawnProcess: recordingSpawn(calls),
			onNotice: (message) => notices.push(message),
		}),
		{ mode: "app-mode" },
	);
	assert.deepEqual(calls[0][1], ["--app=http://md.localhost:8080"]);
	assert.match(notices[0], /インストール/);
});

test("CHROME_PATH bypasses discovery but an explicit VIEWER_APP_PATH takes precedence", async () => {
	const calls = [];
	await openChromeApp("http://md.localhost:8080", {
		platform: "darwin",
		env: { CHROME_PATH: "/custom/chrome" },
		findWebApp: async () => assert.fail("must respect CHROME_PATH"),
		checkExecutable: async () => true,
		spawnProcess: recordingSpawn(calls),
	});
	assert.equal(calls[0][0], "/custom/chrome");
	const result = await openChromeApp("http://md.localhost:8080", {
		platform: "darwin",
		env: { CHROME_PATH: "/custom/chrome", VIEWER_APP_PATH: "/apps/Viewer.app" },
		findWebApp: async (_, { appPath }) => appPath,
		openWebApp: async () => {},
		spawnProcess: () => assert.fail("explicit app must win"),
		onNotice: () => {},
	});
	assert.equal(result.mode, "web-app");
});

test("failed automatic app launch falls back, but an explicit app fails visibly", async () => {
	for (const explicit of [false, true]) {
		const calls = [],
			notices = [];
		const launch = openChromeApp("http://md.localhost:8080", {
			platform: "darwin",
			env: explicit ? { VIEWER_APP_PATH: "/apps/Viewer.app" } : {},
			findWebApp: async () => "/apps/Viewer.app",
			openWebApp: async () => {
				throw new Error("cannot open app");
			},
			checkExecutable: async () => true,
			spawnProcess: recordingSpawn(calls),
			onNotice: (message) => notices.push(message),
		});
		if (explicit) {
			await assert.rejects(launch, /cannot open app/);
			assert.equal(calls.length, 0);
		} else {
			assert.equal((await launch).mode, "app-mode");
			assert.equal(calls.length, 1);
			assert.match(notices[0], /cannot open app/);
		}
	}
});

test("a macOS app override is not silently ignored on other platforms", async () => {
	await assert.rejects(
		openChromeApp("http://localhost:3000", {
			platform: "linux",
			env: { VIEWER_APP_PATH: "/apps/Viewer.app" },
			spawnProcess: () => assert.fail("must not spawn"),
		}),
		/macOS 専用/,
	);
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
