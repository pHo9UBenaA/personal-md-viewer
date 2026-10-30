export async function command(
	page,
	key,
	{ shift = false, target = "document", composing = false } = {},
) {
	return page.evaluate(
		({ key, shift, target, composing }) => {
			const element =
				target === "reader"
					? document.getElementById("content").contentDocument.body
					: target === "input"
						? document.getElementById("find-query")
						: document;
			return !element.dispatchEvent(
				new KeyboardEvent("keydown", {
					key,
					metaKey: true,
					shiftKey: shift,
					isComposing: composing,
					bubbles: true,
					cancelable: true,
				}),
			);
		},
		{ key, shift, target, composing },
	);
}
