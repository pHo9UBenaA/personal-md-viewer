import assert from "node:assert/strict";
import { test } from "node:test";
import { TabSelection } from "../../public/scripts/tabs.js";

const keys = ["a", "b", "c", "d"];

test("Shift selection extends from the original anchor in either direction", () => {
	const selection = new TabSelection();
	selection.selectOnly("b");
	selection.selectRange("d", keys);
	assert.deepEqual([...selection.keys], ["b", "c", "d"]);
	selection.selectRange("a", keys);
	assert.deepEqual([...selection.keys], ["a", "b"]);
	assert.equal(selection.anchor, "b");
});

test("normal selection replaces the range and establishes a new anchor", () => {
	const selection = new TabSelection();
	selection.selectOnly("a");
	selection.selectRange("c", keys);
	selection.selectOnly("d");
	assert.deepEqual([...selection.keys], ["d"]);
	assert.equal(selection.anchor, "d");
});

test("closing tabs retains live selections and falls back to the active tab", () => {
	const selection = new TabSelection();
	selection.selectOnly("a");
	selection.selectRange("c", keys);
	selection.retain(["b", "d"], "d");
	assert.deepEqual([...selection.keys], ["b"]);
	assert.equal(selection.anchor, "d");
	selection.retain(["d"], "d");
	assert.deepEqual([...selection.keys], ["d"]);
	selection.selectOnly(null);
	selection.retain([], null);
	assert.deepEqual([...selection.keys], []);
});

test("a missing anchor starts a new range at the selected tab", () => {
	const selection = new TabSelection();
	selection.selectRange("c", keys);
	assert.deepEqual([...selection.keys], ["c"]);
	assert.equal(selection.anchor, "c");
});
