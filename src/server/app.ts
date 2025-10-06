/**
 * @file Defines the Hono application responsible for markdown viewer HTTP routes.
 */

import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { type Context, Hono } from "hono";
import { resolveProjectPath } from "../libs/directories";
import type { MarkdownViewerEnvironment } from "../runtime/environment";
import { MarkdownPathError } from "../types/markdown";
import {
	SourceRegistrationError,
	type SourceRegistrationError as SourceRegistrationErrorType,
} from "../types/source";

const HTTP_STATUS = {
	ok: 200,
	seeOther: 303,
	badRequest: 400,
	notFound: 404,
} as const;

type HttpStatus = (typeof HTTP_STATUS)[keyof typeof HTTP_STATUS];

const CONTENT_TYPE_HTML = "text/html; charset=utf-8";
const CONTENT_TYPE_BINARY = "application/octet-stream";
const CONTENT_TYPE_FORM_URLENCODED = "application/x-www-form-urlencoded";
const PATH_ROOT = "/";
const PATH_INDEX = "/index.html";
const PATH_REGISTER_SOURCE = "/sources";
const PATH_CREATE_SYMLINK = "/sources/symlink";
const PATH_VIEW = "/view";
const PATH_FILES_PATTERN = "/files/*";
const PATH_ASSETS_PATTERN = "/assets/*";
const PATH_SCRIPTS_PATTERN = "/scripts/*";
const PATH_ASSETS_PREFIX = "/assets/" as const;
const PATH_SCRIPTS_PREFIX = "/scripts/" as const;
const PUBLIC_DIRECTORY = "public" as const;
const ASSETS_DIRECTORY = "assets" as const;
const SCRIPTS_DIRECTORY = "scripts" as const;
const FORM_FIELD_DIRECTORY = "directory";
const FORM_FIELD_FILE = "file";
const FORM_FIELD_SOURCE_KEY = "sourceKey";
const FORM_FIELD_TYPE = "type";
const QUERY_DOCUMENT_PATH = "path";

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
	".css": "text/css; charset=utf-8",
	".html": CONTENT_TYPE_HTML,
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".md": "text/markdown; charset=utf-8",
	".png": "image/png",
	".svg": "image/svg+xml",
});

const describeRegistrationError = (
	error: SourceRegistrationErrorType,
): string => {
	if (error === SourceRegistrationError.StatFailed) {
		return "Unable to read directory";
	}

	return "Provided path is not a directory";
};

const describeMarkdownError = (error: MarkdownPathError): string => {
	if (error === MarkdownPathError.UnknownSource) {
		return "Unknown markdown source";
	}

	if (error === MarkdownPathError.MissingFile) {
		return "Markdown not found";
	}

	if (error === MarkdownPathError.InvalidFormat) {
		return "Invalid document path";
	}

	if (
		error === MarkdownPathError.PathTraversal ||
		error === MarkdownPathError.EscapedSource
	) {
		return "Path traversal is not allowed";
	}

	return "Unable to resolve markdown path";
};

const markdownErrorStatus = (error: MarkdownPathError): HttpStatus => {
	if (error === MarkdownPathError.MissingFile) {
		return HTTP_STATUS.notFound;
	}

	return HTTP_STATUS.badRequest;
};

const detectContentType = (filePath: string): string => {
	const extension = extname(filePath).toLowerCase();
	const match = MIME_BY_EXTENSION[extension];

	if (match) {
		return match;
	}

	return CONTENT_TYPE_BINARY;
};

const readFormField = async (
	context: Context,
	fieldName: string,
): Promise<string | null> => {
	const contentType = context.req.header("content-type") ?? "";

	if (!contentType.includes(CONTENT_TYPE_FORM_URLENCODED)) {
		return null;
	}

	const body = await context.req.parseBody();
	const field = body[fieldName];

	if (typeof field !== "string") {
		return null;
	}

	const trimmed = field.trim();

	if (trimmed === "") {
		return null;
	}

	return trimmed;
};

const respondWithFailure = (
	context: Context,
	message: string,
	status: HttpStatus,
): Response => context.text(message, status);

const stripPrefix = (value: string, prefix: string): string | null => {
	if (!value.startsWith(prefix)) {
		return null;
	}

	const stripped = value.slice(prefix.length);

	if (stripped === "") {
		return null;
	}

	return stripped;
};

