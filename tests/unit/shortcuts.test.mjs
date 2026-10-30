import assert from "node:assert/strict";
import { test } from "node:test";
import { createShortcutHandler } from "../../public/scripts/shortcuts.js";

function keyboard({ dialog = false, active = true, palette = false } = {}) {
	const calls = [];
	const actions = Object.fromEntries(
		[
			"openPalette",
			"toggleSidebar",
			"reopenClosedTabs",
			"toggleSource",
			"openSearch",
			"stepSearch",
			"cycleTab",
			"toggleTreeFocus",
			"closeSelectedTabs",
			"reloadTab",
			"focusTreeFilter",
			"toggleFocusMode",
			"dismiss",
		].map((name) => [name, (...args) => calls.push([name, ...args])]),
	);
	const handle = createShortcutHandler({
		...actions,
		hasActive: () => active,
		isDialogOpen: () => dialog,
		isPaletteOpen: () => palette,
	});
	return {
		calls,
		press(key, options = {}) {
			const event = {
				key,
				metaKey: true,
				ctrlKey: false,
				shiftKey: false,
				altKey: false,
				target: { isContentEditable: false, closest: () => null },
				defaultPrevented: false,
				preventDefault() {
					this.defaultPrevented = true;
				},
				...options,
			};
			handle(event);
			return event.defaultPrevented;
		},
	};
}

test("shortcut routing names the action without accessing application state or DOM", () => {
	for (const [key, options, expected] of [
		["p", {}, ["openPalette"]],
		["P", { shiftKey: true }, ["openPalette"]],
		["b", {}, ["toggleSidebar"]],
		["t", { shiftKey: true }, ["reopenClosedTabs"]],
		["v", { shiftKey: true }, ["toggleSource", { focusReader: true }]],
		["f", {}, ["openSearch"]],
		["g", {}, ["stepSearch", 1]],
		["g", { shiftKey: true }, ["stepSearch", -1]],
		["Tab", { metaKey: false, ctrlKey: true }, ["cycleTab", 1]],
		[
			"Tab",
			{ metaKey: false, ctrlKey: true, shiftKey: true },
			["cycleTab", -1],
		],
		["@", { metaKey: false, ctrlKey: true }, ["toggleTreeFocus"]],
		[
			"2",
			{ metaKey: false, ctrlKey: true, shiftKey: true, code: "Digit2" },
			["toggleTreeFocus"],
		],
		["w", {}, ["closeSelectedTabs"]],
		["r", {}, ["reloadTab"]],
		["/", { metaKey: false }, ["focusTreeFilter"]],
		["f", { shiftKey: true }, ["toggleFocusMode"]],
	]) {
		const keys = keyboard();
		assert.equal(keys.press(key, options), true, key);
		assert.deepEqual(keys.calls, [expected], key);
	}
});

test("dialogs suppress reserved actions but allow reopening their own palette", () => {
	for (const [key, options] of [
		["w", {}],
		["r", {}],
		["b", {}],
		["t", { shiftKey: true }],
		["f", {}],
		["g", {}],
		["Tab", { metaKey: false, ctrlKey: true }],
	]) {
		const keys = keyboard({ dialog: true });
		assert.equal(keys.press(key, options), true);
		assert.deepEqual(keys.calls, []);
	}
	const palette = keyboard({ dialog: true, palette: true });
	palette.press("p", { shiftKey: true });
	assert.deepEqual(palette.calls, [["openPalette"]]);
});

test("IME, editable fields and unbound modifiers retain their normal behavior", () => {
	for (const options of [
		{ isComposing: true },
		{ keyCode: 229 },
		{ altKey: true },
	]) {
		const keys = keyboard();
		assert.equal(keys.press("b", options), false);
		assert.deepEqual(keys.calls, []);
	}
	for (const target of [{ isContentEditable: true }, { closest: () => ({}) }]) {
		for (const [key, shiftKey] of [
			["b", false],
			["v", true],
		]) {
			const keys = keyboard();
			assert.equal(keys.press(key, { target, shiftKey }), false);
			assert.deepEqual(keys.calls, []);
		}
	}
	const keys = keyboard();
	assert.equal(keys.press("[", { metaKey: false, ctrlKey: true }), false);
	assert.deepEqual(keys.calls, []);
});

test("inactive documents do not invoke reader operations and Escape delegates dismissal", () => {
	const keys = keyboard({ active: false });
	for (const key of ["f", "g"]) keys.press(key);
	keys.press("v", { shiftKey: true });
	assert.deepEqual(keys.calls, []);
	keys.press("Escape", { metaKey: false });
	assert.deepEqual(keys.calls, [["dismiss"]]);
});
