import MarkdownIt from "markdown-it";

// No raw HTML, third-party plugins, remote resources, or custom highlight HTML.
const parser = new MarkdownIt({
	html: false,
	linkify: false,
	typographer: false,
	maxNesting: 50,
});
// Keep every URL inert until the reader explicitly handles it. In particular,
// parsing a detached HTML document must not start remote image requests.
parser.renderer.rules.image = (tokens, index, options, _env, renderer) => {
	const token = tokens[index];
	token.attrSet("data-image", token.attrGet("src") ?? "");
	token.attrs = token.attrs.filter(([name]) => name !== "src");
	token.attrSet(
		"alt",
		renderer.renderInlineAsText(token.children ?? [], options, {}),
	);
	return renderer.renderToken(tokens, index, options);
};
parser.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
	const token = tokens[index];
	token.attrSet("data-link", token.attrGet("href") ?? "");
	token.attrs = token.attrs.filter(([name]) => name !== "href");
	return renderer.renderToken(tokens, index, options);
};
export const renderMarkdown = (source) => parser.render(source);
