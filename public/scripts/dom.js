export const byId = (id) => document.getElementById(id);

export function createButton(text, click, className) {
	const node = document.createElement("button");
	node.type = "button";
	node.textContent = text;
	if (className) node.className = className;
	node.addEventListener("click", click);
	return node;
}
