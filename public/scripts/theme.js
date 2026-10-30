// Runs before styles render, without inline scripts or a framework.
(() => {
	let preference;
	try {
		preference = localStorage.getItem("viewer-theme");
	} catch {
		/* Storage may be disabled. */
	}
	const systemTheme = matchMedia("(prefers-color-scheme: dark)").matches
		? "dark"
		: "light";
	const hasSavedTheme = preference === "light" || preference === "dark";
	document.documentElement.dataset.theme = hasSavedTheme
		? preference
		: systemTheme;
})();
