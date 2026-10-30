import { spawn, spawnSync } from "node:child_process";
import {
	readFileSync,
	readlinkSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { openChromeApp } from "../src/runtime/chrome.mjs";

const projectDirectory = fileURLToPath(new URL("../", import.meta.url)).slice(
	0,
	-1,
);
const statePath = fileURLToPath(
	new URL("../.dev-processes.json", import.meta.url),
);
const openBrowser = !process.argv.includes("--no-open");
const args = process.argv
	.slice(2)
	.filter((arg) => arg !== "--" && arg !== "--no-open");
const commandPatternByKind = {
	supervisor: /(?:^|\/)node(?:\s|$).*\bscripts\/dev\.mjs(?:\s|$)/,
	viewer: /(?:^|\/)node(?:\s|$).*--watch.*\bsrc\/index\.mjs(?:\s|$)/,
	proxy: /(?:^|\/)caddy run --config - --adapter caddyfile$/,
};

// Verify command and working directory before signalling a PID that may be reused.
function isManagedProcess(pid, kind) {
	if (!Number.isInteger(pid) || pid < 1 || pid === process.pid) return false;
	const info = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
		encoding: "utf8",
	});
	if (info.status !== 0) return false;
	const command = info.stdout.trim();
	if (!commandPatternByKind[kind]?.test(command)) return false;
	if (process.platform === "linux") {
		try {
			return readlinkSync(`/proc/${pid}/cwd`) === projectDirectory;
		} catch {
			return false;
		}
	}
	const cwd = spawnSync(
		"lsof",
		["-nP", "-a", "-p", String(pid), "-d", "cwd", "-Fn"],
		{
			encoding: "utf8",
		},
	);
	return (
		cwd.status === 0 && cwd.stdout.split("\n").includes(`n${projectDirectory}`)
	);
}
function signalRecordedProcess({ pid, kind }, signal) {
	if (!isManagedProcess(pid, kind)) return;
	try {
		const targetPid = kind === "supervisor" ? pid : -pid;
		process.kill(targetPid, signal);
	} catch (error) {
		if (error.code !== "ESRCH") throw error;
	}
}

async function stopPrevious() {
	let state;
	try {
		state = JSON.parse(await readFile(statePath, "utf8"));
	} catch (error) {
		if (error.code === "ENOENT") return;
		throw error;
	}
	if (!Number.isInteger(state.pid) || !Array.isArray(state.children))
		throw new Error(".dev-processes.json の形式が不正です。");
	const processes = [
		{ pid: state.pid, kind: "supervisor" },
		...state.children.filter(
			(child) =>
				child &&
				Number.isInteger(child.pid) &&
				["viewer", "proxy"].includes(child.kind),
		),
	];
	for (const recordedProcess of processes)
		signalRecordedProcess(recordedProcess, "SIGTERM");
	const stopDeadlineMs = Date.now() + 4000;
	while (
		Date.now() < stopDeadlineMs &&
		processes.some(({ pid, kind }) => isManagedProcess(pid, kind))
	)
		await new Promise((resolve) => setTimeout(resolve, 50));
	for (const recordedProcess of processes)
		signalRecordedProcess(recordedProcess, "SIGKILL");
	try {
		if (JSON.parse(readFileSync(statePath, "utf8")).pid === state.pid)
			unlinkSync(statePath);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
}
function probePort(port) {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			const available = server.address().port;
			server.close((error) => (error ? reject(error) : resolve(available)));
		});
	});
}
async function selectAvailablePort(preferredPort, excludedPort) {
	let port;
	try {
		port = await probePort(preferredPort);
	} catch (error) {
		if (!["EADDRINUSE", "EPERM"].includes(error.code)) throw error;
		port = await probePort(0);
	}
	while (port === excludedPort) port = await probePort(0);
	return port;
}
async function loadViewerArgs() {
	const explicitPaths = args.filter(
		(arg) => !["--recursive", "--allow-html", "--no-notices"].includes(arg),
	);
	let source;
	try {
		source = await readFile(
			new URL("../dev.local.json", import.meta.url),
			"utf8",
		);
	} catch (error) {
		if (error.code === "ENOENT") return args;
		throw error;
	}
	const config = JSON.parse(source);
	if (
		!config ||
		typeof config !== "object" ||
		!Array.isArray(config.paths) ||
		config.paths.some((path) => typeof path !== "string" || !path.trim()) ||
		(config.recursive !== undefined && typeof config.recursive !== "boolean") ||
		(config.allowHtml !== undefined && typeof config.allowHtml !== "boolean") ||
		(config.hideNotices !== undefined &&
			typeof config.hideNotices !== "boolean")
	)
		throw new Error(
			"dev.local.json の paths には文字列の配列を指定してください。recursive / allowHtml / hideNotices は省略できますが、指定する場合は真偽値にしてください。",
		);
	return [
		...(config.recursive && !args.includes("--recursive")
			? ["--recursive"]
			: []),
		...(config.allowHtml && !args.includes("--allow-html")
			? ["--allow-html"]
			: []),
		...(config.hideNotices && !args.includes("--no-notices")
			? ["--no-notices"]
			: []),
		...args,
		...(explicitPaths.length === 0 ? config.paths : []),
	];
}
async function selectDevPort(configuredValue, preferredPort, excludedPort) {
	if (configuredValue === undefined)
		return selectAvailablePort(preferredPort, excludedPort);
	const requestedPort = Number(configuredValue);
	if (requestedPort === 0) return selectAvailablePort(0, excludedPort);
	return requestedPort;
}

