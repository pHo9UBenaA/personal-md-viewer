import { createViewerServer } from "./server.mjs";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
if (args.includes("--help") || args.includes("-h")) {
	console.log(
		"Usage: pnpm start [--recursive] [file.md | directory ...]\n\nOpen the printed local URL. PORT defaults to 3000; PORT=0 selects a free port.",
	);
} else {
	try {
		const port = Number(process.env.PORT ?? 3000);
		if (!Number.isInteger(port) || port < 0 || port > 65535)
			throw new Error("PORT は 0〜65535 の整数にしてください。");
		const server = await createViewerServer({
			initialPaths: args.filter((arg) => arg !== "--recursive"),
			recursive: args.includes("--recursive"),
		});
		server.on("error", (error) => {
			console.error(
				error.code === "EADDRINUSE"
					? "ポートが使用中です。PORT=0 pnpm start で空きポートを使えます。"
					: error.message,
			);
			process.exitCode = 1;
		});
		server.listen(port, "127.0.0.1", () =>
			console.log(`Markdown viewer: http://127.0.0.1:${server.address().port}`),
		);
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
