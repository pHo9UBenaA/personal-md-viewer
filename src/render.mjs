import MarkdownIt from "markdown-it";
import { renderHighlightTags } from "./highlights.mjs";

const COMMENT_OPEN = "<!--";
const COMMENT_CLOSE = "-->";

function skipBlockComment(state, startLine, endLine, silent) {
	const startOffset = state.bMarks[startLine] + state.tShift[startLine];
	if (!state.src.startsWith(COMMENT_OPEN, startOffset)) return false;
	const closeOffset = state.src.indexOf(
		COMMENT_CLOSE,
		startOffset + COMMENT_OPEN.length,
	);
	if (closeOffset < 0) return false;
	let closeLine = startLine;
	while (closeLine < endLine && closeOffset >= state.eMarks[closeLine])
		closeLine++;
	if (closeLine === endLine) return false;

	const afterCommentOffset = closeOffset + COMMENT_CLOSE.length;
	const trailingText = state.src.slice(
		afterCommentOffset,
		state.eMarks[closeLine],
	);
	if (trailingText.trim()) {
		// Single-line comments with text belong to the inline rule.
		if (closeLine === startLine) return false;
		if (!silent) {
			// Resume parsing the text after a multiline comment instead of dropping its line.
			state.bMarks[closeLine] = afterCommentOffset;
			state.tShift[closeLine] =
				trailingText.length - trailingText.trimStart().length;
			state.sCount[closeLine] = state.tShift[closeLine];
			state.line = closeLine;
		}
		return true;
	}
	if (!silent) state.line = closeLine + 1;
	return true;
}

function skipInlineComment(state) {
	if (!state.src.startsWith(COMMENT_OPEN, state.pos)) return false;
	const closeOffset = state.src.indexOf(
		COMMENT_CLOSE,
		state.pos + COMMENT_OPEN.length,
	);
	if (closeOffset < 0) return false;
	state.pos = closeOffset + COMMENT_CLOSE.length;
	return true;
}

function createParser(allowHtml) {
	const parser = new MarkdownIt({
		html: allowHtml,
		linkify: false,
		typographer: false,
		maxNesting: 50,
	});
	// Block comments may contain blank lines; code and fences run before this rule.
	parser.block.ruler.before(
		"html_block",
		"html_comment_block",
		skipBlockComment,
	);
	parser.inline.ruler.before("text", "html_comment_inline", skipInlineComment);

	// Keep Markdown URLs inert until the reader handles them. Opt-in raw HTML bypasses these rules.
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

const escapedHtmlParser = createParser(false);
const rawHtmlParser = createParser(true);
export function renderMarkdown(source, { allowHtml = false } = {}) {
	const parser = allowHtml ? rawHtmlParser : escapedHtmlParser;
	return renderHighlightTags(parser.render(source));
}
