/**
 * @file Provides a safe Markdown to HTML renderer using rehype-sanitize.
 * Allows safe HTML tags (e.g. <details>, <summary>) and prevents XSS.
 */

import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import type { AllowedHtmlTag, RenderMarkdownResult } from "./types/markdown";

/**
 * Allowed HTML tags for safe rendering.
 */
const ALLOWED_HTML_TAGS: ReadonlyArray<AllowedHtmlTag> = [
	"details",
	"summary",
	"a",
	"p",
	"ul",
	"li",
	"strong",
	"em",
	"code",
	"pre",
	"span",
	"div",
] as const;

/**
 * Extend the default rehype-sanitize schema to allow safe HTML tags.
 */
const safeSchema = {
	...defaultSchema,
	tagNames: [...(defaultSchema.tagNames ?? []), ...ALLOWED_HTML_TAGS],
};

/**
 * Converts Markdown text to safe HTML.
 * @param markdown Markdown source string
 * @returns Result containing HTML string or error
 */
export const renderMarkdownSafe = async (
	markdown: string,
): Promise<RenderMarkdownResult> => {
	try {
		const file = await unified()
			.use(remarkParse)
			.use(remarkGfm)
			.use(remarkRehype, { allowDangerousHtml: true })
			.use(rehypeRaw)
			.use(rehypeSanitize, safeSchema)
			.use(rehypeStringify)
			.process(markdown);

		return { ok: true, data: String(file) };
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error : new Error(String(error)),
		};
	}
};
