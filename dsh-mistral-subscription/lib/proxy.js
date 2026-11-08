/**
 * Local request normalizer for the Mistral route.
 *
 * WHY: pi-ai replays session history verbatim. Two cross-provider bleed
 * failure modes hit Mistral's route:
 *
 * 1. Assistant messages from other providers carry `reasoning_content`, which
 *    Mistral rejects with `422 extra_forbidden`.
 * 2. Conversations previously run on DeepSeek/GLM models carry that family's
 *    native tool-call markup (｜DSML｜ invoke …) in assistant text. A non-DSML
 *    model imitates the pattern instead of emitting proper tool_calls, and the
 *    unparsable imitation surfaces as raw text in the transcript. For models
 *    whose ids do not start with "deepseek", the normalizer cuts assistant
 *    content at the first DSML marker, removing the imitation source.
 *
 * On top of sanitizing, the proxy fails over: a `429 backend_out_of_capacity`
 * (Mistral code 3505) or rate-limit response is retried on the next model of
 * `failoverModels` (plugin config), transparently to the caller.
 *
 * Scope guards: listens on 127.0.0.1 only, forwards `/v1/*` paths only; the
 * `Authorization` header passes through untouched (the key is never read,
 * logged, or added here); a body that does not parse as JSON forwards
 * byte-for-byte; streaming (SSE) responses pipe through chunk by chunk.
 */

import { createServer } from "node:http";
import { StringDecoder } from "node:string_decoder";
import { Readable, Transform } from "node:stream";

export const DEFAULT_PROXY_PORT = 8477;
export const UPSTREAM_ORIGIN = "https://api.mistral.ai";
/** Default failover order; the requested model is always tried first. */
export const DEFAULT_FAILOVER_MODELS = ["mistral-medium-2604", "mistral-small-latest"];

/** Fields Mistral rejects on request messages. Order irrelevant, all removed. */
const STRIPPED_FIELDS = ["reasoning_content", "reasoning", "reasoning_text"];

/** The DSML marker that opens this model family's tool-call syntax. */
const DSML_MARKER = "\uFF5CDSML\uFF5C";

const FORBIDDEN = { status: 404, body: { error: { message: "only /v1/* paths are forwarded" } } };
const POST_ONLY = { status: 405, body: { error: { message: "POST only" } } };
const BAD_GATEWAY = { status: 502, body: { error: { message: "upstream request failed" } } };

function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Removes the reasoning fields from an assistant message, in place. Returns
 * the message for chaining; non-plain values pass through untouched.
 */
export function stripReasoningFields(message) {
	if (!isPlainObject(message)) return message;
	for (const field of STRIPPED_FIELDS) delete message[field];
	return message;
}

/**
 * Cuts assistant text content at the first DSML marker, in place, so a
 * non-DSML model never sees — and never imitates — the foreign tool-call
 * syntax. String content only; array-form content blocks pass through.
 */
export function stripDsmlMarkers(message) {
	if (!isPlainObject(message) || typeof message.content !== "string") return message;
	const at = message.content.indexOf(DSML_MARKER);
	if (at >= 0) message.content = message.content.slice(0, at).trimEnd();
	return message;
}

/**
 * True when a response body is a failover-worthy Mistral error: capacity
 * exhaustion (code 3505) or a rate limit. Only the status and a shallow body
 * read happen here — error responses are small, never streams.
 */
export function isFailoverWorthy(status, bodyText) {
	if (status !== 429) return false;
	try {
		const parsed = JSON.parse(bodyText);
		const code = parsed?.code ?? parsed?.error?.code;
		const type = parsed?.type ?? parsed?.error?.type;
		return code === 3505 || type === "backend_out_of_capacity" || type === "rate_limit_error";
	} catch {
		return true; // A 429 that is not parseable is still a 429.
	}
}

/**
 * Sanitizes a request body for the model it names. Returns a Buffer (possibly
 * the input one) so the caller can always forward, plus whether anything
 * changed.
 */
export function sanitizeBody(raw) {
	let parsed;
	try {
		parsed = JSON.parse(raw.toString("utf-8"));
	} catch {
		return { body: raw, changed: false };
	}
	if (!isPlainObject(parsed) || !Array.isArray(parsed.messages)) return { body: raw, changed: false };

	const isDeepSeekFamily = typeof parsed.model === "string" && parsed.model.startsWith("deepseek");
	let changed = false;
	for (const message of parsed.messages) {
		if (!isPlainObject(message) || message.role !== "assistant") continue;
		const before = JSON.stringify(message);
		stripReasoningFields(message);
		if (!isDeepSeekFamily) stripDsmlMarkers(message);
		if (JSON.stringify(message) !== before) changed = true;
	}
	return { body: changed ? Buffer.from(JSON.stringify(parsed), "utf-8") : raw, changed };
}

