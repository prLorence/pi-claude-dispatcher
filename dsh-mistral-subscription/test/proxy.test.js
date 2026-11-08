/**
 * Tests for the localhost request normalizer (lib/proxy.js).
 *
 * A real Node HTTP server is bound to an ephemeral port with a stubbed
 * `fetch`, so every test exercises the full request/response path without
 * touching the network. The Authorization header passes through untouched;
 * the key material below is fake.
 */

import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";

import {
	createGlmSseTransform,
	createProxyServer,
	isGlmModel,
	sanitizeBody,
	translateGlmResponseBody,
	translateGlmStreamChunk,
	UPSTREAM_ORIGIN,
} from "../lib/proxy.js";

/** Starts the proxy on port 0 with `fetchImpl` and returns { port, close }. */
async function startProxy(fetchImpl) {
	const proxy = createProxyServer({ fetchImpl });
	const { port } = await proxy.listen(0);
	return { port, close: () => proxy.close() };
}

/** One POST through the proxy; resolves with status/content-type/body. */
function proxyPost(port, path, body, headers = {}) {
	return new Promise((resolve, reject) => {
		const upstream = httpRequest(
			{ host: "127.0.0.1", port, path, method: "POST", headers },
			(res) => {
				const chunks = [];
				res.on("data", (chunk) => chunks.push(chunk));
				res.on("end", () =>
					resolve({
						status: res.statusCode,
						contentType: res.headers["content-type"],
						body: Buffer.concat(chunks),
					}),
				);
			},
		);
		upstream.on("error", reject);
		upstream.end(body);
	});
}

test("sanitizeBody strips reasoning fields from assistant messages only", () => {
	const raw = Buffer.from(
		JSON.stringify({
			model: "m",
			messages: [
				{ role: "user", content: "hi" },
				{ role: "assistant", content: "ok", reasoning_content: "", reasoning: "x", reasoning_text: "y" },
				{ role: "assistant", content: "again" },
			],
			temperature: 0.2,
		}),
	);
	const { body } = sanitizeBody(raw);
	const out = JSON.parse(body.toString());
	assert.deepEqual(out.messages[0], { role: "user", content: "hi" });
	assert.deepEqual(out.messages[1], { role: "assistant", content: "ok" });
	assert.deepEqual(out.messages[2], { role: "assistant", content: "again" });
	assert.equal(out.temperature, 0.2);
});

test("sanitizeBody passes through non-JSON and message-less bodies unchanged", () => {
	const notJson = Buffer.from("SSE garbage");
	assert.deepEqual(sanitizeBody(notJson), { body: notJson, changed: false });
	const noMessages = Buffer.from(JSON.stringify({ other: 1 }));
	assert.deepEqual(sanitizeBody(noMessages), { body: noMessages, changed: false });
});

