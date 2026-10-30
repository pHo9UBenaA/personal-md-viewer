import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
	lstat,
	open,
	opendir,
	realpath,
	rename,
	stat,
	unlink,
} from "node:fs/promises";
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
import { fileURLToPath } from "node:url";
import { HIGHLIGHT_COLORS, highlightOpenTag } from "./highlights.mjs";

export const COPIED_DIRECTORY = fileURLToPath(
	new URL("../content/", import.meta.url),
);
export const MAX_FILE_BYTES = 1024 * 1024;
export const ignoredEntryNames = new Set([".git", "node_modules", ".DS_Store"]);
export const MAX_DIRECTORY_DEPTH = 32;
const MAX_PATH_CHARS = 4096;
const HIGHLIGHT_CLOSE_TAG = "</mark>";
export const isMarkdown = (path) => /\.(md|markdown)$/i.test(path);
export const imageTypes = new Map([
	[".png", "image/png"],
	[".jpg", "image/jpeg"],
	[".jpeg", "image/jpeg"],
	[".gif", "image/gif"],
	[".webp", "image/webp"],
	[".avif", "image/avif"],
]);

const sourceVersion = (source) =>
	createHash("sha256").update(source).digest("hex");

export class ViewerError extends Error {
	constructor(message, status = 400) {
		super(message);
		this.status = status;
	}
}

export function isWithinRoot(root, path) {
	const relativePath = relative(root, path);
	return (
		relativePath === "" ||
		(!isAbsolute(relativePath) &&
			relativePath !== ".." &&
			!relativePath.startsWith(`..${sep}`))
	);
}

