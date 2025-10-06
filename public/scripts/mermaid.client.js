/**
 * @file Bootstraps Mermaid diagrams in rendered markdown pages using a locally bundled ESM build.
 */

const MERMAID_MODULE_PATH = "/scripts/mermaid/mermaid.esm.min.mjs";
const CANDIDATE_SELECTOR = ["pre code", "article div", "article p"];
const MERMAID_CONTAINER_CLASS = "mermaid-diagram";
const CSS_CLASS_SELECTOR = `.${MERMAID_CONTAINER_CLASS}`;
const MERMAID_PATTERN =
	/^(graph|flowchart|sequenceDiagram|stateDiagram|classDiagram|gitGraph|gantt|pie|quadrantChart|info|erDiagram|journey|mindmap|timeline|requirement|c4|xychart)\b/;

const isElement = (node) => node instanceof HTMLElement;

const findMermaidSourceElements = () => {
	const candidates = CANDIDATE_SELECTOR.flatMap((selector) =>
		Array.from(document.querySelectorAll(selector)),
	);

	return candidates.filter((node) => {
		if (!isElement(node)) {
			return false;
		}

		if (node.closest(CSS_CLASS_SELECTOR)) {
			return false;
		}

		if (node.children.length > 0) {
			return false;
		}

		const content = node.textContent;
		if (!content) {
			return false;
		}

		return MERMAID_PATTERN.test(content.trim());
	});
};

const replaceWithContainer = (node) => {
	const content = node.textContent;
	if (!content) {
		return false;
	}

	const container = document.createElement("div");
	container.className = MERMAID_CONTAINER_CLASS;
	container.textContent = content.trim();

	const parent = node.parentElement;
	if (parent && parent.tagName.toLowerCase() === "pre") {
		parent.replaceWith(container);
		return true;
	}

	node.replaceWith(container);
	return true;
};

const initialiseMermaid = async () => {
	const mermaidNodes = findMermaidSourceElements();
	if (mermaidNodes.length === 0) {
		return;
	}

	let upgradedCount = 0;
	mermaidNodes.forEach((node) => {
		const replaced = replaceWithContainer(node);
		if (replaced) {
			upgradedCount += 1;
		}
	});

	if (upgradedCount === 0) {
		return;
	}

	const mermaidModule = await import(MERMAID_MODULE_PATH);
	const mermaid = mermaidModule?.default;
	if (!mermaid) {
		return;
	}

	mermaid.initialize({ startOnLoad: false });
	await mermaid.run({
		querySelector: CSS_CLASS_SELECTOR,
	});
};

void initialiseMermaid();
