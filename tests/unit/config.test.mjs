import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { loadViewerOptions } from "../../src/runtime/config.mjs";

let directory;
let configPath;
before(async () => {
	directory = await mkdtemp(join(tmpdir(), "viewer-config-"));
	configPath = join(directory, "dev.local.json");
});
after(async () => {
	if (directory) await rm(directory, { recursive: true, force: true });
});

async function optionsFor(config, args = []) {
	await writeFile(configPath, JSON.stringify(config));
	return loadViewerOptions(args, configPath);
}

test("missing config preserves CLI paths and defaults", async () => {
	assert.deepEqual(await loadViewerOptions(["--no-open"], configPath), {
		initialPaths: [],
		recursive: false,
		allowHtml: false,
		hideNotices: false,
	});
	assert.deepEqual(
		await loadViewerOptions(["content/notes", "--recursive"], configPath),
		{
			initialPaths: ["content/notes"],
			recursive: true,
			allowHtml: false,
			hideNotices: false,
		},
	);
});

test("config paths are used even with path-independent CLI flags", async () => {
	assert.deepEqual(
		await optionsFor({ paths: ["content/notes"] }, [
			"--no-open",
			"--no-notices",
		]),
		{
			initialPaths: ["content/notes"],
			recursive: false,
			allowHtml: false,
			hideNotices: true,
		},
	);
});

test("explicit paths override config paths without discarding its flags", async () => {
	assert.deepEqual(
		await optionsFor(
			{
				paths: ["content/configured"],
				recursive: true,
				allowHtml: true,
				hideNotices: true,
			},
			["content/one.md", "content/two.md"],
		),
		{
			initialPaths: ["content/one.md", "content/two.md"],
			recursive: true,
			allowHtml: true,
			hideNotices: true,
		},
	);
});

test("CLI flags enable false config options", async () => {
	assert.deepEqual(
		await optionsFor(
			{
				paths: [],
				recursive: false,
				allowHtml: false,
				hideNotices: false,
			},
			["--recursive", "--allow-html", "--no-notices"],
		),
		{
			initialPaths: [],
			recursive: true,
			allowHtml: true,
			hideNotices: true,
		},
	);
});

test("config path strings are never interpreted as CLI flags", async () => {
	assert.deepEqual(await optionsFor({ paths: ["--allow-html"] }), {
		initialPaths: ["--allow-html"],
		recursive: false,
		allowHtml: false,
		hideNotices: false,
	});
});

test("invalid JSON identifies the config file", async () => {
	await writeFile(configPath, "{");
	await assert.rejects(
		loadViewerOptions([], configPath),
		/dev\.local\.json.*JSON/,
	);
});

for (const config of [
	null,
	[],
	{},
	{ paths: "content/notes" },
	{ paths: [1] },
	{ paths: [""] },
	{ paths: [" "] },
	{ paths: [], recursive: "true" },
	{ paths: [], allowHtml: 1 },
	{ paths: [], hideNotices: null },
]) {
	test(`invalid config is rejected even with explicit paths: ${JSON.stringify(config)}`, async () => {
		await assert.rejects(
			optionsFor(config, ["content/explicit.md"]),
			/dev\.local\.json.*paths/,
		);
	});
}

test("config read errors other than a missing file are not ignored", async () => {
	await assert.rejects(loadViewerOptions([], directory));
});