/**
 * Builds the proxy server. `fetchImpl` replaces global `fetch` in tests;
 * `failoverModels` orders the 429 failover after the requested model.
 *
 * `listen(port)` resolves with the bound port. On EADDRINUSE it resolves
 * anyway WITHOUT owning the server: the holder is a previous copy of this
 * same proxy (it forwards to the same upstream), so the route keeps working
 * and `close()` must not kill it.
 */
export function createProxyServer({
	upstream = UPSTREAM_ORIGIN,
	fetchImpl = fetch,
	failoverModels = DEFAULT_FAILOVER_MODELS,
} = {}) {
	const orderedFailover = Array.isArray(failoverModels) ? failoverModels.filter((m) => typeof m === "string") : [];

	async function forward(path, headers, body) {
		return fetchImpl(`${upstream}${path}`, {
			method: "POST",
			headers,
			body: new Uint8Array(body),
		});
	}

	async function respondFromUpstream(upstreamResponse, res, model, { failover = false, consumedText } = {}) {
		const responseHeaders = { "content-type": upstreamResponse.headers.get("content-type") ?? "application/json" };
		// A failover answer names the model that actually served it; the
		// requested model is not re-announced.
		if (failover) responseHeaders["x-mistral-proxy-model"] = model;
		res.writeHead(upstreamResponse.status, responseHeaders);
		if (consumedText !== undefined) {
			// The body was read while deciding failover: replay the text.
			res.end(consumedText);
			return;
		}
		if (upstreamResponse.body === null || upstreamResponse.body === undefined) {
			res.end();
			return;
		}
		if (isGlmModel(model)) {
			// GLM responses carry content blocks pi-ai cannot parse: translate.
			if ((upstreamResponse.headers.get("content-type") ?? "").includes("text/event-stream")) {
				Readable.fromWeb(upstreamResponse.body)
					.pipe(createGlmSseTransform())
					.pipe(res)
					.on("error", () => res.end());
				return;
			}
			const text = await upstreamResponse.text();
			try {
				res.end(JSON.stringify(translateGlmResponseBody(JSON.parse(text))));
			} catch {
				res.end(text);
			}
			return;
		}
		const stream = Readable.fromWeb(upstreamResponse.body);
		stream.pipe(res);
		stream.on("error", () => {
			// Mid-stream failure after the head is sent: only the socket can end.
			res.end();
		});
	}

	const server = createServer(async (req, res) => {
		if (req.method !== "POST") {
			res.writeHead(POST_ONLY.status, { "content-type": "application/json" });
			res.end(JSON.stringify(POST_ONLY.body));
			return;
		}
		if (typeof req.url !== "string" || !(req.url === "/v1" || req.url.startsWith("/v1/"))) {
			res.writeHead(FORBIDDEN.status, { "content-type": "application/json" });
			res.end(JSON.stringify(FORBIDDEN.body));
			return;
		}

		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		const raw = Buffer.concat(chunks);
		const { body, changed } = sanitizeBody(raw);

		// Only the two headers the API needs cross the proxy: the body type and
		// the auth the harness attached. Hop-by-hop and host headers do not.
		const headers = { "content-type": req.headers["content-type"] ?? "application/json" };
		if (typeof req.headers.authorization === "string") headers.authorization = req.headers.authorization;

		// Failover candidates: the requested model first, then the configured
		// order, deduplicated. Only chat completions fail over.
		let requested;
		try {
			const parsed = JSON.parse(body.toString("utf-8"));
			requested = typeof parsed?.model === "string" ? parsed.model : undefined;
		} catch {}
		const candidates =
			req.url.includes("/chat/completions") && requested !== undefined
				? [...new Set([requested, ...orderedFailover])]
				: [requested];

		try {
			for (const [index, model] of candidates.entries()) {
				let attemptBody = body;
				if (model !== requested) {
					const parsed = JSON.parse(body.toString("utf-8"));
					parsed.model = model;
					attemptBody = Buffer.from(JSON.stringify(parsed), "utf-8");
				}
				const upstreamResponse = await forward(req.url, headers, attemptBody);
				const failover = model !== requested;
				const isLast = index === candidates.length - 1;
				if (upstreamResponse.status !== 429 || isLast) {
					// Not a 429, or every candidate failed: answer from this
					// response. A failover answer names the model that served it.
					return respondFromUpstream(upstreamResponse, res, model, { failover });
				}
				// 429 with candidates left: read the small error body, fail over
				// only when it is capacity/rate-limit shaped.
				const text = await upstreamResponse.text();
				if (!isFailoverWorthy(429, text)) {
					return respondFromUpstream(upstreamResponse, res, model, { failover, consumedText: text });
				}
			}
		} catch {
			res.writeHead(BAD_GATEWAY.status, { "content-type": "application/json" });
			res.end(JSON.stringify(BAD_GATEWAY.body));
		}
	});

	let ownsServer = false;
	return {
		server,
		listen(port = DEFAULT_PROXY_PORT) {
			return new Promise((resolve, reject) => {
				const onError = (error) => {
					if (error?.code === "EADDRINUSE") {
						// Someone (very likely a previous copy of this proxy) is already
						// bound: resolve without owning it.
						resolve({ port, alreadyRunning: true });
					} else {
						reject(error);
					}
				};
				server.once("error", onError);
				server.listen(port, "127.0.0.1", () => {
					server.removeListener("error", onError);
					ownsServer = true;
					resolve({ port: server.address().port, alreadyRunning: false });
				});
			});
		},
		close() {
			if (!ownsServer) return Promise.resolve();
			return new Promise((resolve) => server.close(() => resolve()));
		},
	};
}