const servePublicFile = async (
	context: Context,
	relativePath: string,
): Promise<Response> => {
	const absolutePath = resolveProjectPath(
		`${PUBLIC_DIRECTORY}/${relativePath}`,
	);

	try {
		const fileBuffer = await readFile(absolutePath);
		const contentType = detectContentType(absolutePath);
		const payload = new Uint8Array(fileBuffer);

		return context.body(payload, HTTP_STATUS.ok, {
			"Content-Type": contentType,
		});
	} catch {
		return respondWithFailure(context, "Asset not found", HTTP_STATUS.notFound);
	}
};

export const createMarkdownViewerApp = (
	environment: MarkdownViewerEnvironment,
): Hono => {
	const app = new Hono();

	app.get(PATH_ROOT, async (context) => {
		const html = await environment.buildIndexPage();
		return context.html(html);
	});

	app.get(PATH_INDEX, async (context) => {
		const html = await environment.buildIndexPage();
		return context.html(html);
	});

	app.post(PATH_REGISTER_SOURCE, async (context) => {
		const type = await readFormField(context, FORM_FIELD_TYPE);
		const isFile = type === "file";
		const fieldName = isFile ? FORM_FIELD_FILE : FORM_FIELD_DIRECTORY;
		const path = await readFormField(context, fieldName);

		if (!path) {
			return respondWithFailure(
				context,
				`Invalid ${isFile ? "file" : "directory"}`,
				HTTP_STATUS.badRequest,
			);
		}

		const { registerSource } = environment.useMarkdownSources();
		const registration = await registerSource(path, isFile);

		if (!registration.ok) {
			return respondWithFailure(
				context,
				describeRegistrationError(registration.error),
				HTTP_STATUS.badRequest,
			);
		}

		return context.redirect(PATH_ROOT, HTTP_STATUS.seeOther);
	});

	app.post(PATH_CREATE_SYMLINK, async (context) => {
		const sourceKey = await readFormField(context, FORM_FIELD_SOURCE_KEY);

		if (!sourceKey) {
			return respondWithFailure(
				context,
				"Invalid source key",
				HTTP_STATUS.badRequest,
			);
		}

		const { createSymlink } = environment.useMarkdownSources();
		const result = await createSymlink(sourceKey);

		if (!result.ok) {
			return respondWithFailure(
				context,
				describeRegistrationError(result.error),
				HTTP_STATUS.badRequest,
			);
		}

		return context.redirect(PATH_ROOT, HTTP_STATUS.seeOther);
	});

	app.get(PATH_VIEW, async (context) => {
		const documentPath = context.req.query(QUERY_DOCUMENT_PATH);

		if (!documentPath) {
			return respondWithFailure(
				context,
				"Missing path parameter",
				HTTP_STATUS.badRequest,
			);
		}

		const pageResult = await environment.buildMarkdownPage(documentPath);

		if (!pageResult.ok) {
			return respondWithFailure(
				context,
				describeMarkdownError(pageResult.error),
				markdownErrorStatus(pageResult.error),
			);
		}

		return context.html(pageResult.value);
	});

	app.get(PATH_FILES_PATTERN, async (context) => {
		const relativePath = context.req.param("*");

		if (!relativePath) {
			return respondWithFailure(
				context,
				"Invalid file path",
				HTTP_STATUS.badRequest,
			);
		}

		const { resolveDocument } = environment.useMarkdownDocuments();
		const resolved = await resolveDocument(relativePath);

		if (!resolved.ok) {
			return respondWithFailure(
				context,
				describeMarkdownError(resolved.error),
				markdownErrorStatus(resolved.error),
			);
		}

		const fileBuffer = await readFile(resolved.value.absolutePath);
		const contentType = detectContentType(resolved.value.absolutePath);
		const payload = new Uint8Array(fileBuffer);

		return context.body(payload, HTTP_STATUS.ok, {
			"Content-Type": contentType,
		});
	});

	app.get(PATH_ASSETS_PATTERN, async (context) => {
		const relativePath = stripPrefix(context.req.path, PATH_ASSETS_PREFIX);

		if (!relativePath) {
			return respondWithFailure(
				context,
				"Invalid asset path",
				HTTP_STATUS.badRequest,
			);
		}

		return await servePublicFile(
			context,
			`${ASSETS_DIRECTORY}/${relativePath}`,
		);
	});

	app.get(PATH_SCRIPTS_PATTERN, async (context) => {
		const relativePath = stripPrefix(context.req.path, PATH_SCRIPTS_PREFIX);

		if (!relativePath) {
			return respondWithFailure(
				context,
				"Invalid script path",
				HTTP_STATUS.badRequest,
			);
		}

		return await servePublicFile(
			context,
			`${SCRIPTS_DIRECTORY}/${relativePath}`,
		);
	});

	return app;
};
