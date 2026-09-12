import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import {
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
	createLibrary,
	MAX_FILE_BYTES,
	readBounded,
	within,
} from "../src/library.mjs";
import { renderMarkdown } from "../src/render.mjs";
import { createViewerServer } from "../src/server.mjs";

let root, folder, server, base, token;
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
	server = await createViewerServer();
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	base = `http://127.0.0.1:${server.address().port}`;
	const html = await (await fetch(base)).text();
	token = html.match(/name="viewer-token" content="([^"]+)"/)[1];
});
after(async () => {
	if (server) {
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	}
	if (root) await rm(root, { recursive: true, force: true });
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

test("absolute folder paths, recursive opt-in, extension case, and deduplication", async () => {
	const direct = await (await api("open", { path: folder })).json();
	assert.deepEqual(
		direct.documents.map((doc) => doc.name),
		["a.md"],
	);
	const recursive = await (
		await api("open", { path: `"${folder}"`, recursive: true })
	).json();
	assert.equal(recursive.documents.length, 2);
	assert.equal(direct.documents[0].id, recursive.documents[0].id);
	const doc = await (await api("read", { id: direct.documents[0].id })).json();
	assert.match(doc.html, /<h1>Hello<\/h1>/);
});
test("token, Origin, Fetch Metadata and Host protect local file APIs", async () => {
	for (const headers of [
		{ "X-Viewer-Token": "bad" },
		{ Origin: "https://evil.example" },
		{ "Sec-Fetch-Site": "cross-site" },
		{ "Sec-Fetch-Site": "same-site" },
	])
		assert.equal((await api("open", { path: root }, headers)).status, 403);
	const status = await new Promise((resolve, reject) => {
		const req = request(base, { headers: { Host: "evil.example" } }, (res) => {
			res.resume();
			resolve(res.statusCode);
		});
		req.on("error", reject);
		req.end();
	});
	assert.equal(status, 403);
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
		"/assets/../../package.json",
		"/files/secret.md",
		"/src/server.mjs",
		"/package.json",
		"/style.css/../README.md",
	])
		assert.equal((await fetch(base + route)).status, 404);
	const response = await fetch(base);
	assert.match(
		response.headers.get("content-security-policy"),
		/script-src 'self'/,
	);
	assert.equal(response.headers.get("cache-control"), "no-store");
});
test("relative Markdown links and images remain within the selected root", async () => {
	const { documents } = await (await api("open", { path: folder })).json();
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
		assert.equal((await api("related", { id, href })).status, 403);
	for (const href of [
		"file:///etc/passwd",
		"https://example.com/a.md",
		"%00.md",
		"%zz",
	])
		assert.equal((await api("related", { id, href })).status, 400);
	assert.equal((await api("image", { id, href: "a.md" })).status, 400);
});
test("changed files are read again; deletion and replaced symlinks fail safely", async () => {
	const file = join(folder, "changing.md");
	await writeFile(file, "before");
	const { documents } = await (await api("open", { path: file })).json();
	const id = documents[0].id;
	await writeFile(file, "after");
	assert.equal((await (await api("read", { id })).json()).source, "after");
	await unlink(file);
	assert.equal((await api("read", { id })).status, 404);
	await symlink(join(root, "secret.md"), file);
	assert.equal((await api("read", { id })).status, 403);
});
test("size, request and folder limits are explicit", async () => {
	const big = join(root, "big.md");
	await writeFile(big, "x".repeat(MAX_FILE_BYTES + 1));
	assert.equal((await api("open", { path: big })).status, 413);
	await assert.rejects(readBounded(big, root), /上限/);
	assert.equal(
		(await api("render", { source: "x".repeat(MAX_FILE_BYTES + 1) })).status,
		413,
	);
	assert.equal(
		(await api("render", { source: "x".repeat(2 * MAX_FILE_BYTES) })).status,
		413,
	);
	const many = join(root, "many");
	await mkdir(many);
	await Promise.all(
		Array.from({ length: 201 }, (_, index) =>
			writeFile(join(many, `${index}.md`), "hi"),
		),
	);
	await assert.rejects(createLibrary().openPath(many), /200/);
	await assert.rejects(createLibrary().openPath(join(root, "missing")));
	const empty = join(root, "empty");
	await mkdir(empty);
	await assert.rejects(
		createLibrary().openPath(empty),
		/Markdown がありません/,
	);
});
test("path containment distinguishes siblings and dot-prefixed names", () => {
	assert.equal(within("/docs", "/docs-escape/a"), false);
	assert.equal(within("/docs", "/docs/..notes/a"), true);
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
test("Markdown escapes active HTML, unsafe links and code info; images stay inert", () => {
	const html = renderMarkdown(
		'<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1))\n\n![remote](https://evil.example/track)\n\n```js" onmouseover="alert(1)\n<script>\n```',
	);
	assert.doesNotMatch(
		html,
		/<script|<img src|href="javascript:|<[^>]+\sonerror=/,
	);
	assert.match(html, /data-image="https:\/\/evil.example\/track"/);
	assert.match(html, /&lt;script&gt;/);
	assert.match(
		renderMarkdown("| a | b |\n| - | - |\n| c | d |\n\n~~gone~~"),
		/<table>/,
	);
});
