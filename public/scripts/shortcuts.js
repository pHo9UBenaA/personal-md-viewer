export function createShortcutHandler(actions) {
	return function shortcuts(event) {
		if (event.defaultPrevented || event.isComposing || event.keyCode === 229)
			return;
		const key = event.key.toLowerCase();
		const dialogOpen = actions.isDialogOpen();
		const editable =
			event.target.isContentEditable ||
			event.target.closest?.("input, textarea, select");
		const isCommand = (event.metaKey || event.ctrlKey) && !event.altKey;
		if (isCommand && !event.shiftKey && key === "p") {
			event.preventDefault();
			if (!dialogOpen) actions.openPalette();
			return;
		}
		if (isCommand && !event.shiftKey && key === "b" && !editable) {
			event.preventDefault();
			if (!dialogOpen && !event.repeat) actions.toggleSidebar();
			return;
		}
		if (isCommand && event.shiftKey && key === "t") {
			event.preventDefault();
			if (!dialogOpen && !event.repeat) actions.reopenClosedTabs();
			return;
		}
		if (isCommand && event.shiftKey && key === "v" && !editable) {
			event.preventDefault();
			if (!dialogOpen && actions.hasActive() && !event.repeat)
				actions.toggleSource({ focusReader: true });
			return;
		}
		if (isCommand && !event.shiftKey && key === "f") {
			event.preventDefault();
			if (!dialogOpen && actions.hasActive()) actions.openSearch();
			return;
		}
		if (isCommand && key === "g") {
			event.preventDefault();
			if (!dialogOpen && actions.hasActive())
				actions.stepSearch(event.shiftKey ? -1 : 1);
			return;
		}
		const controlOnly = event.ctrlKey && !event.metaKey && !event.altKey;
		if (controlOnly && key === "tab") {
			event.preventDefault();
			if (!dialogOpen) actions.cycleTab(event.shiftKey ? -1 : 1);
			return;
		}
		// JIS has an @ key; US layouts use Shift+2. Do not bind Ctrl+[ on US layouts.
		if (
			controlOnly &&
			(key === "@" || (event.code === "Digit2" && event.shiftKey))
		) {
			event.preventDefault();
			if (!dialogOpen && !event.repeat) {
				actions.toggleTreeFocus();
			}
			return;
		}
		if (
			isCommand &&
			!event.shiftKey &&
			(key === "w" || event.code === "KeyW")
		) {
			event.preventDefault();
			if (!event.repeat && !dialogOpen) actions.closeSelectedTabs();
			return;
		}
		if (
			isCommand &&
			!event.shiftKey &&
			(key === "r" || event.code === "KeyR")
		) {
			event.preventDefault();
			if (!event.repeat && !dialogOpen) actions.reloadTab();
			return;
		}
		if (
			key === "/" &&
			!event.metaKey &&
			!event.ctrlKey &&
			!event.altKey &&
			!editable &&
			!dialogOpen
		) {
			event.preventDefault();
			actions.focusTreeFilter();
			return;
		}
		const isCommandShift =
			(event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey;
		if (isCommandShift && key === "f") {
			event.preventDefault();
			if (!actions.hasActive() || dialogOpen) return;
			actions.toggleFocusMode();
			return;
		}
		if (event.key === "Escape" && !dialogOpen) {
			actions.dismiss();
			return;
		}
		if (isCommandShift && key === "p") {
			event.preventDefault();
			if (!dialogOpen || actions.isPaletteOpen()) actions.openPalette();
		}
	};
}
