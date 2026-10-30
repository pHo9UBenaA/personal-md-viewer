import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createLibrary, MAX_FILE_BYTES, ViewerError } from "./library.mjs";
import { renderMarkdown } from "./render.mjs";

const assets = new Map([
	["/", ["index.html", "text/html; charset=utf-8"]],
	[
		"/manifest.webmanifest",
		["manifest.webmanifest", "application/manifest+json; charset=utf-8"],
	],
	["/icons/viewer.svg", ["icons/viewer.svg", "image/svg+xml"]],
	["/icons/viewer-192.png", ["icons/viewer-192.png", "image/png"]],
	["/icons/viewer-512.png", ["icons/viewer-512.png", "image/png"]],
	["/app.js", ["scripts/app.js", "text/javascript; charset=utf-8"]],
	["/dom.js", ["scripts/dom.js", "text/javascript; charset=utf-8"]],
	["/reader.js", ["scripts/reader.js", "text/javascript; charset=utf-8"]],
	[
		"/highlight-toolbar.js",
		["scripts/highlight-toolbar.js", "text/javascript; charset=utf-8"],
	],
	["/notices.js", ["scripts/notices.js", "text/javascript; charset=utf-8"]],
	["/palette.js", ["scripts/palette.js", "text/javascript; charset=utf-8"]],
	["/tree.js", ["scripts/tree.js", "text/javascript; charset=utf-8"]],
	["/shortcuts.js", ["scripts/shortcuts.js", "text/javascript; charset=utf-8"]],
	["/tabs.js", ["scripts/tabs.js", "text/javascript; charset=utf-8"]],
	[
		"/reader-search.js",
		["scripts/reader-search.js", "text/javascript; charset=utf-8"],
	],
	["/shortcuts", ["shortcuts.html", "text/html; charset=utf-8"]],
	["/documents.js", ["scripts/documents.js", "text/javascript; charset=utf-8"]],
	["/selection.js", ["scripts/selection.js", "text/javascript; charset=utf-8"]],
	["/sidebar.js", ["scripts/sidebar.js", "text/javascript; charset=utf-8"]],
	["/theme.js", ["scripts/theme.js", "text/javascript; charset=utf-8"]],
	["/theme.css", ["styles/theme.css", "text/css; charset=utf-8"]],
	["/style.css", ["styles/style.css", "text/css; charset=utf-8"]],
	["/reader.css", ["styles/reader.css", "text/css; charset=utf-8"]],
	["/icons/sun.svg", ["icons/sun.svg", "image/svg+xml"]],
	["/icons/moon.svg", ["icons/moon.svg", "image/svg+xml"]],
	["/icons/folder.svg", ["icons/folder.svg", "image/svg+xml"]],
	["/icons/folder-open.svg", ["icons/folder-open.svg", "image/svg+xml"]],
	["/icons/markdown.svg", ["icons/markdown.svg", "image/svg+xml"]],
	["/icons/chevron-right.svg", ["icons/chevron-right.svg", "image/svg+xml"]],
	["/icons/sidebar.svg", ["icons/sidebar.svg", "image/svg+xml"]],
	["/icons/restore.svg", ["icons/restore.svg", "image/svg+xml"]],
	[
		"/fonts/BIZUDPGothic-Regular.woff2",
		["fonts/BIZUDPGothic-Regular.woff2", "font/woff2"],
	],
	[
		"/fonts/BIZUDPGothic-Bold.woff2",
		["fonts/BIZUDPGothic-Bold.woff2", "font/woff2"],
	],
	[
		"/fonts/BIZUDGothic-Regular.woff2",
		["fonts/BIZUDGothic-Regular.woff2", "font/woff2"],
	],
	[
		"/fonts/BIZUDGothic-Bold.woff2",
		["fonts/BIZUDGothic-Bold.woff2", "font/woff2"],
	],
	[
		"/fonts/BIZ-UD-OFL.txt",
		["fonts/BIZ-UD-OFL.txt", "text/plain; charset=utf-8"],
	],
]);
const contentSecurityPolicy =
	"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; font-src 'self'; manifest-src 'self'; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const withoutHighlights = (html) =>
	html
		.replace(/<mark data-mdv-color="(?:green|yellow|orange|pink|blue)">/g, "")
		.replace(/<\/mark>/g, "");

