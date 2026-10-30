import assert from "node:assert/strict";
import { test } from "node:test";
import {
	findInstalledViewerApp,
	openInstalledViewerApp,
	viewerWebAppId,
} from "../../src/runtime/web-app.mjs";

const url = "http://md.localhost:8080";
const info = (overrides = {}) => ({
	CrBundleIdentifier: "com.google.Chrome",
	CFBundleExecutable: "app_mode_loader",
	CrAppModeShortcutID: viewerWebAppId(url),
	CrAppModeShortcutURL: `${url}/`,
	...overrides,
});
const entry = (name) => ({ name, isDirectory: () => true });

test("web app IDs match Chrome's installed manifest identity and canonical origins", () => {
	// Verified against an actual Chrome 156 installation's Info.plist.
	assert.equal(
		viewerWebAppId("http://127.0.0.1:61930"),
		"ekfmfciamhpcjaoileeklanemnkemgca",
	);
	assert.equal(
		viewerWebAppId("http://LOCALHOST:80/"),
		viewerWebAppId("http://localhost"),
	);
	assert.notEqual(
		viewerWebAppId(url),
		viewerWebAppId("http://md.localhost:8081"),
	);
	assert.notEqual(viewerWebAppId(url), viewerWebAppId("http://127.0.0.1:8080"));
});

test("discovery ignores unrelated, broken and symlink entries and accepts renamed Viewer apps", async () => {
	const reads = [];
	const found = await findInstalledViewerApp(url, {
		home: "/test home",
		readDirectory: async () => [
			entry("Z Viewer Renamed.app"),
			entry("B Other.app"),
			entry("A Broken.app"),
			{ name: "C Link.app", isDirectory: () => false },
			entry("notes.txt"),
		],
		readInfo: async (path) => {
			reads.push(path);
			if (path.endsWith("Broken.app")) throw new Error("bad plist");
			return path.endsWith("Renamed.app")
				? info()
				: info({ CrAppModeShortcutID: "unrelated" });
		},
	});
	assert.equal(
		found,
		"/test home/Applications/Chrome Apps.localized/Z Viewer Renamed.app",
	);
	assert.deepEqual(
		reads.map((path) => path.split("/").at(-1)),
		["A Broken.app", "B Other.app", "Z Viewer Renamed.app"],
	);
});

test("system-wide discovery still works when the user app directory cannot be read", async () => {
	const found = await findInstalledViewerApp(url, {
		readDirectory: async (path) => {
			if (path !== "/Applications/Chrome Apps.localized")
				throw new Error("unavailable");
			return [entry("Viewer.app")];
		},
		readInfo: async () => info(),
	});
	assert.equal(found, "/Applications/Chrome Apps.localized/Viewer.app");
});

test("a missing app is a normal discovery result", async () => {
	assert.equal(
		await findInstalledViewerApp(url, { readDirectory: async () => [] }),
		null,
	);
});

test("matching requires both Viewer identity and the current exact start URL", async () => {
	for (const invalid of [
		{},
		info({ CrBundleIdentifier: "unrelated.app" }),
		info({ CFBundleExecutable: "other" }),
		info({ CrAppModeShortcutID: "other" }),
		info({ CrAppModeShortcutURL: "http://md.localhost:8081/" }),
		info({ CrAppModeShortcutURL: `${url}/shortcuts` }),
	]) {
		assert.equal(
			await findInstalledViewerApp(url, {
				readDirectory: async () => [entry("Markdown Viewer.app")],
				readInfo: async () => invalid,
			}),
			null,
		);
	}
});

test("an explicit matching app skips discovery and supports spaces and shell metacharacters", async () => {
	const appPath = "/test home/Viewer $(not a command).app";
	assert.equal(
		await findInstalledViewerApp(url, {
			appPath,
			readDirectory: async () =>
				assert.fail("must not scan for an explicit app"),
			readInfo: async (path) => {
				assert.equal(path, appPath);
				return info();
			},
		}),
		appPath,
	);
});

test("explicit paths reject relative, unreadable and wrong-origin applications", async () => {
	for (const appPath of ["Viewer.app", "/apps/Viewer"]) {
		await assert.rejects(findInstalledViewerApp(url, { appPath }), /絶対パス/);
	}
	await assert.rejects(
		findInstalledViewerApp(url, {
			appPath: "/missing/Viewer.app",
			readInfo: async () => {
				throw new Error("missing");
			},
		}),
		/読み取れません/,
	);
	await assert.rejects(
		findInstalledViewerApp(url, {
			appPath: "/apps/Viewer.app",
			readInfo: async () =>
				info({ CrAppModeShortcutURL: "http://md.localhost:8081/" }),
		}),
		/同じ URL/,
	);
});

test("LaunchServices receives only an app path, without a shell, URL redirect or new-instance flag", async () => {
	const env = { PATH: "/test" };
	let call;
	await openInstalledViewerApp("/test home/Viewer $(not a command).app", {
		env,
		run: async (...args) => {
			call = args;
		},
	});
	assert.deepEqual(call, [
		"/usr/bin/open",
		["-a", "/test home/Viewer $(not a command).app"],
		{ env, timeout: 10000, maxBuffer: 64 * 1024 },
	]);
	await assert.rejects(
		openInstalledViewerApp("/app/Viewer.app", {
			run: async () => {
				throw new Error("LaunchServices rejected the app");
			},
		}),
		/LaunchServices rejected/,
	);
});
