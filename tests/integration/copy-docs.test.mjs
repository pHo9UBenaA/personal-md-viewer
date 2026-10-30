import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	link,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { copyDocuments } from "../../scripts/copy-docs.mjs";
import { MAX_DIRECTORY_DEPTH, MAX_FILE_BYTES } from "../../src/library.mjs";
import { createViewerServer } from "../../src/server.mjs";
import { closeServer, listenOnLoopback } from "../helpers/http.mjs";

async function createCopyFixture(t) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "viewer-copy-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const source = join(root, "日本語 notes");
	const destinationDirectory = join(root, "content");
	await mkdir(source);
	await mkdir(destinationDirectory);
	await writeFile(join(source, "index.md"), "# Note\n\nimportant words");
	return { root, source, destinationDirectory };
}

async function startCopiedViewer(t, directory) {
	const server = await createViewerServer({ contentDirectory: directory });
	const url = await listenOnLoopback(server);
	t.after(() => closeServer(server));
	const shell = await (await fetch(url)).text();
	const token = shell.match(/name="viewer-token" content="([^"]+)"/)[1];
	return (route, body = {}) =>
		fetch(`${url}/api/${route}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Viewer-Token": token },
			body: JSON.stringify(body),
		});
}

async function createCopiedViewerFixture(t) {
	const fixture = await createCopyFixture(t);
	const { destination } = await copyDocuments(fixture.source, {
		destinationDirectory: fixture.destinationDirectory,
	});
	const api = await startCopiedViewer(t, fixture.destinationDirectory);
	const initial = await (await api("initial")).json();
	assert.equal(initial.documents.length, 1);
	return { ...fixture, destination, api, id: initial.documents[0].id };
}

test("copyDocuments preserves Markdown/image bytes and hierarchy, not links or unrelated files", async (t) => {
	const { root, source, destinationDirectory } = await createCopyFixture(t);
	await mkdir(join(source, "nested"));
	await writeFile(join(source, "nested", "UPPER.MARKDOWN"), "# Next\r\n");
	const image = Buffer.from([0, 1, 2, 255]);
	await writeFile(join(source, "nested", "photo.PNG"), image);
	await writeFile(join(source, "secret.txt"), "not copied");
	await writeFile(join(source, "drawing.svg"), "<svg/>");
	await mkdir(join(source, ".git"));
	await writeFile(join(source, ".git", "hidden.md"), "hidden");
	await mkdir(join(source, "node_modules"));
	await writeFile(join(source, "node_modules", "hidden.md"), "hidden");
	await symlink(join(source, "index.md"), join(source, "file-link.md"));
	await symlink(root, join(source, "directory-link"));
	// Hard links must become independent files too.
	await link(join(source, "index.md"), join(source, "hardlink.md"));
	if (process.platform !== "win32")
		execFileSync("mkfifo", [join(source, "pipe.md")]);

	const result = await copyDocuments(source, { destinationDirectory });
	assert.equal(result.markdownCount, 3);
	assert.equal(result.imageCount, 1);
	assert.equal(result.skippedLinks, 2);
	assert.deepEqual((await readdir(result.destination)).sort(), [
		"hardlink.md",
		"index.md",
		"nested",
	]);
	assert.equal(
		await readFile(
			join(result.destination, "nested", "UPPER.MARKDOWN"),
			"utf8",
		),
		"# Next\r\n",
	);
	assert.deepEqual(
		await readFile(join(result.destination, "nested", "photo.PNG")),
		image,
	);
	assert.equal(
		(await lstat(join(result.destination, "index.md"))).isSymbolicLink(),
		false,
	);
	await writeFile(join(result.destination, "hardlink.md"), "changed copy");
	assert.match(
		await readFile(join(source, "index.md"), "utf8"),
		/important words/,
	);
});

test("copyDocuments never overwrites existing collections, including symlink destinations", async (t) => {
	const { source, destinationDirectory } = await createCopyFixture(t);
	const { destination } = await copyDocuments(source, {
		destinationDirectory,
		name: "notes",
	});
	await writeFile(join(destination, "index.md"), "saved highlights");
	await assert.rejects(
		copyDocuments(source, { destinationDirectory, name: "notes" }),
		{ code: "EEXIST" },
	);
	assert.equal(
		await readFile(join(destination, "index.md"), "utf8"),
		"saved highlights",
	);
	await symlink(source, join(destinationDirectory, "linked"));
	await assert.rejects(
		copyDocuments(source, { destinationDirectory, name: "linked" }),
		{ code: "EEXIST" },
	);
});

test("copyDocuments rejects invalid names and overlapping source/destination trees", async (t) => {
	const { root, source, destinationDirectory } = await createCopyFixture(t);
	for (const name of [
		"",
		".",
		"..",
		"../escape",
		"/absolute",
		"a/b",
		"a\\b",
		".hidden",
		"a\0b",
		" notes",
		"notes ",
		"node_modules",
	])
		await assert.rejects(
			copyDocuments(source, { destinationDirectory, name }),
			/フォルダー名/,
			name,
		);
	await assert.rejects(
		copyDocuments(root, { destinationDirectory }),
		/コピー元に指定できません/,
	);
	await assert.rejects(
		copyDocuments(destinationDirectory, { destinationDirectory }),
		/コピー元に指定できません/,
	);
	await assert.rejects(
		copyDocuments(join(source, "index.md"), { destinationDirectory }),
		/コピー元のフォルダー/,
	);
	assert.deepEqual(await readdir(destinationDirectory), []);
});

test("failed copies remove partial output and never modify the source", async (t) => {
	const { source, destinationDirectory } = await createCopyFixture(t);
	const oversized = join(source, "big.md");
	await writeFile(oversized, "x".repeat(MAX_FILE_BYTES + 1));
	await assert.rejects(
		copyDocuments(source, { destinationDirectory }),
		/大きすぎ/,
	);
	assert.deepEqual(await readdir(destinationDirectory), []);
	assert.equal((await lstat(oversized)).size, MAX_FILE_BYTES + 1);
	await rm(oversized);
	await writeFile(
		join(source, "big.png"),
		Buffer.alloc(5 * MAX_FILE_BYTES + 1),
	);
	await assert.rejects(
		copyDocuments(source, { destinationDirectory }),
		/大きすぎ/,
	);
	assert.deepEqual(await readdir(destinationDirectory), []);
});

test("copies without Markdown or beyond the depth limit are rejected and cleaned up", async (t) => {
	const { source, destinationDirectory } = await createCopyFixture(t);
	await rm(join(source, "index.md"));
	await assert.rejects(
		copyDocuments(source, { destinationDirectory }),
		/Markdown がありません/,
	);
	let nested = source;
	for (let depth = 0; depth <= MAX_DIRECTORY_DEPTH; depth++) {
		nested = join(nested, "child");
		await mkdir(nested);
	}
	await assert.rejects(
		copyDocuments(source, { destinationDirectory }),
		/深すぎ/,
	);
	assert.deepEqual(await readdir(destinationDirectory), []);
});

test("copy directory cannot itself be a symlink", async (t) => {
	const { root, source, destinationDirectory } = await createCopyFixture(t);
	const redirected = join(root, "redirected");
	await symlink(destinationDirectory, redirected);
	for (const directory of [redirected, `${redirected}/`]) {
		await assert.rejects(
			copyDocuments(source, { destinationDirectory: directory }),
			/通常のフォルダー/,
		);
		await assert.rejects(
			createViewerServer({ contentDirectory: directory }),
			/通常のフォルダー/,
		);
	}
});

test("viewer rejects outside paths and forged history roots", async (t) => {
	const { root, source, destinationDirectory, destination, api, id } =
		await createCopiedViewerFixture(t);
	for (const path of [
		source,
		join(source, "index.md"),
		join(root, "missing.md"),
		`${destinationDirectory}-outside`,
	])
		assert.equal((await api("open", { path })).status, 403, path);
	assert.equal(
		(await api("restore", { path: join(source, "index.md"), root: source }))
			.status,
		403,
	);
	assert.equal(
		(await api("restore", { path: join(destination, "index.md"), root }))
			.status,
		403,
	);
	assert.equal(
		(await api("related", { id, href: "../../日本語%20notes/index.md" }))
			.status,
		403,
	);
});

test("viewer rejects links and images redirected outside the copy directory", async (t) => {
	const { source, destinationDirectory, destination, api, id } =
		await createCopiedViewerFixture(t);
	await symlink(source, join(destinationDirectory, "escape"));
	assert.equal(
		(
			await api("open", {
				path: join(destinationDirectory, "escape", "index.md"),
			})
		).status,
		403,
	);
	await symlink(join(source, "index.md"), join(destination, "escape.md"));
	assert.equal((await api("related", { id, href: "escape.md" })).status, 403);
	await writeFile(join(source, "outside.png"), "image");
	await symlink(join(source, "outside.png"), join(destination, "escape.png"));
	assert.equal((await api("image", { id, href: "escape.png" })).status, 403);
	assert.equal((await api("render", { source: "unregistered" })).status, 404);
});

test("viewer saves highlights only to the independent copy", async (t) => {
	const { source, destination, api, id } = await createCopiedViewerFixture(t);
	const doc = await (await api("read", { id })).json();
	const text = "important words";
	const start = doc.source.indexOf(text);
	assert.equal(
		(
			await api("highlight", {
				id,
				mode: "add",
				color: "yellow",
				version: doc.version,
				ranges: [{ start, end: start + text.length, text }],
			})
		).status,
		200,
	);
	assert.match(
		await readFile(join(destination, "index.md"), "utf8"),
		/<mark data-mdv-color="yellow">/,
	);
	assert.equal(await readFile(join(source, "index.md"), "utf8"), doc.source);
});

test("registered copies replaced by file or directory symlinks cannot be read or written", async (t) => {
	for (const replacedEntry of ["file", "directory"]) {
		await t.test(replacedEntry, async (t) => {
			const { source, destination, api, id } =
				await createCopiedViewerFixture(t);
			const original = await readFile(join(source, "index.md"), "utf8");
			if (replacedEntry === "file") {
				await rm(join(destination, "index.md"));
				await symlink(join(source, "index.md"), join(destination, "index.md"));
			} else {
				await rm(destination, { recursive: true });
				await symlink(source, destination);
			}
			assert.equal((await api("read", { id })).status, 403);
			assert.equal((await api("highlight", { id })).status, 403);
			assert.equal(await readFile(join(source, "index.md"), "utf8"), original);
		});
	}
});

test("empty copy directories start successfully, outside startup paths do not", async (t) => {
	const { source, destinationDirectory } = await createCopyFixture(t);
	const api = await startCopiedViewer(t, destinationDirectory);
	assert.deepEqual(await (await api("initial")).json(), { documents: [] });
	await assert.rejects(
		createViewerServer({
			contentDirectory: destinationDirectory,
			initialPaths: [source],
		}),
		/コピーしたファイルだけ/,
	);
});

test("copy command exposes usage and exits unsuccessfully without a source", () => {
	assert.match(
		execFileSync(process.execPath, ["scripts/copy-docs.mjs", "--help"], {
			encoding: "utf8",
		}),
		/pnpm copy-docs/,
	);
	assert.throws(
		() =>
			execFileSync(process.execPath, ["scripts/copy-docs.mjs"], {
				stdio: "pipe",
			}),
		{ status: 1 },
	);
});
