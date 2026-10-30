import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createTestProject } from "../helpers/project.mjs";

let project;
before(async () => {
	project = await createTestProject();
	for (const folder of ["configured/nested", "explicit/nested"])
		await mkdir(join(project, "content", folder), { recursive: true });
	for (const path of [
		"configured/top.md",
		"configured/nested/deep.md",
		"explicit/other.md",
		"explicit/nested/last.md",
	])
		await writeFile(
			join(project, "content", path),
			"<details><summary>Trusted</summary>Body</details>",
		);
	await writeFile(join(project, "outside.md"), "# Outside the copy");
});
after(async () => {
	if (project) await rm(project, { recursive: true, force: true });
});

function launch(mode, args = []) {
	const child = spawn(
		process.execPath,
		[
			mode === "start" ? "src/index.mjs" : "scripts/dev.mjs",
			"--no-open",
			...args,
		],
		{
			cwd: project,
			env: { ...process.env, PORT: "0", DEV_PORT: "0", VIEWER_ORIGIN: "" },
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	const exited = once(child, "exit");
	let output = "";
	child.stdout.on("data", (data) => {
		output += data;
	});
	child.stderr.on("data", (data) => {
		output += data;
	});
	return {
		output: () => output,
		async stop() {
			child.kill("SIGTERM");
			await exited;
		},
	};
}

async function waitForOutput(viewer, pattern) {
	const deadline = Date.now() + 10000;
	while (Date.now() < deadline) {
		const match = viewer.output().match(pattern);
		if (match) return match;
		await new Promise((resolve) => setTimeout(resolve, 30));
	}
	assert.fail(`Expected ${pattern}, got:\n${viewer.output()}`);
}

async function readInitial(viewer, mode) {
	const label = mode === "start" ? "Markdown viewer" : "Dev ready";
	const match = await waitForOutput(
		viewer,
		new RegExp(`${label}: (http://[^\\s]+)`),
	);
	const url = match[1];
	const html = await (await fetch(url)).text();
	const token = html.match(/name="viewer-token" content="([^"]+)"/)[1];
	async function api(route, body = {}) {
		const response = await fetch(`${url}/api/${route}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Viewer-Token": token },
			body: JSON.stringify(body),
		});
		assert.equal(response.status, 200, await response.clone().text());
		return response.json();
	}
	return { html, documents: (await api("initial")).documents, api };
}

for (const mode of ["start", "dev"]) {
	for (const {
		name,
		config,
		args = [],
		names,
		rawHtml = false,
		notices = true,
	} of [
		{
			name: "configured folder is shallow by default",
			config: { paths: ["content/configured"] },
			names: ["top.md"],
		},
		{
			name: "configured flags apply to explicit paths",
			config: {
				paths: ["content/configured"],
				recursive: true,
				allowHtml: true,
				hideNotices: true,
			},
			args: ["content/explicit"],
			names: ["last.md", "other.md"],
			rawHtml: true,
			notices: false,
		},
		{
			name: "CLI flags combine with configured paths",
			config: { paths: ["content/configured"] },
			args: ["--recursive", "--allow-html", "--no-notices"],
			names: ["deep.md", "top.md"],
			rawHtml: true,
			notices: false,
		},
		{
			name: "explicit file replaces configured paths",
			config: { paths: ["content/configured"] },
			args: ["content/explicit/other.md"],
			names: ["other.md"],
		},
		{
			name: "empty paths register all copies recursively",
			config: { paths: [] },
			names: ["deep.md", "last.md", "other.md", "top.md"],
		},
	]) {
		test(`${mode} config: ${name}`, { timeout: 15000 }, async () => {
			await writeFile(join(project, "dev.local.json"), JSON.stringify(config));
			const viewer = launch(mode, args);
			try {
				const { html, documents, api } = await readInitial(viewer, mode);
				assert.deepEqual(documents.map((doc) => doc.name).toSorted(), names);
				assert.ok(html.includes(`data-show-notices="${notices}"`));
				const document = await api("read", { id: documents[0].id });
				assert.equal(document.html.includes("<details>"), rawHtml);
				assert.equal(document.html.includes("&lt;details&gt;"), !rawHtml);
			} finally {
				await viewer.stop();
			}
		});
	}

	test(
		`${mode} rejects configured paths outside content`,
		{ timeout: 15000 },
		async () => {
			await writeFile(
				join(project, "dev.local.json"),
				JSON.stringify({ paths: ["outside.md"] }),
			);
			const viewer = launch(mode);
			try {
				await waitForOutput(viewer, /content\//);
				assert.doesNotMatch(viewer.output(), /Markdown viewer:|Dev ready:/);
			} finally {
				await viewer.stop();
			}
		},
	);

	test(
		`${mode} rejects invalid config even with explicit paths`,
		{ timeout: 15000 },
		async () => {
			await writeFile(
				join(project, "dev.local.json"),
				JSON.stringify({ paths: [], allowHtml: "true" }),
			);
			const viewer = launch(mode, ["content/explicit/other.md"]);
			try {
				await waitForOutput(viewer, /dev\.local\.json.*真偽値/);
				assert.doesNotMatch(viewer.output(), /Markdown viewer:|Dev ready:/);
			} finally {
				await viewer.stop();
			}
		},
	);
}
