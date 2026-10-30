import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { MAX_FILE_BYTES, readBounded } from "../src/library.mjs";
import { createViewerServer } from "../src/server.mjs";
import {
	closeServer,
	listenOnLoopback,
	requestWithExactHost,
} from "./helpers/http.mjs";

let root;
let folder;
let server;
let base;
let token;
before(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "markdown-viewer-test-")));
	folder = join(root, "日本語 space # %");
	await mkdir(join(folder, "nested"), { recursive: true });
	await writeFile(
		join(folder, "a.md"),
		"# Hello\n\n[Next](nested/b.MARKDOWN)\n\n![local](pixel.png)",
	);
	await writeFile(join(folder, "nested/b.MARKDOWN"), "# Next");
	await writeFile(join(folder, "pixel.png"), Buffer.from([137, 80, 78, 71]));
	await writeFile(join(root, "secret.md"), "secret");
	await symlink(join(root, "secret.md"), join(folder, "escape.md"));
	server = await createViewerServer({ contentDirectory: root });
	base = await listenOnLoopback(server);
	const html = await (await fetch(base)).text();
	token = html.match(/name="viewer-token" content="([^"]+)"/)[1];
});
after(async () => {
	if (server) await closeServer(server);
	if (root) await rm(root, { recursive: true, force: true });
});
test("notice visibility is encoded as a boolean without changing CSP or API access", async () => {
	for (const hideNotices of [false, true]) {
		const viewer = await createViewerServer({
			contentDirectory: root,
			hideNotices,
		});
		try {
			const url = await listenOnLoopback(viewer);
			const response = await fetch(url);
			const html = await response.text();
			assert.ok(html.includes(`data-show-notices="${!hideNotices}"`));
			assert.ok(!html.includes("__SHOW_NOTICES__"));
			assert.equal(
				response.headers.get("content-security-policy"),
				(await fetch(base)).headers.get("content-security-policy"),
			);
			assert.equal(
				(await fetch(`${url}/api/initial`, { method: "POST" })).status,
				403,
			);
		} finally {
			await closeServer(viewer);
		}
	}
});

