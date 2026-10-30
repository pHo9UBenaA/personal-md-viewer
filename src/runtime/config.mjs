import { readFile } from "node:fs/promises";

const optionFlags = [
	"--recursive",
	"--allow-html",
	"--no-notices",
	"--no-open",
];

export async function loadViewerOptions(
	args,
	configPath = new URL("../../dev.local.json", import.meta.url),
) {
	let source;
	try {
		source = await readFile(configPath, "utf8");
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	const config = source === undefined ? { paths: [] } : parseConfig(source);
	const explicitPaths = args.filter((arg) => !optionFlags.includes(arg));
	return {
		initialPaths: explicitPaths.length > 0 ? explicitPaths : config.paths,
		recursive: args.includes("--recursive") || config.recursive === true,
		allowHtml: args.includes("--allow-html") || config.allowHtml === true,
		hideNotices: args.includes("--no-notices") || config.hideNotices === true,
	};
}

function parseConfig(source) {
	let config;
	try {
		config = JSON.parse(source);
	} catch {
		throw new Error("dev.local.json を有効な JSON にしてください。");
	}
	if (
		!config ||
		typeof config !== "object" ||
		!Array.isArray(config.paths) ||
		config.paths.some((path) => typeof path !== "string" || !path.trim()) ||
		["recursive", "allowHtml", "hideNotices"].some(
			(key) => config[key] !== undefined && typeof config[key] !== "boolean",
		)
	)
		throw new Error(
			"dev.local.json の paths には文字列の配列を指定してください。recursive / allowHtml / hideNotices は省略できますが、指定する場合は真偽値にしてください。",
		);
	return config;
}
