import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { findInstalledViewerApp, openInstalledViewerApp } from "./web-app.mjs";

export function chromeCandidates({
	platform = process.platform,
	env = process.env,
	home = homedir(),
} = {}) {
	if (env.CHROME_PATH) return [env.CHROME_PATH];
	if (platform === "darwin")
		return [
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			posix.join(
				home,
				"Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			),
		];
	if (platform === "win32")
		return [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA]
			.filter(Boolean)
			.map((directory) =>
				win32.join(directory, "Google/Chrome/Application/chrome.exe"),
			);
	if (platform === "linux")
		return (env.PATH ?? "")
			.split(":")
			.filter(Boolean)
			.flatMap((directory) =>
				["google-chrome", "google-chrome-stable"].map((name) =>
					posix.join(directory, name),
				),
			);
	return [];
}

async function isExecutable(path) {
	try {
		await access(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

// Chrome is independent of the server: never signal an existing browser on shutdown.
export async function openChromeApp(
	url,
	{
		platform = process.platform,
		env = process.env,
		checkExecutable = isExecutable,
		spawnProcess = spawn,
		home = homedir(),
		findWebApp = findInstalledViewerApp,
		openWebApp = openInstalledViewerApp,
		onNotice = console.log,
	} = {},
) {
	if (env.VIEWER_APP_PATH && platform !== "darwin")
		throw new Error(
			"VIEWER_APP_PATH による独立アプリの起動は macOS 専用です。",
		);
	if (platform === "darwin" && (env.VIEWER_APP_PATH || !env.CHROME_PATH)) {
		const appPath = await findWebApp(url, {
			appPath: env.VIEWER_APP_PATH,
			home,
		});
		if (appPath) {
			try {
				await openWebApp(appPath, { env });
				onNotice(`Viewer app: ${appPath}`);
				return { mode: "web-app", path: appPath };
			} catch (error) {
				if (env.VIEWER_APP_PATH) throw error;
				onNotice(
					`独立アプリを起動できないため、Chrome アプリモードで開きます。${error.message}`,
				);
			}
		} else {
			onNotice(
				"独立アプリが見つからないため、Chrome アプリモードで開きます。⌘Tab で分けるには、ターミナルに表示された URL を通常の Chrome で開き、「ページをアプリとしてインストール」を選んでください。",
			);
		}
	}
	let executable;
	for (const path of chromeCandidates({ platform, env, home })) {
		if (await checkExecutable(path)) {
			executable = path;
			break;
		}
	}
	if (!executable)
		throw new Error(
			"Google Chrome が見つかりません。Chrome を導入するか、CHROME_PATH に実行ファイルのパスを指定してください。",
		);
	await new Promise((resolve, reject) => {
		const child = spawnProcess(executable, [`--app=${url}`], {
			env,
			detached: true,
			stdio: "ignore",
		});
		child.once("error", reject);
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	});
	return { mode: "app-mode" };
}