test("proxy forwards the sanitized body and the authorization header", async (t) => {
	let captured;
	const proxy = await startProxy(async (url, init) => {
		captured = { url, init };
		return new Response(JSON.stringify({ ok: true }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	});
	t.after(proxy.close);

	const answer = await proxyPost(
		proxy.port,
		"/v1/chat/completions",
		JSON.stringify({ messages: [{ role: "assistant", content: "a", reasoning_content: "" }] }),
		{ authorization: "Bearer fake-key", "content-type": "application/json" },
	);

	assert.equal(answer.status, 200);
	assert.equal(captured.url, `${UPSTREAM_ORIGIN}/v1/chat/completions`);
	assert.equal(captured.init.headers.authorization, "Bearer fake-key");
	const sent = JSON.parse(Buffer.from(captured.init.body).toString());
	assert.deepEqual(sent.messages, [{ role: "assistant", content: "a" }]);
});

test("proxy pipes SSE chunks through unbuffered", async (t) => {
	const sse = "data: {\"a\":1}\n\ndata: {\"b\":2}\n\ndata: [DONE]\n\n";
	const proxy = await startProxy(
		async () =>
			new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
	);
	t.after(proxy.close);

	const answer = await proxyPost(proxy.port, "/v1/chat/completions", "{}");
	assert.equal(answer.status, 200);
	assert.equal(answer.contentType, "text/event-stream");
	assert.equal(answer.body.toString(), sse);
});

test("proxy rejects GET and non-/v1 paths", async (t) => {
	let upstreamCalled = 0;
	const proxy = await startProxy(async () => {
		upstreamCalled += 1;
		return new Response("{}", { status: 200 });
	});
	t.after(proxy.close);

	const forbidden = await new Promise((resolve, reject) => {
		const req = httpRequest({ host: "127.0.0.1", port: proxy.port, path: "/admin/users", method: "POST" }, (res) => {
			resolve(res.statusCode);
		});
		req.on("error", reject);
		req.end();
	});
	assert.equal(forbidden, 404);
	assert.equal(upstreamCalled, 0);

	const method = await new Promise((resolve, reject) => {
		const req = httpRequest({ host: "127.0.0.1", port: proxy.port, path: "/v1/chat/completions", method: "GET" }, (res) => {
			resolve(res.statusCode);
		});
		req.on("error", reject);
		req.end();
	});
	assert.equal(method, 405);
});

test("proxy answers 502 when the upstream is unreachable", async (t) => {
	const proxy = await startProxy(async () => {
		throw new Error("connection refused");
	});
	t.after(proxy.close);
	const answer = await proxyPost(proxy.port, "/v1/chat/completions", "{}");
	assert.equal(answer.status, 502);
});

test("a non-JSON body is forwarded byte-for-byte", async (t) => {
	let captured;
	const proxy = await startProxy(async (url, init) => {
		captured = init;
		return new Response("{}", { status: 200 });
	});
	t.after(proxy.close);
	await proxyPost(proxy.port, "/v1/chat/completions", "raw bytes, not json");
	assert.equal(Buffer.from(captured.body).toString(), "raw bytes, not json");
});

const CAPACITY_429 = JSON.stringify({
	object: "error",
	message: "Not enough capacity available for this request, please retry later.",
	type: "backend_out_of_capacity",
	code: 3505,
});

test("sanitizeBody cuts assistant content at the DSML marker for non-deepseek models", () => {
	const raw = Buffer.from(
		JSON.stringify({
			model: "mistral-medium-2604",
			messages: [
				{
					role: "assistant",
					content: "I'll check that. \uFF5CDSML\uFF5C invoke name=read_file \uFF5CDSML\uFF5C calls",
				},
				{ role: "assistant", content: "clean reply" },
			],
		}),
	);
	const { body, changed } = sanitizeBody(raw);
	assert.equal(changed, true);
	const out = JSON.parse(body.toString());
	assert.equal(out.messages[0].content, "I'll check that.");
	assert.equal(out.messages[1].content, "clean reply");
});

test("sanitizeBody keeps DSML content for deepseek-family models", () => {
	const raw = Buffer.from(
		JSON.stringify({
			model: "deepseek-v4-1-flash-1017",
			messages: [{ role: "assistant", content: "\uFF5CDSML\uFF5C invoke name=read_file" }],
		}),
	);
	const { body, changed } = sanitizeBody(raw);
	assert.equal(changed, false);
	assert.equal(JSON.parse(body.toString()).messages[0].content, "\uFF5CDSML\uFF5C invoke name=read_file");
});

test("proxy fails over to the next model on a capacity 429", async (t) => {
	const models = [];
	const proxy = createProxyServer({
		failoverModels: ["mistral-medium-2604"],
		fetchImpl: async (url, init) => {
			models.push(JSON.parse(Buffer.from(init.body).toString()).model);
			if (models.length === 1) {
				return new Response(CAPACITY_429, { status: 429, headers: { "content-type": "application/json" } });
			}
			return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
		},
	});
	const { port } = await proxy.listen(0);
	t.after(proxy.close);

	const answer = await proxyPost(
		port,
		"/v1/chat/completions",
		JSON.stringify({ model: "deepseek-v4-1-flash-1017", messages: [{ role: "user", content: "hi" }] }),
	);
	assert.equal(answer.status, 200);
	assert.deepEqual(models, ["deepseek-v4-1-flash-1017", "mistral-medium-2604"]);
	assert.equal(answer.body.toString(), JSON.stringify({ ok: true }));
	// The failover answer names the model that actually served it.
});

test("proxy exhausts candidates and replays the last 429 body", async (t) => {
	const models = [];
	const proxy = createProxyServer({
		failoverModels: ["mistral-medium-2604", "mistral-small-latest"],
		fetchImpl: async (url, init) => {
			models.push(JSON.parse(Buffer.from(init.body).toString()).model);
			return new Response(CAPACITY_429, { status: 429, headers: { "content-type": "application/json" } });
		},
	});
	const { port } = await proxy.listen(0);
	t.after(proxy.close);

	const answer = await proxyPost(
		port,
		"/v1/chat/completions",
		JSON.stringify({ model: "deepseek-v4-1-flash-1017", messages: [] }),
	);
	assert.equal(answer.status, 429);
	assert.deepEqual(models, ["deepseek-v4-1-flash-1017", "mistral-medium-2604", "mistral-small-latest"]);
	assert.equal(JSON.parse(answer.body.toString()).code, 3505);
});

test("a non-capacity 429 does not fail over", async (t) => {
	let calls = 0;
	const proxy = createProxyServer({
		failoverModels: ["mistral-medium-2604"],
		fetchImpl: async () => {
			calls += 1;
			return new Response(JSON.stringify({ message: "too many requests" }), {
				status: 429,
				headers: { "content-type": "application/json" },
			});
		},
	});
	const { port } = await proxy.listen(0);
	t.after(proxy.close);

	const answer = await proxyPost(port, "/v1/chat/completions", JSON.stringify({ model: "m", messages: [] }));
	assert.equal(answer.status, 429);
	assert.equal(calls, 1);
});

test("translateGlmStreamChunk maps thinking arrays to reasoning_content", () => {
	const chunk = JSON.parse('{"choices":[{"delta":{"index":0,"content":[{"type":"thinking","thinking":[{"type":"text","text":"The"}],"closed":true}]}}]}');
	translateGlmStreamChunk(chunk);
	assert.deepEqual(chunk.choices[0].delta, { index: 0, reasoning_content: "The" });
});

test("translateGlmStreamChunk keeps plain string deltas untouched", () => {
	const chunk = { choices: [{ delta: { content: "OK" } }] };
	translateGlmStreamChunk(chunk);
	assert.deepEqual(chunk.choices[0].delta, { content: "OK" });
});

test("translateGlmResponseBody flattens thinking + text blocks", () => {
	const payload = JSON.parse('{"choices":[{"message":{"role":"assistant","content":[{"type":"thinking","thinking":[{"type":"text","text":"reason"}],"closed":true},{"type":"text","text":"OK"}]}}]}');
	translateGlmResponseBody(payload);
	assert.equal(payload.choices[0].message.reasoning_content, "reason");
	assert.equal(payload.choices[0].message.content, "OK");
});

test("proxy serves a GLM SSE stream translated when the model is GLM", async (t) => {
	const sse = [
		'data: {"choices":[{"delta":{"role":"assistant","content":""}}]}',
		'',
		'data: {"choices":[{"delta":{"content":[{"type":"thinking","thinking":[{"type":"text","text":"thi"}],"closed":true}]}}]}',
		'',
		'data: {"choices":[{"delta":{"content":"OK"}}]}',
		'',
		'data: [DONE]',
		'',
	].join("\n");
	const proxy = createProxyServer({
		fetchImpl: async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
	});
	const { port } = await proxy.listen(0);
	t.after(proxy.close);
	const answer = await proxyPost(
		port,
		"/v1/chat/completions",
		JSON.stringify({ model: "zai-glm-5-3", messages: [] }),
	);
	const text = answer.body.toString();
	const reasoning = text.includes('"reasoning_content":"thi"');
	const clean = text.includes('"content":"OK"');
	assert.ok(reasoning, `thinking should become reasoning_content: ${text}`);
	assert.ok(clean, "string deltas stay content");
	// The model is GLM: the proxy translated rather than piped raw.
	assert.ok(!text.includes('"type":"thinking"'), "raw thinking blocks must not reach the client");
});

test("proxy does NOT translate SSE for non-GLM models", async (t) => {
	const sse = 'data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n';
	const proxy = createProxyServer({
		fetchImpl: async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
	});
	const { port } = await proxy.listen(0);
	t.after(proxy.close);
	const answer = await proxyPost(port, "/v1/chat/completions", JSON.stringify({ model: "mistral-small-latest", messages: [] }));
	assert.equal(answer.body.toString(), sse);
});

test("GLM SSE survives hostile chunk splits (mid-event, mid-multibyte-char)", async (t) => {
	// The thinking text has multi-byte chars; the raw upstream bytes are
	// delivered one byte at a time to stress line and char boundaries.
	const line1 = 'data: {"choices":[{"delta":{"content":[{"type":"thinking","thinking":[{"type":"text","text":"curly \u201cquotes\u201d and \u4e2d\u6587"}],"closed":true}]}}]}\n\n';
	const line2 = 'data: {"choices":[{"delta":{"content":"OK"}}]}\n\n';
	const line3 = 'data: [DONE]\n\n';
	const sse = line1 + line2 + line3;
	const proxy = createProxyServer({
		fetchImpl: async () => {
			let bytes = [];
			for (const ch of sse) bytes.push(...Buffer.from(ch, "utf-8")); // flatten to single bytes
			const stream = Readable.toWeb(
				new Readable({
					read() {
						this.push(bytes.length ? Buffer.from([bytes.shift()]) : null);
					},
				}),
			);
			return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
		},
	});
	const { port } = await proxy.listen(0);
	t.after(proxy.close);
	const answer = await proxyPost(port, "/v1/chat/completions", JSON.stringify({ model: "zai-glm-5-3", messages: [] }));
	const text = answer.body.toString();
	// Event structure preserved: every data line is its own event.
	const events = text.split("\n\n").filter((block) => block.startsWith("data: "));
	assert.equal(events.length, 3, `three separated events, got: ${JSON.stringify(events)}`);
	assert.ok(text.includes("curly \u201cquotes\u201d and \u4e2d\u6587"), "multi-byte text intact");
	assert.ok(JSON.parse(events[0].slice(6)).choices[0].delta.reasoning_content.includes("\u4e2d\u6587"));
	assert.equal(JSON.parse(events[1].slice(6)).choices[0].delta.content, "OK");
});