const api = (route, body = {}, headers = {}) =>
	fetch(`${base}/api/${route}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Viewer-Token": token,
			...headers,
		},
		body: JSON.stringify(body),
	});

async function apiJson(route, body = {}) {
	const response = await api(route, body);
	assert.equal(response.status, 200, `${route}: ${JSON.stringify(body)}`);
	return response.json();
}

async function createHighlightDocument(
	name,
	source = "Before **important words** after.",
) {
	const path = join(folder, name);
	await writeFile(path, source);
	const openedResponse = await api("open", { path });
	assert.equal(openedResponse.status, 200, `open ${name}`);
	const { documents } = await openedResponse.json();
	const readResponse = await api("read", { id: documents[0].id });
	assert.equal(readResponse.status, 200, `read ${name}`);
	return { path, document: await readResponse.json() };
}

const importantWords = "important words";
function highlightRequest(document, overrides = {}) {
	const start = document.source.indexOf(importantWords);
	return {
		id: document.id,
		mode: "add",
		color: "yellow",
		version: document.version,
		ranges: [
			{ start, end: start + importantWords.length, text: importantWords },
		],
		...overrides,
	};
}

function sourceMarker(source, color) {
	const start = source.indexOf(`<mark data-mdv-color="${color}">`);
	assert.notEqual(start, -1, `missing ${color} marker in ${source}`);
	const closeStart = source.indexOf("</mark>", start);
	assert.notEqual(closeStart, -1, `missing closing marker in ${source}`);
	return { start, end: closeStart + "</mark>".length, color };
}

test("absolute folder paths, recursive opt-in, extension case, and deduplication", async () => {
	const direct = await apiJson("open", { path: folder });
	assert.deepEqual(
		direct.documents.map((doc) => doc.name),
		["a.md"],
	);
	const recursive = await apiJson("open", {
		path: `"${folder}"`,
		recursive: true,
	});
	assert.equal(recursive.documents.length, 2);
	assert.equal(direct.documents[0].id, recursive.documents[0].id);
	const doc = await apiJson("read", { id: direct.documents[0].id });
	assert.match(doc.html, /<h1>Hello<\/h1>/);
	assert.equal(doc.relativePath, "日本語 space # %/a.md");
});
test("restored paths keep their original folder scope", async () => {
	const { documents } = await apiJson("open", {
		path: folder,
		recursive: true,
	});
	const nested = documents.find((doc) => doc.name === "b.MARKDOWN");
	const restored = await apiJson("restore", {
		path: nested.path,
		root: folder,
	});
	assert.equal(restored.document.id, nested.id);
	assert.equal(restored.document.root, folder);
	assert.equal(
		(await api("restore", { path: join(root, "secret.md"), root: folder }))
			.status,
		403,
	);
});
test("token, Origin, Fetch Metadata and Host protect local file APIs", async () => {
	for (const headers of [
		{ "X-Viewer-Token": "bad" },
		{ "X-Viewer-Token": `${token[0] === "0" ? "1" : "0"}${token.slice(1)}` },
		{ Origin: "https://evil.example" },
		{ "Sec-Fetch-Site": "cross-site" },
		{ "Sec-Fetch-Site": "same-site" },
	])
		assert.equal(
			(await api("open", { path: root }, headers)).status,
			403,
			JSON.stringify(headers),
		);
	const untrustedHostResponse = await requestWithExactHost(base, {
		headers: { Host: "evil.example" },
	});
	assert.equal(untrustedHostResponse.status, 403);
	assert.equal(
		(
			await fetch(`${base}/api/initial`, {
				headers: { "X-Viewer-Token": token },
			})
		).status,
		405,
	);
});
test("asset routes never expose arbitrary local files", async () => {
	for (const route of [
		"/files/secret.md",
		"/package.json",
		"/docs/usage.md",
		"/public/shortcuts.html",
	])
		assert.equal((await fetch(base + route)).status, 404, route);
	const response = await fetch(base);
	assert.match(
		response.headers.get("content-security-policy"),
		/script-src 'self'/,
	);
	assert.equal(response.headers.get("cache-control"), "no-store");
});
test("browser modules are served only at their registered asset routes", async () => {
	for (const file of [
		"documents.js",
		"selection.js",
		"sidebar.js",
		"tabs.js",
		"reader-search.js",
	]) {
		const response = await fetch(`${base}/${file}`);
		assert.equal(response.status, 200, file);
		assert.equal(
			response.headers.get("content-type"),
			"text/javascript; charset=utf-8",
			file,
		);
		assert.equal((await fetch(`${base}/public/${file}`)).status, 404, file);
	}
});
test("shortcut help is served without API tokens or the Viewer event handlers", async () => {
	const response = await fetch(`${base}/shortcuts`);
	assert.equal(response.status, 200);
	assert.equal(
		response.headers.get("content-type"),
		"text/html; charset=utf-8",
	);
	const html = await response.text();
	assert.match(html, /Viewer のショートカット/);
	assert.doesNotMatch(html, /viewer-token|app\.js|<script[^>]*>[^<]+/);
});

test("only the fixed UI icons are served as SVG", async () => {
	for (const icon of [
		"sun",
		"moon",
		"folder",
		"folder-open",
		"markdown",
		"chevron-right",
		"sidebar",
		"restore",
	]) {
		const response = await fetch(`${base}/icons/${icon}.svg`);
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("content-type"), "image/svg+xml");
		const svg = await response.text();
		assert.match(svg, /^<svg /);
		assert.doesNotMatch(svg, /script|href=|onload=/i);
	}
	for (const route of ["/icons/arbitrary.svg", "/public/icons/sun.svg"])
		assert.equal((await fetch(base + route)).status, 404);
});

test("the install manifest and fixed app icons are local, token-free and uncached", async () => {
	const response = await fetch(`${base}/manifest.webmanifest`);
	assert.equal(response.status, 200);
	assert.match(
		response.headers.get("content-type"),
		/application\/manifest\+json/,
	);
	assert.equal(response.headers.get("cache-control"), "no-store");
	assert.match(
		response.headers.get("content-security-policy"),
		/manifest-src 'self'/,
	);
	const text = await response.text();
	assert.ok(!text.includes(token));
	const manifest = JSON.parse(text);
	assert.equal(manifest.id, "/markdown-viewer");
	assert.equal(manifest.name, "Markdown Viewer");
	assert.equal(manifest.display, "standalone");
	assert.equal(manifest.start_url, "/");
	assert.equal(manifest.scope, "/");
	for (const size of [192, 512]) {
		const icon = await fetch(`${base}/icons/viewer-${size}.png`);
		assert.equal(icon.headers.get("content-type"), "image/png");
		const bytes = Buffer.from(await icon.arrayBuffer());
		assert.deepEqual(
			bytes.subarray(0, 8),
			Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		);
		assert.equal(bytes.readUInt32BE(16), size);
		assert.equal(bytes.readUInt32BE(20), size);
	}
	assert.equal(
		(await fetch(`${base}/icons/viewer.svg`)).headers.get("content-type"),
		"image/svg+xml",
	);
	assert.equal((await fetch(`${base}/icons/arbitrary.png`)).status, 404);
	assert.equal((await fetch(`${base}/manifest.json`)).status, 404);
});

test("bundled fonts retain their binary bytes and include licenses", async () => {
	for (const name of ["IBMPlexSans-Regular.ttf", "Lilex-Regular.ttf"]) {
		const response = await fetch(`${base}/fonts/${name}`);
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("content-type"), "font/ttf");
		assert.deepEqual(
			Buffer.from(await response.arrayBuffer()),
			await readFile(new URL(`../public/fonts/${name}`, import.meta.url)),
		);
	}
	for (const name of ["IBM-Plex-OFL.txt", "Lilex-OFL.txt"])
		assert.match(
			await (await fetch(`${base}/fonts/${name}`)).text(),
			/SIL OPEN FONT LICENSE Version 1.1/,
		);
	assert.equal((await fetch(`${base}/fonts/arbitrary.ttf`)).status, 404);
});

test("relative Markdown links and images remain within the selected root", async () => {
	const { documents } = await apiJson("open", { path: folder });
	const id = documents[0].id;
	assert.equal(
		(await api("related", { id, href: "nested/b.MARKDOWN#next" })).status,
		200,
	);
	assert.equal(
		(await api("image", { id, href: "pixel.png" })).headers.get("content-type"),
		"image/png",
	);
	for (const href of ["../secret.md", "%2e%2e/secret.md", "escape.md"])
		assert.equal((await api("related", { id, href })).status, 403, href);
	for (const href of [
		"file:///etc/passwd",
		"https://example.com/a.md",
		"%00.md",
		"%zz",
	])
		assert.equal((await api("related", { id, href })).status, 400, href);
	assert.equal((await api("image", { id, href: "a.md" })).status, 400);
});
test("changed files are read again; deletion and replaced symlinks fail safely", async () => {
	const file = join(folder, "changing.md");
	await writeFile(file, "before");
	const { documents } = await apiJson("open", { path: file });
	const id = documents[0].id;
	await writeFile(file, "after");
	assert.equal((await apiJson("read", { id })).source, "after");
	await unlink(file);
	assert.equal((await api("read", { id })).status, 404);
	await symlink(join(root, "secret.md"), file);
	assert.equal((await api("read", { id })).status, 403);
});
test("highlights add, recolor, and remove markers while preserving the original Markdown", async () => {
	const { path: file, document: original } =
		await createHighlightDocument("highlights.md");
	const response = await api("highlight", highlightRequest(original));
	assert.equal(response.status, 200);
	const updated = await response.json();
	assert.match(
		updated.html,
		/<strong><mark data-mdv-color="yellow">important words<\/mark><\/strong>/,
	);
	assert.equal(
		await readFile(file, "utf8"),
		'Before **<mark data-mdv-color="yellow">important words</mark>** after.',
	);
	const markedSource = await readFile(file, "utf8");
	const recoloredResponse = await api("highlight", {
		id: original.id,
		mode: "recolor",
		color: "blue",
		version: updated.version,
		marker: sourceMarker(markedSource, "yellow"),
	});
	assert.equal(recoloredResponse.status, 200);
	const recolored = await recoloredResponse.json();
	assert.match(recolored.html, /data-mdv-color="blue"/);
	const blueSource = await readFile(file, "utf8");
	const removedResponse = await api("highlight", {
		id: original.id,
		mode: "remove",
		version: recolored.version,
		marker: sourceMarker(blueSource, "blue"),
	});
	assert.equal(removedResponse.status, 200);
	assert.equal(
		await readFile(file, "utf8"),
		"Before **important words** after.",
	);
});

test("highlights reject stale versions without overwriting disk changes", async () => {
	const { path, document } =
		await createHighlightDocument("stale-highlight.md");
	await writeFile(path, "Changed on disk.");
	const response = await api("highlight", highlightRequest(document));
	assert.equal(response.status, 409);
	assert.equal(await readFile(path, "utf8"), "Changed on disk.");
});

test("highlights reject unknown colors without modifying the source", async () => {
	const { path, document } = await createHighlightDocument("invalid-color.md");
	const response = await api(
		"highlight",
		highlightRequest(document, { color: "purple" }),
	);
	assert.equal(response.status, 400);
	assert.equal(await readFile(path, "utf8"), document.source);
});

test("highlights reject invalid, overlapping, or mismatched source ranges", async (t) => {
	const { path, document } = await createHighlightDocument(
		"invalid-ranges.md",
		"abcdef",
	);
	const cases = [
		{ name: "negative start", ranges: [{ start: -1, end: 1, text: "a" }] },
		{ name: "empty range", ranges: [{ start: 1, end: 1, text: "" }] },
		{ name: "past source end", ranges: [{ start: 5, end: 7, text: "f" }] },
		{ name: "fractional offset", ranges: [{ start: 0.5, end: 1, text: "a" }] },
		{ name: "mismatched text", ranges: [{ start: 0, end: 1, text: "b" }] },
		{
			name: "overlapping ranges",
			ranges: [
				{ start: 0, end: 2, text: "ab" },
				{ start: 1, end: 3, text: "bc" },
			],
		},
		{ name: "missing range", ranges: [null] },
	];
	for (const { name, ranges } of cases) {
		await t.test(name, async () => {
			const response = await api(
				"highlight",
				highlightRequest(document, { ranges }),
			);
			assert.equal(response.status, 409);
			assert.equal(await readFile(path, "utf8"), document.source);
		});
	}
});

test("highlights cannot rewrite Markdown structure through a mistaken text offset", async () => {
	const file = join(folder, "highlight-structure.md");
	const source = "[label](repeated)repeated";
	await writeFile(file, source);
	const { documents } = await apiJson("open", { path: file });
	const original = await apiJson("read", { id: documents[0].id });
	const wrongStart = source.indexOf("repeated");
	const response = await api("highlight", {
		id: documents[0].id,
		mode: "add",
		color: "orange",
		version: original.version,
		ranges: [
			{
				start: wrongStart,
				end: wrongStart + "repeated".length,
				text: "repeated",
			},
		],
	});
	assert.equal(response.status, 409);
	assert.equal(await readFile(file, "utf8"), source);
});
test("open and read enforce Markdown byte limits", async () => {
	const oversizedFile = join(root, "big.md");
	await writeFile(oversizedFile, "x".repeat(MAX_FILE_BYTES + 1));
	assert.equal((await api("open", { path: oversizedFile })).status, 413);
	const { documents: oversized } = await apiJson("open", { path: root });
	const bigId = oversized.find((doc) => doc.name === "big.md").id;
	assert.equal((await api("read", { id: bigId })).status, 413);
});

test("open registers folders with more than one thousand documents", async () => {
	const many = join(root, "many");
	await mkdir(many);
	await Promise.all(
		Array.from({ length: 1001 }, (_, index) =>
			writeFile(join(many, `${index}.md`), "hi"),
		),
	);
	const { documents } = await apiJson("open", { path: many });
	assert.equal(documents.length, 1001);
});

test("open rejects folders without Markdown", async () => {
	const empty = join(root, "empty");
	await mkdir(empty);
	assert.equal((await api("open", { path: empty })).status, 400);
});
test("encoded local links preserve contents and cannot escape into a sibling", async () => {
	const selected = join(root, "links");
	const sibling = `${selected}-outside`;
	await mkdir(selected);
	await mkdir(sibling);
	await writeFile(join(selected, "index.md"), "index");
	await writeFile(join(sibling, "secret.md"), "secret");
	const { documents } = await apiJson("open", {
		path: join(selected, "index.md"),
	});
	const id = documents[0].id;
	// Bounded generated cases: encoding and harmless path rewrites preserve identity.
	for (const [index, name] of [
		"space name",
		"日本語",
		"hash#query?",
		"percent%2e",
		"..notes",
	].entries()) {
		const file = `${name}.md`;
		const source = `unique content ${index}`;
		await writeFile(join(selected, file), source);
		let canonicalId;
		for (const href of [
			encodeURIComponent(file),
			`./${encodeURIComponent(file)}#heading`,
		]) {
			const response = await api("related", { id, href });
			assert.equal(response.status, 200, href);
			const {
				documents: [doc],
			} = await response.json();
			canonicalId ??= doc.id;
			assert.equal(doc.id, canonicalId, href);
			assert.equal(
				(await apiJson("read", { id: doc.id })).source,
				source,
				href,
			);
		}
	}
	for (const href of [
		"../links-outside/secret.md",
		"%2e%2e/links-outside/secret.md",
	]) {
		assert.equal((await api("related", { id, href })).status, 403, href);
	}
});
test("configured origin supports proxies without trusting forwarded headers", async () => {
	for (const invalid of [
		"file:///tmp",
		"http://user:pass@md.localhost",
		"http://md.localhost/path",
	]) {
		await assert.rejects(createViewerServer({ publicOrigin: invalid }));
	}
	const proxyServer = await createViewerServer({
		contentDirectory: root,
		publicOrigin: "https://md.localhost",
	});
	const url = await listenOnLoopback(proxyServer);
	try {
		const shell = await requestWithExactHost(url, {
			headers: { Host: "md.localhost" },
		});
		assert.equal(shell.status, 200);
		const csrf = (await shell.text()).match(
			/name="viewer-token" content="([^"]+)"/,
		)[1];
		const headers = {
			Host: "md.localhost",
			Origin: "https://md.localhost",
			"X-Viewer-Token": csrf,
			"Content-Type": "application/json",
		};
		assert.equal(
			(
				await requestWithExactHost(`${url}/api/open`, {
					method: "POST",
					headers,
					body: JSON.stringify({ path: folder }),
				})
			).status,
			200,
		);
		assert.equal((await requestWithExactHost(url)).status, 403);
		assert.equal(
			(
				await requestWithExactHost(url, {
					headers: { Host: "evil.example", "X-Forwarded-Host": "md.localhost" },
				})
			).status,
			403,
		);
		assert.equal(
			(
				await requestWithExactHost(url, {
					headers: {
						Host: "md.localhost",
						Origin: "http://md.localhost",
						"X-Forwarded-Proto": "https",
					},
				})
			).status,
			403,
		);
	} finally {
		await closeServer(proxyServer);
	}
});
test(
	"special files cannot block the reader",
	{ skip: process.platform === "win32", timeout: 2000 },
	async () => {
		const pipe = join(root, "pipe.md");
		execFileSync("mkfifo", [pipe]);
		await assert.rejects(readBounded(pipe, root), /通常のファイル/);
	},
);
test("read limits count UTF-8 bytes and accept the exact boundary", async () => {
	const source = `${"あ".repeat(Math.floor(MAX_FILE_BYTES / 3))}x`;
	assert.equal(Buffer.byteLength(source), MAX_FILE_BYTES);
	const path = join(root, "boundary.md");
	await writeFile(path, source);
	const { documents } = await apiJson("open", { path });
	const accepted = await apiJson("read", { id: documents[0].id });
	assert.equal(accepted.html, `<p>${source}</p>\n`);
	await writeFile(path, `${source}x`);
	assert.equal((await api("read", { id: documents[0].id })).status, 413);
});

test("malformed JSON is rejected without breaking subsequent requests", async () => {
	for (const body of ["{", "null", "[]", "true"]) {
		const response = await fetch(`${base}/api/initial`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Viewer-Token": token },
			body,
		});
		assert.equal(response.status, 400, body);
	}
	assert.equal(
		(await api("initial", {}, { "Content-Type": "text/plain" })).status,
		415,
	);
	assert.equal((await api("initial")).status, 200);
});
