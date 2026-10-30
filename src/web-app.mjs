import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { posix } from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

export function viewerWebAppId(url) {
	const manifestId = new URL("/markdown-viewer", url).href;
	// Chrome preserves a historical double SHA-256 before encoding the first 16 bytes.
	// chromium/src/chrome/browser/web_applications/app_id_helpers.cc
	const hash = createHash("sha256").update(manifestId).digest();
	return createHash("sha256")
		.update(hash)
		.digest("hex")
		.slice(0, 32)
		.replace(/[0-9a-f]/g, (digit) =>
			String.fromCharCode(97 + Number.parseInt(digit, 16)),
		);
}

async function readAppInfo(appPath) {
	const { stdout } = await executeFile(
		"/usr/bin/plutil",
		["-convert", "json", "-o", "-", posix.join(appPath, "Contents/Info.plist")],
		{ timeout: 2000, maxBuffer: 64 * 1024 },
	);
	return JSON.parse(stdout);
}

export async function findInstalledViewerApp(
	url,
	{
		appPath,
		home = homedir(),
		readDirectory = readdir,
		readInfo = readAppInfo,
	} = {},
) {
	const startUrl = new URL("/", url).href;
	const appId = viewerWebAppId(url);
	function matches(info) {
		return (
			info?.CrBundleIdentifier === "com.google.Chrome" &&
			info.CFBundleExecutable === "app_mode_loader" &&
			info.CrAppModeShortcutID === appId &&
			info.CrAppModeShortcutURL === startUrl
		);
	}
	if (appPath) {
		if (!posix.isAbsolute(appPath) || !appPath.endsWith(".app"))
			throw new Error(
				"VIEWER_APP_PATH にはインストール済み .app の絶対パスを指定してください。",
			);
		let info;
		try {
			info = await readInfo(appPath);
		} catch (cause) {
			throw new Error(
				"VIEWER_APP_PATH のアプリを読み取れません。パスとインストール状態を確認してください。",
				{ cause },
			);
		}
		if (!matches(info))
			throw new Error(
				`VIEWER_APP_PATH は ${startUrl} 用の Markdown Viewer アプリではありません。同じ URL でインストールし直してください。`,
			);
		return appPath;
	}
	for (const directory of [
		posix.join(home, "Applications/Chrome Apps.localized"),
		"/Applications/Chrome Apps.localized",
	]) {
		let entries;
		try {
			entries = await readDirectory(directory, { withFileTypes: true });
		} catch {
			continue;
		}
		const names = entries
			.filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"))
			.map((entry) => entry.name)
			.sort();
		for (const name of names) {
			const path = posix.join(directory, name);
			try {
				if (matches(await readInfo(path))) return path;
			} catch {
				/* Unrelated, unreadable or incomplete installations do not prevent Chrome fallback. */
			}
		}
	}
	return null;
}

export async function openInstalledViewerApp(
	appPath,
	{ env = process.env, run = executeFile } = {},
) {
	// LaunchServices activates the app shim, giving it its own Dock / Cmd+Tab identity.
	await run("/usr/bin/open", ["-a", appPath], {
		env,
		timeout: 10000,
		maxBuffer: 64 * 1024,
	});
}
