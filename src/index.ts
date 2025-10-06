/**
 * @file Boots the Node.js HTTP server and forwards requests to the Hono application.
 */

import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { TLSSocket } from "node:tls";
import { createMarkdownViewerEnvironment } from "./runtime/environment";
import { createMarkdownViewerApp } from "./server/app";

const HTTP_STATUS: Readonly<{
	ok: number;
	internalError: number;
}> = Object.freeze({
	ok: 200,
	internalError: 500,
});

const METHOD_GET = "GET";
const METHOD_HEAD = "HEAD";
const PATH_ROOT = "/";
const PORT_FALLBACK = 3000;
const HOST_FALLBACK = "localhost";
const PROTOCOL_HTTP = "http";
const PROTOCOL_HTTPS = "https";

const environment = createMarkdownViewerEnvironment();
environment.sources.resetSources();

const app = createMarkdownViewerApp(environment);

const isBodylessMethod = (method: string): boolean => {
	return method === METHOD_GET || method === METHOD_HEAD;
};

const readIncomingBody = async (
	incoming: IncomingMessage,
): Promise<Uint8Array> => {
	const buffers: Buffer[] = [];
	for await (const chunk of incoming) {
		if (typeof chunk === "undefined") {
			continue;
		}

		if (typeof chunk === "string") {
			buffers.push(Buffer.from(chunk));
			continue;
		}

		if (chunk instanceof Buffer) {
			buffers.push(chunk);
			continue;
		}

		buffers.push(Buffer.from(chunk));
	}

	if (buffers.length === 0) {
		return new Uint8Array();
	}

	const combined = Buffer.concat(buffers);
	return new Uint8Array(combined);
};

/**
 * Derives the protocol portion for building absolute request URLs.
 */
const deriveRequestProtocol = (socket: IncomingMessage["socket"]): string => {
	return socket instanceof TLSSocket ? PROTOCOL_HTTPS : PROTOCOL_HTTP;
};

const normalisePort = (rawPort: string | undefined): number => {
	if (!rawPort) {
		return PORT_FALLBACK;
	}

	const parsed = Number(rawPort);

	if (!Number.isInteger(parsed) || parsed <= 0) {
		return PORT_FALLBACK;
	}

	return parsed;
};

const buildRequestFromIncomingMessage = async (
	incoming: IncomingMessage,
): Promise<Request> => {
	const method = incoming.method ?? METHOD_GET;
	const protocol = deriveRequestProtocol(incoming.socket);
	const host = incoming.headers.host ?? HOST_FALLBACK;
	const rawUrl = incoming.url ?? PATH_ROOT;
	const requestUrl = new URL(rawUrl, `${protocol}://${host}`);
	const headers = new Headers();

	for (const [key, value] of Object.entries(incoming.headers)) {
		if (typeof value === "undefined") {
			continue;
		}

		if (Array.isArray(value)) {
			for (const entry of value) {
				headers.append(key, entry);
			}
			continue;
		}

		headers.append(key, value);
	}

	const baseInit: RequestInit = {
		method,
		headers,
	};

	if (isBodylessMethod(method)) {
		return new Request(requestUrl, baseInit);
	}

	const bodyBytes = await readIncomingBody(incoming);

	return new Request(requestUrl, {
		...baseInit,
		body: bodyBytes,
	});
};

const sendResponseToClient = async (
	client: ServerResponse,
	response: Response,
): Promise<void> => {
	const headers: Record<string, string> = {};
	response.headers.forEach((value, key) => {
		headers[key] = value;
	});

	client.writeHead(response.status, headers);

	if (!response.body) {
		client.end();
		return;
	}

	const arrayBuffer = await response.arrayBuffer();
	const buffer = Buffer.from(arrayBuffer);
	client.end(buffer);
};

const port = normalisePort(process.env.PORT);

const server = createServer(async (incomingRequest, serverResponse) => {
	try {
		const request = await buildRequestFromIncomingMessage(incomingRequest);
		const response = await app.fetch(request);
		await sendResponseToClient(serverResponse, response);
	} catch (error) {
		console.error("Unexpected error", error);
		const fallback = new Response("Internal server error", {
			status: HTTP_STATUS.internalError,
		});
		await sendResponseToClient(serverResponse, fallback);
	}
});

server.listen(port, () => {
	const address = server.address();
	const resolvedPort =
		typeof address === "object" && address !== null ? address.port : port;

	console.log(
		`Markdown viewer running at http://${HOST_FALLBACK}:${resolvedPort}`,
	);
});