// Signal the whole watch/proxy group so descendants do not retain ports.
function signalChildGroup(child, signal = "SIGTERM") {
	try {
		if (process.platform === "win32") child.kill(signal);
		else process.kill(-child.pid, signal);
	} catch {
		/* The group may have exited before the signal. */
	}
}

if (args.includes("--help") || args.includes("-h")) {
	console.log(
		"Usage: pnpm dev [--no-open] [--no-notices] [--recursive] [--allow-html] [file.md | directory ...]\n--allow-html renders raw HTML in trusted Markdown. Uses ports 8080 and 3100 when available; otherwise selects free ports. DEV_PORT and DEV_BACKEND_PORT override them.\nStarts Caddy and a watched reader on loopback without sudo. Ctrl+C stops both. Once the proxy is ready, opens the installed macOS Markdown Viewer app for this URL, or falls back to Chrome app mode. --no-open disables browser launch; --no-notices hides the shortcut and copied-document notices, not errors or operation results. CHROME_PATH bypasses app discovery; VIEWER_APP_PATH explicitly selects a matching macOS .app.",
	);
} else {
	const children = new Set();
	const childKinds = new Map();
	let stopping = false;
	let startupTimer;
	let browserOpened = false;
	function writeState() {
		const temporary = `${statePath}.${process.pid}.tmp`;
		writeFileSync(
			temporary,
			JSON.stringify({
				pid: process.pid,
				children: [...children]
					.filter((child) => child.pid)
					.map((child) => ({ pid: child.pid, kind: childKinds.get(child) })),
			}),
		);
		renameSync(temporary, statePath);
	}
	function releaseState() {
		try {
			if (JSON.parse(readFileSync(statePath, "utf8")).pid === process.pid)
				unlinkSync(statePath);
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
	}
	function stop(code) {
		if (stopping) return;
		stopping = true;
		clearTimeout(startupTimer);
		process.exitCode = code;
		for (const child of children) signalChildGroup(child);
		const forceStopTimer = setTimeout(() => {
			for (const child of children) signalChildGroup(child, "SIGKILL");
		}, 3000);
		forceStopTimer.unref();
		if (children.size === 0) releaseState();
	}
	function launch(command, argv, options = {}) {
		const child = spawn(command, argv, {
			cwd: projectDirectory,
			detached: process.platform !== "win32",
			stdio: ["pipe", "pipe", "pipe"],
			...options,
		});
		children.add(child);
		childKinds.set(child, command === "caddy" ? "proxy" : "viewer");
		writeState();
		child.on("error", (error) => {
			console.error(
				error.code === "ENOENT"
					? `${command} が見つかりません。Caddy は brew install caddy で導入できます。`
					: error.message,
			);
			stop(1);
		});
		child.on("close", (code) => {
			children.delete(child);
			childKinds.delete(child);
			if (stopping) {
				if (children.size === 0) releaseState();
				return;
			}
			writeState();
			console.error(`${command} が終了しました (${code})。`);
			stop(code || 1);
		});
		return child;
	}
	function onOutputLine(stream, callback) {
		let pending = "";
		stream.setEncoding("utf8");
		stream.on("data", (chunk) => {
			pending += chunk;
			let end = pending.indexOf("\n");
			while (end >= 0) {
				const line = pending.slice(0, end);
				pending = pending.slice(end + 1);
				callback(line);
				end = pending.indexOf("\n");
			}
		});
	}
	process.on("SIGINT", () => stop(0));
	process.on("SIGTERM", () => stop(0));
	process.on("exit", () => {
		for (const child of children) signalChildGroup(child);
	});
	try {
		await stopPrevious();
		const viewerArgs = await loadViewerArgs();
		const configuredPort = process.env.DEV_PORT;
		const configuredBackend = process.env.DEV_BACKEND_PORT;
		const requestedPort = Number(configuredPort ?? 8080);
		const requestedBackend = Number(configuredBackend ?? 3100);
		if (
			[requestedPort, requestedBackend].some(
				(value) => !Number.isInteger(value) || value < 0 || value > 65535,
			) ||
			(configuredPort !== undefined &&
				configuredBackend !== undefined &&
				requestedPort !== 0 &&
				requestedPort === requestedBackend)
		)
			throw new Error(
				"DEV_PORT と DEV_BACKEND_PORT には 0〜65535 の整数を指定し、固定ポートは異なる番号にしてください。0 を指定すると空きポートを選びます。",
			);
		const port = await selectDevPort(configuredPort, requestedPort);
		const backend = await selectDevPort(
			configuredBackend,
			requestedBackend,
			port,
		);
		if (port === backend)
			throw new Error(
				"DEV_PORT と DEV_BACKEND_PORT は異なるポートにしてください。",
			);
		writeState();
		const origin = `http://md.localhost${port === 80 ? "" : `:${port}`}`;
		let proxy;
		startupTimer = setTimeout(() => {
			console.error(
				"開発サーバーの起動がタイムアウトしました。ポートとログを確認してください。",
			);
			stop(1);
		}, 15000);
		const app = launch(
			process.execPath,
			[
				"--watch",
				"--watch-preserve-output",
				"--watch-path=src",
				"--watch-path=public",
				"src/index.mjs",
				"--no-open",
				...viewerArgs,
			],
			{
				env: { ...process.env, PORT: String(backend), VIEWER_ORIGIN: origin },
			},
		);
		app.stdin.end();
		app.stderr.pipe(process.stderr);
		onOutputLine(app.stdout, (line) => {
			if (!line.startsWith("Markdown viewer:") || proxy || stopping) {
				if (line) console.log(line);
				return;
			}
			proxy = launch("caddy", [
				"run",
				"--config",
				"-",
				"--adapter",
				"caddyfile",
			]);
			proxy.stdin.on("error", () => {
				/* Spawn errors are reported by launch. */
			});
			proxy.stdin.end(
				`{\n admin off\n persist_config off\n auto_https off\n}\n${origin} {\n bind 127.0.0.1\n reverse_proxy 127.0.0.1:${backend}\n}\n`,
			);
			proxy.stdout.pipe(process.stdout);
			onOutputLine(proxy.stderr, (message) => {
				let entry;
				try {
					entry = JSON.parse(message);
				} catch {
					console.error(message);
					return;
				}
				if (entry.msg === "serving initial configuration") {
					clearTimeout(startupTimer);
					console.log(
						`Dev ready: ${origin}\nソース変更で再起動します。画面全体の再読み込み: ⌘⇧R / Ctrl+Shift+R。終了: Ctrl+C`,
					);
					if (openBrowser && !browserOpened && !stopping) {
						browserOpened = true;
						void openChromeApp(origin).catch((error) =>
							console.error(
								`Chrome の自動起動に失敗しました。${error.message}\nURL: ${origin}`,
							),
						);
					}
				} else if (entry.level === "error" || entry.level === "fatal")
					console.error(message);
			});
		});
	} catch (error) {
		console.error(error.message);
		stop(1);
	}
}
