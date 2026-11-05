import { test } from "node:test";
import assert from "node:assert/strict";
import { createDshStream, dshAdapter, parseDshLine } from "../plugins/harness-dispatch/adapters/dsh.js";
import { piAdapter } from "../plugins/harness-dispatch/adapters/pi.js";

test("dsh CLI tool_call and tool_result normalise to tool_start/tool_end", () => {
	const start = parseDshLine(JSON.stringify({ type: "tool_call", callId: "c1", tool: "read", input: { file_path: "a.ts" } }));
	assert.deepEqual(start, [{ kind: "tool_start", id: "c1", name: "read", args: { file_path: "a.ts" } }]);
	const end = parseDshLine(JSON.stringify({ type: "tool_result", callId: "c1", status: "error", result: "Error: no" }));
	assert.equal(end[0].kind, "tool_end");
	assert.equal(end[0].isError, true);
	assert.equal(end[0].text, "Error: no");
});

test("the dsh stream fills tool names by callId and sums usage", () => {
	const s = createDshStream();
	s.one({ type: "tool_call", callId: "c1", tool: "edit", input: {} });
	const end = s.one({ type: "tool_result", callId: "c1", status: "completed", result: "ok" });
	assert.equal(end[0].name, "edit");
	s.one({ type: "status", phase: "step_end", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } });
	s.one({ type: "status", phase: "step_end", usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 } });
	const final = s.one({ type: "final", text: "done" });
	assert.equal(final[0].kind, "assistant_end");
	assert.equal(final[0].text, "done");
	assert.deepEqual(final[0].usage, { input: 15, output: 3, total: 18, cost: 0 });
});

test("dsh session events normalise too", () => {
	const s = createDshStream();
	s.one({ type: "tool/call", callId: "c2", name: "bash", arguments: { command: "node --test" } });
	const end = s.one({ type: "tool/result", message: { callId: "c2", isError: false, content: [{ type: "text", text: "ok" }] } });
	assert.equal(end[0].name, "bash");
	assert.equal(end[0].text, "ok");
	const msg = s.one({ type: "assistant/message", message: { content: [{ type: "text", text: "hello" }] }, usage: { input: 1, output: 2, total: 3 } });
	assert.equal(msg[0].text, "hello");
});

test("plain lines and malformed JSON are kept as plain text", () => {
	assert.deepEqual(parseDshLine("not json"), [{ kind: "plain", text: "not json" }]);
	assert.deepEqual(parseDshLine(""), []);
});

test("the Pi adapter parses tool and assistant events", () => {
	const start = piAdapter.parseLine(JSON.stringify({ type: "tool_execution_start", toolCallId: "t", toolName: "edit", args: { file_path: "a.ts" } }));
	assert.equal(start[0].kind, "tool_start");
	assert.equal(start[0].name, "edit");
	const end = piAdapter.parseLine(JSON.stringify({ type: "tool_execution_end", toolCallId: "t", toolName: "edit", isError: false, result: { content: [{ type: "text", text: "ok" }] } }));
	assert.equal(end[0].text, "ok");
	const msg = piAdapter.parseLine(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hi" }], usage: { input: 1, output: 2, totalTokens: 3, cost: { total: 0.5 } }, stopReason: "stop" } }));
	assert.equal(msg[0].kind, "assistant_end");
	assert.equal(msg[0].usage.cost, 0.5);
	assert.equal(msg[0].text, "hi");
});

test("adapter sessions are one per attempt and Pi sessions live under .plans/sessions", () => {
	const s = piAdapter.sessionFor({ cwd: "/repo", planId: "p1", taskId: "t 1", attempt: 2 });
	assert.match(s.id, /^p1\.t-1-[0-9a-f]{8}\.a2$/);
	assert.equal(s.dir, "/repo/.plans/sessions/p1");
	const d = dshAdapter.sessionFor({ cwd: "/repo", planId: "p1", taskId: "t1", attempt: 1 });
	assert.equal(d.id, "p1.t1.a1");
});

test("Pi worker args carry model, thinking, tools and prompt", () => {
	const args = piAdapter.workerArgs({ model: "m", thinking: "high", tools: ["read"], prompt: "p", session: { id: "s", dir: "d" }, name: "n" });
	assert.deepEqual(args.slice(0, 7), ["--mode", "json", "-p", "--session-id", "s", "--session-dir", "d"]);
	assert.ok(args.includes("--thinking"));
	assert.ok(args.includes("read"));
	assert.equal(args.at(-1), "p");
});