export function normalizePath(input) {
	if (
		typeof input !== "string" ||
		!input.trim() ||
		input.length > MAX_PATH_CHARS ||
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
export async function readBounded(path, root, maxBytes = MAX_FILE_BYTES) {
	const canonical = await realpath(path);
	if (!isWithinRoot(root, canonical))
		throw new ViewerError("選択したフォルダーの外は参照できません。", 403);
	const handle = await open(
		canonical,
		constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
	);
	try {
		const details = await handle.stat();
		if (!details.isFile())
			throw new ViewerError("通常のファイルを選択してください。");
		if (details.size > maxBytes)
			throw new ViewerError(
				`ファイルが大きすぎます（上限 ${maxBytes / 1024 / 1024} MiB）。`,
				413,
			);
		// Read one extra byte to detect growth after the size check.
		const buffer = Buffer.alloc(maxBytes + 1);
		let totalBytesRead = 0;
		while (totalBytesRead < buffer.length) {
			const { bytesRead } = await handle.read(
				buffer,
				totalBytesRead,
				buffer.length - totalBytesRead,
				null,
			);
			if (!bytesRead) break;
			totalBytesRead += bytesRead;
		}
		if (totalBytesRead > maxBytes)
			throw new ViewerError(
				"読み取り中にファイルサイズが上限を超えました。",
				413,
			);
		return buffer.subarray(0, totalBytesRead);
	} finally {
		await handle.close();
	}
}

// The copy directory itself must not redirect the entire library elsewhere.
export async function resolveCopiedDirectory(directory = COPIED_DIRECTORY) {
	const path = normalizePath(directory);
	// Strip a trailing separator: lstat("link/") would follow a directory symlink.
	if (!(await lstat(path)).isDirectory())
		throw new ViewerError("コピー先には通常のフォルダーが必要です。", 403);
	return realpath(path);
}

export async function createLibrary({ directory = COPIED_DIRECTORY } = {}) {
	const configuredRoot = normalizePath(directory);
	const copiedRoot = await resolveCopiedDirectory(configuredRoot);
	const documents = new Map();
	// A file can have different link scopes when opened from different roots.
	const documentIdByScopedPath = new Map();

	function register(path, root) {
		const key = `${root}\0${path}`;
		if (documentIdByScopedPath.has(key))
			return documents.get(documentIdByScopedPath.get(key));
		const doc = {
			id: randomUUID(),
			path,
			root,
			name: basename(path),
			label: relative(root, path) || basename(path),
			relativePath: relative(copiedRoot, path).split(sep).join("/"),
		};
		documents.set(doc.id, doc);
		documentIdByScopedPath.set(key, doc.id);
		return doc;
	}

	function requireDocument(id) {
		const doc = documents.get(id);
		if (!doc)
			throw new ViewerError(
				"ファイルが見つかりません。もう一度開いてください。",
				404,
			);
		return doc;
	}

	async function resolveAllowedPath(input) {
		let requested = normalizePath(input);
		// Preserve OS aliases in the configured path, such as /var -> /private/var.
		if (isWithinRoot(configuredRoot, requested))
			requested = resolve(copiedRoot, relative(configuredRoot, requested));
		// Reject outside paths before touching the filesystem, including missing paths.
		if (!isWithinRoot(copiedRoot, requested))
			throw new ViewerError(
				"content/ にコピーしたファイルだけを開けます。",
				403,
			);
		const canonical = await realpath(requested);
		if (!isWithinRoot(copiedRoot, canonical))
			throw new ViewerError("content/ の外は参照できません。", 403);
		return canonical;
	}

	async function openPath(
		input,
		recursive = false,
		{ allowEmpty = false } = {},
	) {
		const path = await resolveAllowedPath(input);
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
		async function walk(directory, depth) {
			if (depth > MAX_DIRECTORY_DEPTH)
				throw new ViewerError(
					"フォルダーが深すぎます。範囲を絞ってください。",
					413,
				);
			const entries = await opendir(directory);
			for await (const entry of entries) {
				if (ignoredEntryNames.has(entry.name) || entry.isSymbolicLink())
					continue;
				const child = resolve(directory, entry.name);
				// Revalidate before descending, including replaced directory symlinks.
				const canonical = await realpath(child);
				if (!isWithinRoot(path, canonical))
					throw new ViewerError("フォルダー外への参照を検出しました。", 403);
				if (entry.isDirectory() && recursive) await walk(canonical, depth + 1);
				else if (entry.isFile() && isMarkdown(child)) {
					found.push(canonical);
				}
			}
		}
		await walk(path, 0);
		if (!found.length && !allowEmpty)
			throw new ViewerError(
				"Markdown が見つかりません。サブフォルダー内も探す場合は「サブフォルダーも含める」を選択してください。",
			);
		const unique = [...new Set(found)].sort((a, b) => a.localeCompare(b));
		return unique.map((file) => register(file, path));
	}

	async function resolveRelated(id, href, kind) {
		const doc = requireDocument(id);
		if (
			typeof href !== "string" ||
			href.length > MAX_PATH_CHARS ||
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
		if (!isWithinRoot(doc.root, path))
			throw new ViewerError(
				"選択したフォルダーの外は参照できません。content/ 内のパスを指定してください。",
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
		openCopiedDirectory() {
			return openPath(copiedRoot, true, { allowEmpty: true });
		},
		async restore(pathInput, rootInput) {
			const path = await resolveAllowedPath(pathInput);
			const root = await resolveAllowedPath(rootInput);
			if (!(await stat(root)).isDirectory() || !isWithinRoot(root, path))
				throw new ViewerError("保存したフォルダーの外は復元できません。", 403);
			const details = await stat(path);
			if (!details.isFile() || !isMarkdown(path))
				throw new ViewerError("Markdown ファイルを復元できません。");
			if (details.size > MAX_FILE_BYTES)
				throw new ViewerError("Markdown の上限は 1 MiB です。", 413);
			return register(path, root);
		},
		async read(id) {
			const doc = requireDocument(id);
			const source = (await readBounded(doc.path, doc.root)).toString("utf8");
			return {
				...doc,
				source,
				version: sourceVersion(source),
			};
		},
		async highlight(
			id,
			{ mode, color, ranges, marker, version },
			preservesMarkdown,
		) {
			const doc = requireDocument(id);
			const source = (await readBounded(doc.path, doc.root)).toString("utf8");
			if (typeof version !== "string" || version !== sourceVersion(source))
				throw new ViewerError(
					"ファイルが更新されています。再読み込みして選択し直してください。",
					409,
				);
			const updated = updateHighlightSource(source, {
				mode,
				color,
				ranges,
				marker,
			});
			if (Buffer.byteLength(updated) > MAX_FILE_BYTES)
				throw new ViewerError(
					"マーカーを追加すると Markdown の上限 1 MiB を超えます。",
					413,
				);
			if (
				typeof preservesMarkdown === "function" &&
				!preservesMarkdown(source, updated)
			)
				throw new ViewerError(
					"Markdown の構造を保ったまま選択範囲を保存できません。選択範囲を狭めてください。",
					409,
				);
			await replaceVerifiedSource(doc, updated, version);
			return { ...doc, source: updated, version: sourceVersion(updated) };
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

// Nonempty, start-inclusive/end-exclusive UTF-16 offsets, as used by String.slice.
function isSourceRange(range, sourceLength) {
	return (
		Boolean(range) &&
		Number.isSafeInteger(range.start) &&
		Number.isSafeInteger(range.end) &&
		range.start >= 0 &&
		range.end > range.start &&
		range.end <= sourceLength
	);
}

function addSourceHighlights(source, color, ranges) {
	if (!HIGHLIGHT_COLORS.has(color))
		throw new ViewerError("マーカーの色が不正です。");
	if (!Array.isArray(ranges) || ranges.length === 0)
		throw new ViewerError("マーカーを付ける文章を選択してください。");
	let previousEnd = 0;
	for (const range of ranges) {
		if (
			!isSourceRange(range, source.length) ||
			range.start < previousEnd ||
			typeof range.text !== "string" ||
			source.slice(range.start, range.end) !== range.text
		)
			throw new ViewerError(
				"選択範囲を確認できません。選択し直してください。",
				409,
			);
		previousEnd = range.end;
	}
	let updated = source;
	const openTag = highlightOpenTag(color);
	// Insert from the end so earlier offsets remain valid.
	for (const { start, end } of ranges.toReversed()) {
		const before = updated.slice(0, start);
		const selectedText = updated.slice(start, end);
		const after = updated.slice(end);
		updated = `${before}${openTag}${selectedText}</mark>${after}`;
	}
	return updated;
}

function updateHighlightSource(source, { mode, color, ranges, marker }) {
	if (mode === "add") return addSourceHighlights(source, color, ranges);
	if (mode === "recolor" || mode === "remove") {
		if (
			!isSourceRange(marker, source.length) ||
			!HIGHLIGHT_COLORS.has(marker.color) ||
			(mode === "recolor" && !HIGHLIGHT_COLORS.has(color))
		)
			throw new ViewerError("マーカーの範囲または色が不正です。");
		const currentOpenTag = highlightOpenTag(marker.color);
		const markedSource = source.slice(marker.start, marker.end);
		const markerContent = markedSource.slice(
			currentOpenTag.length,
			-HIGHLIGHT_CLOSE_TAG.length,
		);
		if (
			!markedSource.startsWith(currentOpenTag) ||
			!markedSource.endsWith(HIGHLIGHT_CLOSE_TAG) ||
			markerContent.includes("<mark data-mdv-color=")
		)
			throw new ViewerError(
				"現在のマーカーを確認できません。選択し直してください。",
				409,
			);
		const replacement =
			mode === "remove"
				? markerContent
				: `${highlightOpenTag(color)}${markerContent}${HIGHLIGHT_CLOSE_TAG}`;
		return `${source.slice(0, marker.start)}${replacement}${source.slice(marker.end)}`;
	}
	throw new ViewerError("マーカー操作が不正です。");
}

// Recheck inode identity and content before replacing the original file.
async function replaceVerifiedSource(doc, updated, version) {
	const canonical = await realpath(doc.path);
	if (!isWithinRoot(doc.root, canonical))
		throw new ViewerError("選択したフォルダーの外は更新できません。", 403);
	const details = await stat(canonical);
	if (!details.isFile())
		throw new ViewerError("通常のファイルを選択してください。");
	const temporaryPath = resolve(
		dirname(canonical),
		`.${basename(canonical)}.${randomUUID()}.tmp`,
	);
	let handle;
	try {
		handle = await open(
			temporaryPath,
			constants.O_WRONLY |
				constants.O_CREAT |
				constants.O_EXCL |
				constants.O_NOFOLLOW,
			details.mode & 0o777,
		);
		await handle.writeFile(updated, "utf8");
		await handle.sync();
		await handle.close();
		handle = undefined;
		const current = await stat(canonical);
		const currentSource = (await readBounded(canonical, doc.root)).toString(
			"utf8",
		);
		if (
			current.dev !== details.dev ||
			current.ino !== details.ino ||
			sourceVersion(currentSource) !== version
		)
			throw new ViewerError(
				"ファイルが更新されています。再読み込みしてください。",
				409,
			);
		await rename(temporaryPath, canonical);
	} finally {
		// Best-effort cleanup must not replace the original write/conflict error.
		await handle?.close().catch(() => {});
		await unlink(temporaryPath).catch(() => {});
	}
}
