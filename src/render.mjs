import MarkdownIt from "markdown-it";

function createParser(allowHtml) {
	const parser = new MarkdownIt({
		html: allowHtml,
		linkify: false,
		typographer: false,
		maxNesting: 50,
	});
	// Comments should not appear in the rendered output. The block rule also
	// covers comments containing blank lines; code and fences run before it.
	parser.block.ruler.before(
		"html_block",
		"html_comment_block",
		(state, startLine, endLine, silent) => {
			const start = state.bMarks[startLine] + state.tShift[startLine];
			if (!state.src.startsWith("<!--", start)) return false;
			const close = state.src.indexOf("-->", start + 4);
			if (close < 0) return false;
			let closeLine = startLine;
			while (closeLine < endLine && close >= state.eMarks[closeLine])
				closeLine++;
			if (closeLine === endLine) return false;
			const tail = state.src.slice(close + 3, state.eMarks[closeLine]);
			if (tail.trim()) {
				if (closeLine === startLine) return false;
				if (!silent) {
					state.bMarks[closeLine] = close + 3;
					state.tShift[closeLine] = tail.length - tail.trimStart().length;
					state.sCount[closeLine] = state.tShift[closeLine];
					state.line = closeLine;
				}
				return true;
			}
			if (!silent) state.line = closeLine + 1;
			return true;
		},
	);
	parser.inline.ruler.before("text", "html_comment_inline", (state) => {
		if (!state.src.startsWith("<!--", state.pos)) return false;
		const close = state.src.indexOf("-->", state.pos + 4);
		if (close < 0) return false;
		state.pos = close + 3;
		return true;
	});
	// Keep Markdown URLs inert until the reader explicitly handles them. Raw
	// HTML is permitted only when the caller opts in for trusted documents.
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
	parser.renderer.rules.link_open = (
		tokens,
		index,
		options,
		_env,
		renderer,
	) => {
		const token = tokens[index];
		token.attrSet("data-link", token.attrGet("href") ?? "");
		token.attrs = token.attrs.filter(([name]) => name !== "href");
		return renderer.renderToken(tokens, index, options);
	};
	return parser;
}

const safeParser = createParser(false);
const htmlParser = createParser(true);
export const renderMarkdown = (source, { allowHtml = false } = {}) =>
	(allowHtml ? htmlParser : safeParser).render(source);
