import {
	mkdir,
	opendir,
	realpath,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	COPIED_DIRECTORY,
	ignoredEntryNames,
	imageTypes,
	isMarkdown,
	isWithinRoot,
	MAX_DIRECTORY_DEPTH,
	MAX_FILE_BYTES,
	normalizePath,
	readBounded,
	resolveCopiedDirectory,
	ViewerError,
} from "../src/library.mjs";

function validateCopyName(name) {
	if (
		typeof name !== "string" ||
		!name.trim() ||
		name !== name.trim() ||
		name.startsWith(".") ||
		ignoredEntryNames.has(name) ||
		/[\\/\0]/.test(name) ||
		Buffer.byteLength(name) > 255
	)
		throw new ViewerError(
			"コピー名には UTF-8 で 255 バイト以内のフォルダー名を指定してください。先頭の .、前後の空白、パスの区切り文字、除外名は使えません。",
		);
}

// Always create a new collection: recopying must not erase saved highlights.
export async function copyDocuments(
	sourceInput,
	{ name, destinationDirectory = COPIED_DIRECTORY } = {},
) {
	const sourceRoot = await realpath(normalizePath(sourceInput));
	if (!(await stat(sourceRoot)).isDirectory())
		throw new ViewerError("コピー元のフォルダーを指定してください。");
	const copyName = name ?? basename(sourceRoot);
	validateCopyName(copyName);
	const destinationRoot = await resolveCopiedDirectory(destinationDirectory);
	if (
		isWithinRoot(sourceRoot, destinationRoot) ||
		isWithinRoot(destinationRoot, sourceRoot)
	)
		throw new ViewerError(
			"content/ 自体やその中のフォルダー、content/ を含むフォルダーはコピー元に指定できません。",
		);
	const destination = resolve(destinationRoot, copyName);
	// mkdir without recursive reserves the name and refuses existing files or links.
	await mkdir(destination, { mode: 0o700 });
	let markdownCount = 0;
	let imageCount = 0;
	let skippedLinks = 0;

	async function copyDirectory(source, target, depth) {
		if (depth > MAX_DIRECTORY_DEPTH)
			throw new ViewerError(
				"フォルダーが深すぎます。コピー範囲を絞ってください。",
			);
		const entries = await opendir(source);
		for await (const entry of entries) {
			if (ignoredEntryNames.has(entry.name)) continue;
			if (entry.isSymbolicLink()) {
				skippedLinks++;
				continue;
			}
			const sourcePath = resolve(source, entry.name);
			const targetPath = resolve(target, entry.name);
			const canonical = await realpath(sourcePath);
			if (!isWithinRoot(sourceRoot, canonical))
				throw new ViewerError("コピー元の外への参照を検出しました。", 403);
			if (entry.isDirectory()) {
				await mkdir(targetPath, { mode: 0o700 });
				await copyDirectory(canonical, targetPath, depth + 1);
				continue;
			}
			if (!entry.isFile()) continue;
			const markdown = isMarkdown(entry.name);
			const image = imageTypes.has(extname(entry.name).toLowerCase());
			if (!markdown && !image) continue;
			const maxBytes = markdown ? MAX_FILE_BYTES : 5 * MAX_FILE_BYTES;
			const data = await readBounded(canonical, sourceRoot, maxBytes);
			// Write bytes, not links or source permissions/metadata.
			await writeFile(targetPath, data, { flag: "wx", mode: 0o600 });
			if (markdown) markdownCount++;
			else imageCount++;
		}
	}

	try {
		await copyDirectory(sourceRoot, destination, 0);
		if (!markdownCount)
			throw new ViewerError("コピー対象の Markdown がありません。");
		return { destination, markdownCount, imageCount, skippedLinks };
	} catch (error) {
		await rm(destination, { recursive: true, force: true });
		throw error;
	}
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	const args = process.argv.slice(2).filter((arg) => arg !== "--");
	if (args.includes("--help") || args.includes("-h")) {
		console.log(
			"Usage: pnpm copy-docs SOURCE_DIRECTORY [COPY_NAME]\nCopies Markdown and supported images into content/COPY_NAME. Existing copies are never overwritten; symlinks are skipped.",
		);
	} else {
		try {
			if (args.length < 1 || args.length > 2)
				throw new ViewerError(
					"pnpm copy-docs コピー元フォルダー [コピー名] の形式で実行してください。",
				);
			const result = await copyDocuments(args[0], { name: args[1] });
			console.log(
				`Copied: ${result.destination}\nMarkdown: ${result.markdownCount}, images: ${result.imageCount}, skipped symlinks: ${result.skippedLinks}\nマーカーはコピーに保存されます。元ファイルには反映されません。`,
			);
		} catch (error) {
			console.error(
				error.code === "EEXIST"
					? "同名のコピーが既にあります。別のコピー名を指定してください。"
					: error.message,
			);
			process.exitCode = 1;
		}
	}
}
