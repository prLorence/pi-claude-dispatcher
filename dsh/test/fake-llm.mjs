#!/usr/bin/env node
/**
 * Fake OpenAI-compatible model server for the integration tests.
 *
 * It records every request body to FAKE_LLM_LOG, answers a tool-less request
 * (dsh's title request) with a fixed title without consuming a script step,
 * plays scripted steps for the plan workers, and holds the orchestrator's
 * answer until FAKE_LLM_DONE_FILE exists (or FAKE_LLM_HOLD_MS passes).
 *
 * Run it with `node fake-llm.mjs`; the command branch only runs under
 * `import.meta.main`.
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const DONE = () => process.env.FAKE_LLM_DONE_FILE;
const HOLD_MS = Number(process.env.FAKE_LLM_HOLD_MS ?? 30000);

function readBody(req) {
	return new Promise((resolve) => {
		let text = "";
		req.setEncoding("utf8");
		req.on("data", (d) => (text += d));
		req.on("end", () => {
			try {
				resolve(JSON.parse(text));
			} catch {
				resolve({});
			}
		});
	});
}

function allText(body) {
	return JSON.stringify(body ?? {});
}

function lastUserText(body) {
	const messages = Array.isArray(body.messages) ? body.messages : [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "user") continue;
		if (typeof m.content === "string") return m.content;
		if (Array.isArray(m.content)) return m.content.filter((p) => p?.type === "text").map((p) => p.text).join("\n");
	}
	return "";
}

function toolCallsSoFar(body) {
	const messages = Array.isArray(body.messages) ? body.messages : [];
	let count = 0;
	for (const m of messages) {
		if (m.role === "assistant" && Array.isArray(m.tool_calls)) count += m.tool_calls.length;
	}
	return count;
}

function taskOf(body) {
	const m = /## Your task: ([A-Za-z0-9._-]+)/.exec(allText(body));
	return m ? m[1] : null;
}

function planOf(body) {
	const m = /one task from plan "([^"]+)"/.exec(allText(body));
	return m ? m[1] : null;
}

/** Choose the next worker action: a tool call object or {text}. */
function workerStep(body) {
	const task = taskOf(body);
	const step = toolCallsSoFar(body);
	const shared = "src/shared.ts";
	const own = task === "t3" || task === "c" ? "src/c.ts" : shared;
	if (task === "t3" || task === "c") {
		if (step === 0) return { tool: "write", arguments: { file_path: "outside.txt", content: "out of scope\n" } };
		if (step === 1) return { tool: "read", arguments: { file_path: own } };
		if (step === 2) return { tool: "write", arguments: { file_path: own, content: `// ${task}\n` } };
	} else {
		if (step === 0) return { tool: "read", arguments: { file_path: own } };
		if (step === 1) return { tool: "write", arguments: { file_path: own, content: `// ${task}\n` } };
	}
	return {
		text: `STATUS: done\nCHANGED: ${own}\nTESTS: none\nNOTES: fake worker ${task} finished.\nNEEDS: none\n`,
	};
}

function sse(res) {
	res.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "keep-alive",
	});
	return (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function chunk(payload) {
	return {
		id: "chatcmpl-fake",
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model: "fake-model",
		choices: [{ index: 0, delta: payload, finish_reason: null }],
	};
}

function sendText(write, text) {
	write(chunk({ role: "assistant", content: "" }));
	write(chunk({ content: text }));
	write({ ...chunk({}), choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
	write({ id: "chatcmpl-fake", object: "chat.completion.chunk", model: "fake-model", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
	writeTextDone(write);
}

function sendTool(write, tool) {
	const call = {
		index: 0,
		id: `call_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
		type: "function",
		function: { name: tool.tool, arguments: JSON.stringify(tool.arguments) },
	};
	write(chunk({ role: "assistant", content: "" }));
	write(chunk({ tool_calls: [call] }));
	write({ ...chunk({}), choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
	write({ id: "chatcmpl-fake", object: "chat.completion.chunk", model: "fake-model", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
	writeTextDone(write);
}

function writeTextDone(write) {
	// [DONE] is sent by the caller after this function.
}

export function startFakeLlm({ port = 0, holdMs = HOLD_MS, logFile = process.env.FAKE_LLM_LOG, doneFile = DONE() } = {}) {
	const server = http.createServer(async (req, res) => {
		const body = await readBody(req);
		if (logFile) {
			try {
				fs.appendFileSync(logFile, `${JSON.stringify(body)}\n`);
			} catch {}
		}
		const text = allText(body);
		const write = sse(res);
		const finish = () => {
			res.write("data: [DONE]\n\n");
			res.end();
		};
		const isTitle = !Array.isArray(body.tools) || body.tools.length === 0;
		if (isTitle) {
			sendText(write, "Fake title");
			finish();
			return;
		}
		if (text.includes("You are a worker executing one task from plan")) {
			const action = workerStep(body);
			if (action.tool) sendTool(write, action);
			else sendText(write, action.text);
			finish();
			return;
		}
		// The orchestrator request: hold the answer until the dispatcher is done.
		const started = Date.now();
		while (Date.now() - started < holdMs) {
			if (doneFile && fs.existsSync(doneFile)) break;
			await new Promise((r) => setTimeout(r, 50));
		}
		sendText(write, "plan finished");
		finish();
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port, close: () => new Promise((r) => server.close(r)) }));
	});
}

if (import.meta.main && !process.env.NODE_TEST_CONTEXT) {
	const started = await startFakeLlm({});
	console.log(`fake-llm on http://127.0.0.1:${started.port}`);
	const stop = () => {
		void started.close().then(() => process.exit(0));
	};
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
}
