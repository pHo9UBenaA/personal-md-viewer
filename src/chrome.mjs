import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

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
	} = {},
) {
	let executable;
	for (const path of chromeCandidates({ platform, env })) {
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
}
