import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, opendir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import {
	basename,
	dirname,
	extname,
	isAbsolute,
	relative,
	resolve,
	sep,
} from "node:path";

export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_TABS = 200;
const MAX_ENTRIES = 10000;
const ignored = new Set([".git", "node_modules", ".DS_Store"]);
export const isMarkdown = (path) => /\.(md|markdown)$/i.test(path);
export const imageTypes = new Map([
	[".png", "image/png"],
	[".jpg", "image/jpeg"],
	[".jpeg", "image/jpeg"],
	[".gif", "image/gif"],
	[".webp", "image/webp"],
	[".avif", "image/avif"],
]);

export class ViewerError extends Error {
	constructor(message, status = 400) {
		super(message);
		this.status = status;
	}
}

export function within(root, path) {
	const rel = relative(root, path);
	return (
		rel === "" ||
		(!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
	);
}

export function normalizePath(input) {
	if (
		typeof input !== "string" ||
		!input.trim() ||
		input.length > 4096 ||
		input.includes("\0")
	) {
		throw new ViewerError("ファイルまたはフォルダーのパスを入力してください。");
	}
	let path = input.trim();
	if (
		(path.startsWith('"') && path.endsWith('"')) ||
		(path.startsWith("'") && path.endsWith("'"))
	)
		path = path.slice(1, -1);
	if (path === "~") path = homedir();
	else if (path.startsWith("~/")) path = resolve(homedir(), path.slice(2));
	return resolve(path);
}

// Open nonblocking and check the opened handle: FIFOs/devices cannot hang reads.
export async function readBounded(path, root, limit = MAX_FILE_BYTES) {
	const canonical = await realpath(path);
	if (!within(root, canonical))
		throw new ViewerError("選択したフォルダーの外は参照できません。", 403);
	const handle = await open(
		canonical,
		constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
	);
	try {
		const details = await handle.stat();
		if (!details.isFile())
			throw new ViewerError("通常のファイルを選択してください。");
		if (details.size > limit)
			throw new ViewerError(
				`ファイルが大きすぎます（上限 ${limit / 1024 / 1024} MiB）。`,
				413,
			);
		const buffer = Buffer.alloc(limit + 1);
		let length = 0;
		while (length < buffer.length) {
			const { bytesRead } = await handle.read(
				buffer,
				length,
				buffer.length - length,
				null,
			);
			if (!bytesRead) break;
			length += bytesRead;
		}
		if (length > limit)
			throw new ViewerError("読み取り中にファイルの上限を超えました。", 413);
		return buffer.subarray(0, length);
	} finally {
		await handle.close();
	}
}

export function createLibrary() {
	const documents = new Map();
	const byPath = new Map();

	function register(path, root) {
		const key = `${root}\0${path}`;
		if (byPath.has(key)) return documents.get(byPath.get(key));
		if (documents.size >= 1000)
			throw new ViewerError(
				"セッションの上限です。サーバーを再起動してください。",
				413,
			);
		const doc = {
			id: randomUUID(),
			path,
			root,
			name: basename(path),
			label: relative(root, path) || basename(path),
		};
		documents.set(doc.id, doc);
		byPath.set(key, doc.id);
		return doc;
	}

	function get(id) {
		const doc = documents.get(id);
		if (!doc)
			throw new ViewerError(
				"ファイルが見つかりません。もう一度開いてください。",
				404,
			);
		return doc;
	}

	async function openPath(input, recursive = false) {
		const path = await realpath(normalizePath(input));
		const details = await stat(path);
		if (details.isFile()) {
			if (!isMarkdown(path))
				throw new ViewerError(
					".md または .markdown ファイルを選択してください。",
				);
			if (details.size > MAX_FILE_BYTES)
				throw new ViewerError("Markdown の上限は 1 MiB です。", 413);
			return [register(path, dirname(path))];
		}
		if (!details.isDirectory())
			throw new ViewerError(
				"通常のファイルまたはフォルダーを選択してください。",
			);
		const found = [];
		let visited = 0;
		async function walk(directory, depth) {
			if (depth > 32)
				throw new ViewerError(
					"フォルダーが深すぎます。範囲を絞ってください。",
					413,
				);
			const entries = await opendir(directory);
			for await (const entry of entries) {
				if (++visited > MAX_ENTRIES)
					throw new ViewerError(
						"項目が多すぎます。フォルダーの範囲を絞ってください。",
						413,
					);
				if (ignored.has(entry.name) || entry.isSymbolicLink()) continue;
				const child = resolve(directory, entry.name);
				// Revalidate before descending, including replaced directory symlinks.
				const canonical = await realpath(child);
				if (!within(path, canonical))
					throw new ViewerError("フォルダー外への参照を検出しました。", 403);
				if (entry.isDirectory() && recursive) await walk(canonical, depth + 1);
				else if (entry.isFile() && isMarkdown(child)) {
					found.push(canonical);
					if (found.length > MAX_TABS)
						throw new ViewerError(
							`一度に開けるのは ${MAX_TABS} 件です。範囲を絞ってください。`,
							413,
						);
				}
			}
		}
		await walk(path, 0);
		if (!found.length)
			throw new ViewerError(
				"Markdown がありません。必要なら「サブフォルダーも含める」を選択してください。",
			);
		const unique = [...new Set(found)].sort((a, b) => a.localeCompare(b));
		if (
			documents.size +
				unique.filter((file) => !byPath.has(`${path}\0${file}`)).length >
			1000
		)
			throw new ViewerError(
				"セッションの上限です。サーバーを再起動してください。",
				413,
			);
		return unique.map((file) => register(file, path));
	}

	async function resolveRelated(id, href, kind) {
		const doc = get(id);
		if (
			typeof href !== "string" ||
			href.length > 4096 ||
			/^(?:[a-z][a-z\d+.-]*:|\/|\\)/i.test(href)
		)
			throw new ViewerError("相対パスのみ参照できます。");
		let decoded;
		try {
			decoded = decodeURIComponent(href.split(/[?#]/)[0]);
		} catch {
			throw new ViewerError("リンクの形式が不正です。");
		}
		if (!decoded || decoded.includes("\0") || decoded.includes("\\"))
			throw new ViewerError("リンクの形式が不正です。");
		const path = await realpath(resolve(dirname(doc.path), decoded));
		if (!within(doc.root, path))
			throw new ViewerError(
				"選択したフォルダーの外は参照できません。絶対パスで開いてください。",
				403,
			);
		if (kind === "markdown" && !isMarkdown(path))
			throw new ViewerError("Markdown ファイルへのリンクではありません。");
		if (kind === "image" && !imageTypes.has(extname(path).toLowerCase()))
			throw new ViewerError("対応画像は PNG、JPEG、GIF、WebP、AVIF です。");
		return { path, root: doc.root };
	}

	return {
		openPath,
		async read(id) {
			const doc = get(id);
			return {
				...doc,
				source: (await readBounded(doc.path, doc.root)).toString("utf8"),
			};
		},
		async related(id, href) {
			const file = await resolveRelated(id, href, "markdown");
			await readBounded(file.path, file.root);
			return register(file.path, file.root);
		},
		async image(id, href) {
			const file = await resolveRelated(id, href, "image");
			return {
				data: await readBounded(file.path, file.root, 5 * MAX_FILE_BYTES),
				type: imageTypes.get(extname(file.path).toLowerCase()),
			};
		},
	};
}
