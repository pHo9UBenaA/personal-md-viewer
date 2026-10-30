import {
	cp,
	mkdir,
	mkdtemp,
	realpath,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// CLI tests need their own content/, dev configuration and process-state file.
export async function createTestProject() {
	const directory = await realpath(
		await mkdtemp(join(tmpdir(), "viewer-cli-")),
	);
	for (const name of ["src", "public", "scripts"])
		await cp(
			new URL(`../../${name}/`, import.meta.url),
			join(directory, name),
			{ recursive: true },
		);
	await mkdir(join(directory, "content"));
	await symlink(
		fileURLToPath(new URL("../../node_modules/", import.meta.url)),
		join(directory, "node_modules"),
		"junction",
	);
	return directory;
}

export async function createMockChrome(directory) {
	const executable = join(directory, "mock chrome.mjs");
	const log = join(directory, "chrome-launches.jsonl");
	await writeFile(
		executable,
		`#!${process.execPath}
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
`,
		{ mode: 0o755 },
	);
	return { executable, log };
}
