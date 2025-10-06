/**
 * @file Exposes helpers for rendering base HTML layout shared by viewer pages.
 */

const GLOBAL_STYLES_HREF = "/assets/global.css" as const;
const SCRIPT_TYPE_MODULE = "module";
const MERMAID_SCRIPT_SRC = "/scripts/mermaid.client.js" as const;

type LayoutOptions = {
	readonly baseHref?: string;
};

/**
 * Renders the shared HTML page structure with optional base href.
 */
export const renderLayout = async (
	title: string,
	content: string,
	options: LayoutOptions = {},
): Promise<string> => {
	const baseTag = options.baseHref ? `<base href="${options.baseHref}">\n` : "";

	return [
		"<!doctype html>",
		"<html>",
		"  <head>",
		'    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
		'    <meta charset="utf-8" />',
		`    <title>${title}</title>`,
		`    ${baseTag}`,
		`    <link rel="stylesheet" href="${GLOBAL_STYLES_HREF}" />`,
		"  </head>",
		"  <body>",
		"    <main>",
		`      ${content}`,
		"    </main>",
		`    <script type="${SCRIPT_TYPE_MODULE}" src="${MERMAID_SCRIPT_SRC}" defer></script>`,
		"  </body>",
		"</html>",
	].join("\n");
};
