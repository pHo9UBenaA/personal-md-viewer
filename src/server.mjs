import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createLibrary, MAX_FILE_BYTES, ViewerError } from "./library.mjs";
import { renderMarkdown } from "./render.mjs";

const assets = new Map([
	["/", ["index.html", "text/html; charset=utf-8"]],
	["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
	["/theme.js", ["theme.js", "text/javascript; charset=utf-8"]],
	["/theme.css", ["theme.css", "text/css; charset=utf-8"]],
	["/style.css", ["style.css", "text/css; charset=utf-8"]],
	["/reader.css", ["reader.css", "text/css; charset=utf-8"]],
]);
const csp =
	"default-src 'none'; script-src 'self'; style-src 'self'; img-src blob:; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

async function readJson(request) {
	if (request.headers["content-type"] !== "application/json")
		throw new ViewerError("JSON が必要です。", 415);
	const parts = [];
	let bytes = 0;
	for await (const part of request) {
		bytes += part.length;
		if (bytes > 2 * MAX_FILE_BYTES)
			throw new ViewerError("リクエストが大きすぎます。", 413);
		parts.push(part);
	}
	try {
		const value = JSON.parse(Buffer.concat(parts).toString("utf8"));
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw new Error();
		return value;
	} catch {
		throw new ViewerError("JSON の形式が不正です。");
	}
}

export async function createViewerServer({
	initialPaths = [],
	recursive = false,
	publicOrigin,
	allowHtml = false,
} = {}) {
	let allowedOrigin;
	if (publicOrigin) {
		const url = new URL(publicOrigin);
		if (
			!["http:", "https:"].includes(url.protocol) ||
			url.username ||
			url.password ||
			url.pathname !== "/" ||
			url.search ||
			url.hash
		)
			throw new ViewerError(
				"VIEWER_ORIGIN はパスを含まない http(s) のオリジンにしてください。",
			);
		allowedOrigin = url.origin;
	}
	const library = createLibrary();
	const initial = [];
	for (const path of initialPaths) {
		for (const doc of await library.openPath(path, recursive))
			initial.push(doc);
	}
	const token = randomBytes(32).toString("hex");
	const staticFiles = new Map(
		await Promise.all(
			[...assets].map(async ([route, [file, type]]) => [
				route,
				{
					type,
					data: (
						await readFile(
							new URL(`../public/${file}`, import.meta.url),
							"utf8",
						)
					).replace("__TOKEN__", token),
				},
			]),
		),
	);

	const server = createServer(
		{ maxHeaderSize: 8192, requestTimeout: 10000, headersTimeout: 10000 },
		async (request, response) => {
			response.setHeader("Content-Security-Policy", csp);
			response.setHeader("X-Content-Type-Options", "nosniff");
			response.setHeader("Referrer-Policy", "no-referrer");
			response.setHeader("Cache-Control", "no-store");
			response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
			response.setHeader("X-Frame-Options", "DENY");
			response.setHeader(
				"Permissions-Policy",
				"camera=(), microphone=(), geolocation=()",
			);
			function send(status, data, type = "application/json; charset=utf-8") {
				response.writeHead(status, { "Content-Type": type });
				response.end(
					request.method === "HEAD"
						? undefined
						: type.startsWith("application/json")
							? JSON.stringify(data)
							: data,
				);
			}
			try {
				const port = server.address().port;
				const host = request.headers.host;
				const origin = allowedOrigin ?? `http://${host}`;
				if (
					allowedOrigin
						? host !== new URL(allowedOrigin).host
						: host !== `127.0.0.1:${port}` && host !== `localhost:${port}`
				)
					throw new ViewerError("Host が許可されていません。", 403);
				if (request.headers.origin && request.headers.origin !== origin)
					throw new ViewerError("別のサイトからは操作できません。", 403);
				if (
					request.headers["sec-fetch-site"] &&
					!["same-origin", "none"].includes(request.headers["sec-fetch-site"])
				)
					throw new ViewerError("別のサイトからはアクセスできません。", 403);
				const url = new URL(request.url, `http://${host}`);
				const asset = staticFiles.get(url.pathname);
				if (asset && (request.method === "GET" || request.method === "HEAD"))
					return send(200, asset.data, asset.type);
				if (!url.pathname.startsWith("/api/"))
					return send(404, { error: "見つかりません。" });
				const supplied = Buffer.from(request.headers["x-viewer-token"] ?? "");
				if (
					supplied.length !== token.length ||
					!timingSafeEqual(supplied, Buffer.from(token))
				)
					throw new ViewerError("ページを再読み込みしてください。", 403);
				if (request.method !== "POST") {
					response.setHeader("Allow", "POST");
					throw new ViewerError("POST が必要です。", 405);
				}
				const body = await readJson(request);
				switch (url.pathname) {
					case "/api/initial":
						return send(200, { documents: initial });
					case "/api/open":
						return send(200, {
							documents: await library.openPath(
								body.path,
								body.recursive === true,
							),
						});
					case "/api/restore":
						return send(200, {
							document: await library.restore(body.path, body.root),
						});
					case "/api/read": {
						const doc = await library.read(body.id);
						return send(200, {
							...doc,
							html: renderMarkdown(doc.source, { allowHtml }),
						});
					}
					case "/api/render": {
						if (typeof body.source !== "string")
							throw new ViewerError("Markdown が必要です。");
						if (Buffer.byteLength(body.source) > MAX_FILE_BYTES)
							throw new ViewerError("Markdown の上限は 1 MiB です。", 413);
						return send(200, {
							html: renderMarkdown(body.source, { allowHtml }),
						});
					}
					case "/api/related":
						return send(200, {
							documents: [await library.related(body.id, body.href)],
						});
					case "/api/image": {
						const image = await library.image(body.id, body.href);
						return send(200, image.data, image.type);
					}
					default:
						return send(404, { error: "見つかりません。" });
				}
			} catch (error) {
				const status =
					error instanceof ViewerError
						? error.status
						: ["ENOENT", "ENOTDIR"].includes(error.code)
							? 404
							: error.code === "EACCES"
								? 403
								: 500;
				const message =
					error instanceof ViewerError
						? error.message
						: status === 404
							? "パスが見つかりません。移動・削除されていないか確認してください。"
							: status === 403
								? "読み取り権限がありません。"
								: "読み取れませんでした。パスとファイルを確認してください。";
				send(status, { error: message });
			}
		},
	);
	server.maxConnections = 32;
	server.keepAliveTimeout = 5000;
	return server;
}