/**
 * GLM content-block translation.
 *
 * Mistral serves the Z.ai GLM family with a nonstandard content shape:
 * reasoning arrives as `content` array blocks of `{type: "thinking",
 * thinking: [{type: "text", text}]}` and the answer either as a final plain
 * string chunk (stream) or a `{type: "text"}` block (non-stream). pi-ai's
 * openai-completions parser reads only STRING content, so raw GLM output
 * fails as `text-delta text must be a string`. The proxy translates: thinking
 * text maps to the standard `reasoning_content` field, text blocks and string
 * chunks stay `content`.
 */

/** Model-id prefixes whose responses carry GLM content blocks. */
const GLM_MODEL_PREFIXES = ["zai-glm", "glm-"];

export function isGlmModel(model) {
	return typeof model === "string" && GLM_MODEL_PREFIXES.some((prefix) => model.startsWith(prefix));
}

/** Splits one content-array block list into { reasoning, text } strings. */
export function translateGlmBlocks(blocks) {
	let reasoning = "";
	let text = "";
	for (const block of Array.isArray(blocks) ? blocks : []) {
		if (!isPlainObject(block)) continue;
		if (block.type === "thinking") {
			for (const part of Array.isArray(block.thinking) ? block.thinking : []) {
				if (isPlainObject(part) && typeof part.text === "string") reasoning += part.text;
			}
		} else if (typeof block.text === "string") {
			text += block.text;
		}
	}
	return { reasoning, text };
}

/** Rewrites one parsed stream chunk in place when its delta carries blocks. */
export function translateGlmStreamChunk(chunk) {
	if (!isPlainObject(chunk)) return chunk;
	for (const choice of Array.isArray(chunk.choices) ? chunk.choices : []) {
		const delta = isPlainObject(choice?.delta) ? choice.delta : null;
		if (delta === null || !Array.isArray(delta.content)) continue;
		const { reasoning, text } = translateGlmBlocks(delta.content);
		delete delta.content;
		if (reasoning) delta.reasoning_content = (delta.reasoning_content ?? "") + reasoning;
		if (text) delta.content = (delta.content ?? "") + text;
	}
	return chunk;
}

/** Rewrites one non-stream response body in place. */
export function translateGlmResponseBody(payload) {
	if (!isPlainObject(payload)) return payload;
	for (const choice of Array.isArray(payload.choices) ? payload.choices : []) {
		const message = isPlainObject(choice?.message) ? choice.message : null;
		if (message === null || !Array.isArray(message.content)) continue;
		const { reasoning, text } = translateGlmBlocks(message.content);
		delete message.content;
		if (reasoning) message.reasoning_content = (message.reasoning_content ?? "") + reasoning;
		if (text) message.content = (message.content ?? "") + text;
	}
	return payload;
}

/**
 * A line-buffered Transform for SSE bodies: complete lines are translated
 * when they carry a `data:` JSON payload; everything else passes through.
 */
export function createGlmSseTransform() {
	const decoder = new StringDecoder("utf-8");
	let rest = "";
	function translateLine(line) {
		if (!line.startsWith("data: ") || line === "data: [DONE]") return line;
		try {
			return `data: ${JSON.stringify(translateGlmStreamChunk(JSON.parse(line.slice(6))))}`;
		} catch {
			return line;
		}
	}
	return new Transform({
		transform(chunk, _encoding, callback) {
			// StringDecoder carries partial multi-byte sequences across chunks;
			// only COMPLETE lines are translated, every "\n" is re-emitted so
			// event boundaries survive chunk splits (an eaten blank line merges
			// two events and the client sees one unparseable data payload).
			rest += decoder.write(chunk);
			let out = "";
			let at;
			while ((at = rest.indexOf("\n")) >= 0) {
				const line = rest.slice(0, at);
				rest = rest.slice(at + 1);
				out += `${translateLine(line)}\n`;
			}
			callback(null, out);
		},
		flush(callback) {
			callback(null, decoder.end() + rest);
		},
	});
}
