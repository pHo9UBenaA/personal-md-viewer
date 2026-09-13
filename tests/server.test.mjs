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
import { MAX_FILE_BYTES, readBounded } from "../src/library.mjs";
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
test("restored paths keep their original folder scope", async () => {
	const { documents } = await (
		await api("open", { path: folder, recursive: true })
	).json();
	const nested = documents.find((doc) => doc.name === "b.MARKDOWN");
	const restored = await (
		await api("restore", { path: nested.path, root: folder })
	).json();
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
	for (const route of ["/files/secret.md", "/package.json"])
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
test("byte limits remain while folders can exceed previous document caps", async () => {
	const big = join(root, "big.md");
	await writeFile(big, "x".repeat(MAX_FILE_BYTES + 1));
	assert.equal((await api("open", { path: big })).status, 413);
	const { documents: oversized } = await (
		await api("open", { path: root })
	).json();
	const bigId = oversized.find((doc) => doc.name === "big.md").id;
	assert.equal((await api("read", { id: bigId })).status, 413);
	assert.equal(
		(await api("render", { source: "x".repeat(2 * MAX_FILE_BYTES) })).status,
		413,
	);
	const many = join(root, "many");
	await mkdir(many);
	await Promise.all(
		Array.from({ length: 1001 }, (_, index) =>
			writeFile(join(many, `${index}.md`), "hi"),
		),
	);
	const { documents } = await (await api("open", { path: many })).json();
	assert.equal(documents.length, 1001);
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
	const { documents } = await (
		await api("open", { path: join(selected, "index.md") })
	).json();
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
				(await (await api("read", { id: doc.id })).json()).source,
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
	// Use node:http to send the exact Host header a reverse proxy forwards.
	const fetch = (url, options = {}) =>
		new Promise((resolve, reject) => {
			const req = request(url, options, (res) => {
				const chunks = [];
				res.on("data", (chunk) => chunks.push(chunk));
				res.on("end", () =>
					resolve(
						new Response(Buffer.concat(chunks), { status: res.statusCode }),
					),
				);
				res.on("error", reject);
			});
			req.on("error", reject);
			req.end(options.body);
		});
	for (const invalid of [
		"file:///tmp",
		"http://user:pass@md.localhost",
		"http://md.localhost/path",
	]) {
		await assert.rejects(createViewerServer({ publicOrigin: invalid }));
	}
	const proxyServer = await createViewerServer({
		publicOrigin: "https://md.localhost",
	});
	proxyServer.listen(0, "127.0.0.1");
	await once(proxyServer, "listening");
	try {
		const url = `http://127.0.0.1:${proxyServer.address().port}`;
		const shell = await fetch(url, { headers: { Host: "md.localhost" } });
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
				await fetch(`${url}/api/open`, {
					method: "POST",
					headers,
					body: JSON.stringify({ path: folder }),
				})
			).status,
			200,
		);
		assert.equal((await fetch(url)).status, 403);
		assert.equal(
			(
				await fetch(url, {
					headers: { Host: "evil.example", "X-Forwarded-Host": "md.localhost" },
				})
			).status,
			403,
		);
		assert.equal(
			(
				await fetch(url, {
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
		proxyServer.closeAllConnections();
		await new Promise((resolve) => proxyServer.close(resolve));
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
test("Markdown escapes active HTML, unsafe links and code info; images stay inert", () => {
	const html = renderMarkdown(
		'<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1))\n\n![remote](https://evil.example/track)\n\n[safe](nested/b.md)\n\n```js" onmouseover="alert(1)\n<script>\n```',
	);
	assert.doesNotMatch(
		html,
		/<script|<img src|href="javascript:|<[^>]+\sonerror=/,
	);
	assert.match(html, /data-image="https:\/\/evil.example\/track"/);
	assert.match(html, /&lt;script&gt;/);
	assert.match(html, /data-link="nested\/b.md"/);
	assert.doesNotMatch(html, /<a\b[^>]*\shref=/);
});

test("Markdown hides HTML comments without hiding code examples or allowing raw HTML", () => {
	const html = renderMarkdown(
		"<!-- 作業用本文 -->\n\n表示する本文 <!-- 非表示 --> 続き\n\n<!-- 複数行\n\n非表示の段落\n-->\n\n`<!-- コード -->`\n\n```md\n<!-- フェンス内 -->\n```\n\n\\<!-- エスケープ -->\n\n<script>alert(1)</script>",
	);
	assert.match(html, /<p>表示する本文 {2}続き<\/p>/);
	assert.doesNotMatch(html, /作業用本文|非表示|非表示の段落/);
	assert.match(html, /<code>&lt;!-- コード --&gt;<\/code>/);
	assert.match(html, /&lt;!-- フェンス内 --&gt;/);
	assert.match(html, /&lt;!-- エスケープ --&gt;/);
	assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
	assert.doesNotMatch(html, /<script>/);
	assert.equal(
		renderMarkdown("<!-- 下書き\n\n非表示の段落\n--> 続き"),
		"<p>続き</p>\n",
	);
});

test("raw HTML requires opt-in and renders details while omitting comments", () => {
	const source =
		"<!-- 作業用本文 -->\n\n<details>\n<summary>詳細</summary>\n\n**本文**\n\n</details>";
	const safe = renderMarkdown(source);
	const trusted = renderMarkdown(source, { allowHtml: true });
	assert.match(safe, /&lt;details&gt;/);
	assert.doesNotMatch(safe, /作業用本文/);
	assert.match(trusted, /<details>/);
	assert.match(trusted, /<summary>詳細<\/summary>/);
	assert.match(trusted, /<strong>本文<\/strong>/);
	assert.doesNotMatch(trusted, /作業用本文/);
	assert.equal(
		renderMarkdown("<!-- 下書き\n\n非表示\n--> 続き", { allowHtml: true }),
		"<p>続き</p>\n",
	);
});

test("render limits count UTF-8 bytes and accept the exact boundary", async () => {
	const source = `${"あ".repeat(Math.floor(MAX_FILE_BYTES / 3))}x`;
	assert.equal(Buffer.byteLength(source), MAX_FILE_BYTES);
	const accepted = await api("render", { source });
	assert.equal(accepted.status, 200);
	assert.ok((await accepted.json()).html.includes(source));
	assert.equal((await api("render", { source: `${source}x` })).status, 413);
});

test("malformed JSON is rejected without breaking subsequent requests", async () => {
	for (const body of ["{", "null"]) {
		const response = await fetch(`${base}/api/render`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Viewer-Token": token },
			body,
		});
		assert.equal(response.status, 400);
	}
	assert.equal(
		(await api("render", { source: "ok" }, { "Content-Type": "text/plain" }))
			.status,
		415,
	);
	assert.equal((await api("render", { source: "ok" })).status, 200);
});
