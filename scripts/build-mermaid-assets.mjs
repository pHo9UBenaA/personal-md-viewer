/**
 * @file Copies Mermaid's dist bundle into the public script directory.
 */

import { cp, mkdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const MERMAID_DIST_DIR = "node_modules/mermaid/dist";
const MERMAID_ENTRY_FILE = "mermaid.esm.min.mjs";
const PUBLIC_MERMAID_DIR = "public/scripts/mermaid";

const resolveFromRoot = (path) => resolve(PROJECT_ROOT, path);

/**
 * Ensure the mermaid ESM bundle exists before copying.
 */
const ensureMermaidDistExists = async () => {
	const entryPath = resolveFromRoot(
		`${MERMAID_DIST_DIR}/${MERMAID_ENTRY_FILE}`,
	);

	try {
		await stat(entryPath);
	} catch (_error) {
		throw new Error(
			"Mermaid bundle not found. Run `pnpm install` before building assets.",
		);
	}
};

/**
 * Copy the mermaid dist directory into the public assets folder.
 */
const copyMermaidDist = async () => {
	await ensureMermaidDistExists();

	const distPath = resolveFromRoot(MERMAID_DIST_DIR);
	const destinationDir = resolveFromRoot(PUBLIC_MERMAID_DIR);

	await rm(destinationDir, { recursive: true, force: true });
	await mkdir(destinationDir, { recursive: true });
	await cp(distPath, destinationDir, { recursive: true });
};

try {
	await copyMermaidDist();
	console.log("Mermaid bundle copied to public/scripts/mermaid");
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
}
