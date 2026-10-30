import { openChromeApp } from "./chrome.mjs";
import { createViewerServer } from "./server.mjs";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
if (args.includes("--help") || args.includes("-h")) {
	console.log(
		"Usage: pnpm start [--no-open] [--no-notices] [--recursive] [--allow-html] [content/file.md | content/directory ...]\n\nOnly content/ is accessible. Run pnpm copy-docs SOURCE_DIRECTORY first. Without paths, all copied Markdown is listed recursively.\n--allow-html renders raw HTML in trusted Markdown. PORT defaults to 3000; PORT=0 selects a free port.\nOn macOS, opens the installed Markdown Viewer web app for this URL; otherwise uses Chrome app mode. Install once from Chrome to get a separate Dock / Cmd+Tab entry. --no-open disables browser launch. --no-notices hides the shortcut and copied-document notices, not errors or operation results. CHROME_PATH selects a Chrome executable and bypasses app discovery. VIEWER_APP_PATH explicitly selects a matching macOS .app.",
	);
} else {
	try {
		const port = Number(process.env.PORT ?? 3000);
		if (!Number.isInteger(port) || port < 0 || port > 65535)
			throw new Error("PORT は 0〜65535 の整数にしてください。");
		const server = await createViewerServer({
			initialPaths: args.filter(
				(arg) =>
					![
						"--recursive",
						"--allow-html",
						"--no-open",
						"--no-notices",
					].includes(arg),
			),
			recursive: args.includes("--recursive"),
			allowHtml: args.includes("--allow-html"),
			hideNotices: args.includes("--no-notices"),
			publicOrigin: process.env.VIEWER_ORIGIN,
		});
		server.on("error", (error) => {
			console.error(
				error.code === "EADDRINUSE"
					? "ポートが使用中です。PORT=0 pnpm start で空きポートを使えます。"
					: error.message,
			);
			process.exitCode = 1;
		});
		server.listen(port, "127.0.0.1", () => {
			const url =
				process.env.VIEWER_ORIGIN ||
				`http://127.0.0.1:${server.address().port}`;
			console.log(`Markdown viewer: ${url}`);
			if (!args.includes("--no-open"))
				void openChromeApp(url).catch((error) =>
					console.error(
						`Chrome の自動起動に失敗しました。${error.message}\nURL: ${url}`,
					),
				);
		});
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
