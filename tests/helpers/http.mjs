import { once } from "node:events";
import { request } from "node:http";

export async function listenOnLoopback(server) {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return `http://127.0.0.1:${server.address().port}`;
}

export async function closeServer(server) {
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
}

// Node's HTTP client preserves the exact Host header needed by proxy/security tests.
export function requestWithExactHost(url, options = {}) {
	return new Promise((resolve, reject) => {
		const outgoing = request(url, options, (response) => {
			const chunks = [];
			response.on("data", (chunk) => chunks.push(chunk));
			response.on("end", () =>
				resolve(
					new Response(Buffer.concat(chunks), { status: response.statusCode }),
				),
			);
			response.on("error", reject);
		});
		outgoing.on("error", reject);
		outgoing.end(options.body);
	});
}
