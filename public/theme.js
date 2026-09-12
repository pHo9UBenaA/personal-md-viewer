// Runs before styles render, without inline scripts or a framework.
(() => {
	let preference;
	try {
		preference = localStorage.getItem("viewer-theme");
	} catch {
		/* Storage may be disabled. */
	}
	document.documentElement.dataset.theme =
		preference === "light" || preference === "dark"
			? preference
			: matchMedia("(prefers-color-scheme: dark)").matches
				? "dark"
				: "light";
})();