async function readJson(request) {
	if (request.headers["content-type"] !== "application/json")
		throw new ViewerError("JSON が必要です。", 415);
	const chunks = [];
	let receivedBytes = 0;
	// Highlight requests contain selected text as well as offsets and metadata.
	const maxRequestBytes = 2 * MAX_FILE_BYTES;
	for await (const chunk of request) {
		receivedBytes += chunk.length;
		if (receivedBytes > maxRequestBytes)
			throw new ViewerError("リクエストが大きすぎます。", 413);
		chunks.push(chunk);
	}
	try {
		const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw new Error();
		return value;
	} catch {
		throw new ViewerError("JSON の形式が不正です。");
	}
}

function viewerErrorResponse(error) {
	if (error instanceof ViewerError)
		return { status: error.status, message: error.message };
	if (["ENOENT", "ENOTDIR"].includes(error.code))
		return {
			status: 404,
			message:
				"パスが見つかりません。移動・削除されていないか確認してください。",
		};
	if (error.code === "EACCES")
		return { status: 403, message: "読み取り権限がありません。" };
	return {
		status: 500,
		message: "読み取れませんでした。パスとファイルを確認してください。",
	};
}

function validateRequestOrigin(request, allowedOrigin, port) {
	const host = request.headers.host;
	const origin = allowedOrigin ?? `http://${host}`;
	const isAllowedHost = allowedOrigin
		? host === new URL(allowedOrigin).host
		: host === `127.0.0.1:${port}` || host === `localhost:${port}`;
	if (!isAllowedHost) throw new ViewerError("Host が許可されていません。", 403);
	if (request.headers.origin && request.headers.origin !== origin)
		throw new ViewerError("別のサイトからは操作できません。", 403);
	const fetchSite = request.headers["sec-fetch-site"];
	if (fetchSite && !["same-origin", "none"].includes(fetchSite))
		throw new ViewerError("別のサイトからはアクセスできません。", 403);
}

export async function createViewerServer({
	initialPaths = [],
	recursive = false,
	publicOrigin,
	allowHtml = false,
	hideNotices = false,
	contentDirectory,
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
	const library = await createLibrary({ directory: contentDirectory });
	const initial = initialPaths.length
		? []
		: await library.openCopiedDirectory();
	for (const path of initialPaths) {
		for (const doc of await library.openPath(path, recursive))
			initial.push(doc);
	}
	const token = randomBytes(32).toString("hex");
	const expectedTokenBytes = Buffer.from(token);
	const staticFiles = new Map(
		await Promise.all(
			[...assets].map(async ([route, [file, type]]) => {
				const bytes = await readFile(
					new URL(`../public/${file}`, import.meta.url),
				);
				const data =
					file === "index.html"
						? bytes
								.toString("utf8")
								.replace("__TOKEN__", token)
								.replace("__SHOW_NOTICES__", String(!hideNotices))
						: bytes;
				return [route, { type, data }];
			}),
		),
	);

	const server = createServer(
		{ maxHeaderSize: 8192, requestTimeout: 10000, headersTimeout: 10000 },
		async (request, response) => {
			response.setHeader("Content-Security-Policy", contentSecurityPolicy);
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
				if (request.method === "HEAD") {
					response.end();
					return;
				}
				const body = type.startsWith("application/json")
					? JSON.stringify(data)
					: data;
				response.end(body);
			}
			try {
				validateRequestOrigin(request, allowedOrigin, server.address().port);
				const url = new URL(request.url, `http://${request.headers.host}`);
				const asset = staticFiles.get(url.pathname);
				if (asset && (request.method === "GET" || request.method === "HEAD"))
					return send(200, asset.data, asset.type);
				if (!url.pathname.startsWith("/api/"))
					return send(404, { error: "見つかりません。" });
				const suppliedTokenBytes = Buffer.from(
					request.headers["x-viewer-token"] ?? "",
				);
				if (
					suppliedTokenBytes.length !== expectedTokenBytes.length ||
					!timingSafeEqual(suppliedTokenBytes, expectedTokenBytes)
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
					case "/api/highlight": {
						const doc = await library.highlight(
							body.id,
							body,
							(before, after) =>
								withoutHighlights(renderMarkdown(before, { allowHtml })) ===
								withoutHighlights(renderMarkdown(after, { allowHtml })),
						);
						return send(200, {
							...doc,
							html: renderMarkdown(doc.source, { allowHtml }),
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
				const { status, message } = viewerErrorResponse(error);
				send(status, { error: message });
			}
		},
	);
	server.maxConnections = 32;
	server.keepAliveTimeout = 5000;
	return server;
}
