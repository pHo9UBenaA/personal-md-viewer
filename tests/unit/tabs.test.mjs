import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createTabSelection,
	retainTabSelection,
	selectTabRange,
} from "../../public/scripts/tabs.js";

const keys = Object.freeze(["a", "b", "c", "d"]);

test("createTabSelection creates independent empty selections", () => {
	const selection = createTabSelection();
	const other = createTabSelection();
	assert.deepEqual(selection, { keys: new Set(), anchor: null });
	assert.notStrictEqual(selection, other);
	assert.notStrictEqual(selection.keys, other.keys);
});

test("Shift selection extends from the original anchor in either direction without changing earlier selections", () => {
	const initial = Object.freeze(createTabSelection("b"));
	const rightRange = Object.freeze(selectTabRange(initial, "d", keys));
	const leftRange = selectTabRange(rightRange, "a", keys);
	assert.deepEqual([...initial.keys], ["b"]);
	assert.deepEqual([...rightRange.keys], ["b", "c", "d"]);
	assert.deepEqual([...leftRange.keys], ["a", "b"]);
	assert.equal(leftRange.anchor, "b");
	assert.deepEqual(keys, ["a", "b", "c", "d"]);
});

test("normal selection replaces the range and establishes a new anchor", () => {
	const range = selectTabRange(createTabSelection("a"), "c", keys);
	const selection = createTabSelection("d");
	assert.deepEqual(selection, { keys: new Set(["d"]), anchor: "d" });
	assert.deepEqual([...range.keys], ["a", "b", "c"]);
});

test("selecting a null key clears the selection and anchor", () => {
	assert.deepEqual(createTabSelection(null), {
		keys: new Set(),
		anchor: null,
	});
});

test("closing tabs retains live selections without changing the original range", () => {
	const range = Object.freeze(
		selectTabRange(createTabSelection("a"), "c", keys),
	);
	const remainingKeys = Object.freeze(["b", "d"]);
	const selection = retainTabSelection(range, remainingKeys, "d");
	assert.deepEqual(selection, { keys: new Set(["b"]), anchor: "d" });
	assert.deepEqual(range, {
		keys: new Set(["a", "b", "c"]),
		anchor: "a",
	});
	assert.deepEqual(remainingKeys, ["b", "d"]);
});

test("closing all selected tabs falls back to the active tab", () => {
	const initial = Object.freeze(createTabSelection("b"));
	const selection = retainTabSelection(initial, ["d"], "d");
	assert.deepEqual(selection, { keys: new Set(["d"]), anchor: "d" });
	assert.deepEqual(initial, { keys: new Set(["b"]), anchor: "b" });
});

test("closing the last tab clears the selection and anchor", () => {
	const initial = createTabSelection("a");
	const selection = retainTabSelection(initial, [], null);
	assert.deepEqual(selection, { keys: new Set(), anchor: null });
	assert.deepEqual(initial, { keys: new Set(["a"]), anchor: "a" });
});

test("retaining a selection preserves a live anchor and follows the current tab order", () => {
	const range = selectTabRange(createTabSelection("a"), "c", keys);
	const selection = retainTabSelection(range, ["c", "b", "a", "d"], "d");
	assert.deepEqual([...selection.keys], ["c", "b", "a"]);
	assert.equal(selection.anchor, "a");
	assert.deepEqual([...range.keys], ["a", "b", "c"]);
});

test("a missing anchor starts a new range at the selected tab", () => {
	const selection = selectTabRange(createTabSelection(), "c", keys);
	assert.deepEqual(selection, { keys: new Set(["c"]), anchor: "c" });
});

test("an anchor absent from the tab order starts a new range at the selected tab", () => {
	const initial = createTabSelection("closed");
	const selection = selectTabRange(initial, "c", keys);
	assert.deepEqual(selection, { keys: new Set(["c"]), anchor: "c" });
	assert.deepEqual(initial, { keys: new Set(["closed"]), anchor: "closed" });
});

test("a range endpoint absent from the tab order falls back to a single selection", () => {
	const initial = createTabSelection("b");
	const selection = selectTabRange(initial, "missing", keys);
	assert.deepEqual(selection, {
		keys: new Set(["missing"]),
		anchor: "missing",
	});
	assert.deepEqual(initial, { keys: new Set(["b"]), anchor: "b" });
});
