import assert from "node:assert/strict";
import { test } from "node:test";
import {
	documentKeysFromTree,
	findDocuments,
	treeFromDocuments,
} from "../../public/scripts/documents.js";

const documents = new Map([
	["first", { label: "notes/First.md", path: "/content/読書/First.md" }],
	["second", { label: "notes/Second.md", path: "/content/work/Second.md" }],
	["third", { label: "Third.markdown" }],
]);

test("findDocuments matches labels and paths, ignoring case and surrounding whitespace", () => {
	assert.deepEqual(findDocuments(documents, "  FIRST.MD  "), [
		["first", documents.get("first")],
	]);
	assert.deepEqual(findDocuments(documents, "読書"), [
		["first", documents.get("first")],
	]);
	assert.deepEqual(findDocuments(documents, "THIRD"), [
		["third", documents.get("third")],
	]);
});

test("findDocuments returns every document for a blank tree filter and none for an unmatched query", () => {
	assert.deepEqual(findDocuments(documents, "  "), [...documents]);
	assert.deepEqual(findDocuments(documents, "missing"), []);
	assert.deepEqual(findDocuments(new Map(), "notes"), []);
});

test("findDocuments limits matches in registration order without scanning later entries", () => {
	function* entries() {
		yield ["unmatched", { label: "Other.md" }];
		yield* documents;
		throw new Error("The search continued after reaching its result limit");
	}
	assert.deepEqual(findDocuments(entries(), "notes", 2), [
		["first", documents.get("first")],
		["second", documents.get("second")],
	]);
	assert.deepEqual(findDocuments(documents, "notes", 0), []);
});

test("treeFromDocuments groups files under their root and reuses nested folders", () => {
	const first = { root: "/content/notes", label: "nested/First.md" };
	const second = { root: "/content/notes", label: "nested/Second.md" };
	const input = new Map([
		["first", first],
		["second", second],
	]);
	const tree = treeFromDocuments(input);
	assert.equal(tree.directories.size, 1);
	assert.deepEqual(tree.files, []);
	const root = tree.directories.get("root:/content/notes");
	assert.equal(root.name, "notes");
	assert.equal(root.directories.size, 1);
	assert.deepEqual(root.directories.get("nested").files, [
		{ key: "first", doc: first, name: "First.md" },
		{ key: "second", doc: second, name: "Second.md" },
	]);
	assert.equal(input.get("first"), first);
	assert.equal(first.label, "nested/First.md");
});

test("treeFromDocuments keeps equal folder names in different roots separate", () => {
	const tree = treeFromDocuments([
		["first", { root: "/content/one/notes", label: "First.md" }],
		["second", { root: "/content/two/notes", label: "Second.md" }],
	]);
	assert.equal(tree.directories.size, 2);
	const first = tree.directories.get("root:/content/one/notes");
	const second = tree.directories.get("root:/content/two/notes");
	assert.equal(first.name, "notes");
	assert.equal(second.name, "notes");
	assert.equal(first.files[0].key, "first");
	assert.equal(second.files[0].key, "second");
});

test("treeFromDocuments accepts Windows separators and preserves special filename characters", () => {
	const doc = {
		root: "C:\\content\\読書",
		label: "nested\\日本語 # %.md",
	};
	const tree = treeFromDocuments([["document", doc]]);
	const root = tree.directories.get("root:C:\\content\\読書");
	assert.equal(root.name, "読書");
	assert.deepEqual(root.directories.get("nested").files, [
		{ key: "document", doc, name: "日本語 # %.md" },
	]);
});

test("documentKeysFromTree follows sorted folders then sorted files", () => {
	const tree = treeFromDocuments([
		["root-z", { root: "/content", label: "z.md" }],
		["folder-z", { root: "/content", label: "z/c.md" }],
		["folder-a-b", { root: "/content", label: "a/b.md" }],
		["root-a", { root: "/content", label: "a.md" }],
		["folder-a-a", { root: "/content", label: "a/a.md" }],
	]);
	assert.deepEqual(documentKeysFromTree(tree), [
		"folder-a-a",
		"folder-a-b",
		"folder-z",
		"root-a",
		"root-z",
	]);
	assert.deepEqual(documentKeysFromTree(treeFromDocuments([])), []);
});

test("treeFromDocuments supports ungrouped files and falls back to the document name", () => {
	const doc = { label: "", name: "Untitled.md" };
	const tree = treeFromDocuments([["document", doc]]);
	assert.equal(tree.directories.size, 0);
	assert.deepEqual(tree.files, [{ key: "document", doc, name: "Untitled.md" }]);
	assert.deepEqual(treeFromDocuments([]), {
		directories: new Map(),
		files: [],
	});
});
