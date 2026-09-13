import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2).filter((arg) => arg !== "--");
async function initialArgs() {
	if (args.some((arg) => arg !== "--recursive")) return args;
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
		(config.recursive !== undefined && typeof config.recursive !== "boolean")
	)
		throw new Error(
			"dev.local.json は paths (文字列配列) と任意の recursive (真偽値) を指定してください。",
		);
	return [
		...(config.recursive && !args.includes("--recursive")
			? ["--recursive"]
			: []),
		...args,
		...config.paths,
	];
}
if (args.includes("--help") || args.includes("-h")) {
	console.log(
		"Usage: pnpm dev [--recursive] [file.md | directory ...]\nDEV_PORT=8080 DEV_BACKEND_PORT=3100\nStarts Caddy and a watched reader on loopback without sudo. Ctrl+C stops both.",
	);
} else {
	const children = new Set();
	let stopping = false;
	let startupTimer;
	function stop(code) {
		if (stopping) return;
		stopping = true;
		clearTimeout(startupTimer);
		process.exitCode = code;
		for (const child of children) {
			// Stop the watch supervisor AND its Node child, not just the parent.
			try {
				if (process.platform === "win32") child.kill();
				else process.kill(-child.pid, "SIGTERM");
			} catch {
				/* Already exited. */
			}
		}
		const force = setTimeout(() => {
			for (const child of children) {
				try {
					if (process.platform === "win32") child.kill("SIGKILL");
					else process.kill(-child.pid, "SIGKILL");
				} catch {
					/* Already exited. */
				}
			}
		}, 3000);
		force.unref();
	}
	function launch(command, argv, options = {}) {
		const child = spawn(command, argv, {
			cwd: root,
			detached: process.platform !== "win32",
			stdio: ["pipe", "pipe", "pipe"],
			...options,
		});
		children.add(child);
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
			if (!stopping) {
				console.error(`${command} が終了しました (${code})。`);
				stop(code || 1);
			}
		});
		return child;
	}
	function lines(stream, callback) {
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
	try {
		const viewerArgs = await initialArgs();
		const port = Number(process.env.DEV_PORT ?? 8080);
		const backend = Number(process.env.DEV_BACKEND_PORT ?? 3100);
		if (
			[port, backend].some(
				(value) => !Number.isInteger(value) || value < 1 || value > 65535,
			) ||
			port === backend
		)
			throw new Error(
				"DEV_PORT と DEV_BACKEND_PORT は異なる 1〜65535 の整数にしてください。",
			);
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
				...viewerArgs,
			],
			{
				env: { ...process.env, PORT: String(backend), VIEWER_ORIGIN: origin },
			},
		);
		app.stdin.end();
		app.stderr.pipe(process.stderr);
		lines(app.stdout, (line) => {
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
			lines(proxy.stderr, (message) => {
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
						`Dev ready: ${origin}\nソース変更で再起動します。ブラウザーは再読み込みしてください。終了: Ctrl+C`,
					);
				} else if (entry.level === "error" || entry.level === "fatal")
					console.error(message);
			});
		});
	} catch (error) {
		console.error(error.message);
		stop(1);
	}
}
