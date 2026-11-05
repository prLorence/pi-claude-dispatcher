import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	TOOL_RESULT_CAP,
	findSessionFile,
	listSessionFiles,
	parseSessionLines,
	summarizeSession,
} from "../plugins/harness-monitor/sessions.js";
import { assistantMsg, cleanup, makePlansDir, modelChange, sessionHeader, textPart, userMsg, writeSession } from "../fixtures/monitor-fixture.js";

test("parseSessionLines maps every session line kind", () => {
	const text = [
		JSON.stringify(sessionHeader()),
		JSON.stringify(modelChange("m1")),
		JSON.stringify({ type: "thinking_level_change", timestamp: "2026-10-22T18:00:01.500Z", thinkingLevel: "high" }),
		JSON.stringify(userMsg("hello")),
		JSON.stringify({
			type: "message",
			timestamp: "2026-10-22T18:00:04.000Z",
			message: {
				role: "assistant",
				content: [
					textPart("answer"),
					{ type: "thinking", thinking: "hmm" },
					{ type: "toolCall", name: "read", arguments: { file_path: "a.ts" } },
				],
			},
		}),
		JSON.stringify({
			type: "message",
			message: { role: "toolResult", toolName: "read", content: [textPart("result")], isError: true },
		}),
	].join("\n") + "\n";
	const { entries, next } = parseSessionLines(text, 0);
	assert.equal(next, 6);
	assert.deepEqual(
		entries.map((e) => e.kind),
		["note", "note", "user", "assistant", "thinking", "tool_call", "tool_result"],
	);
	assert.equal(entries[2].collapsed, true);
	assert.equal(entries[5].tool.name, "read");
	assert.equal(entries[6].isError, true);
});

test("a long tool result and tool args are truncated", () => {
	const big = "x".repeat(TOOL_RESULT_CAP + 10);
	const longArgs = { command: "y".repeat(9000) };
	const text = [
		JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: longArgs }] } }),
		JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "bash", content: [textPart(big)] } }),
	].join("\n") + "\n";
	const { entries } = parseSessionLines(text, 0);
	assert.equal(entries[0].truncated, true);
	assert.equal(entries[1].truncated, true);
	assert.ok(entries[1].text.endsWith("… [truncated]"));
});

test("a partial last line is not consumed and after resumes", () => {
	const text = `${JSON.stringify(userMsg("one"))}\n${JSON.stringify(userMsg("two"))}\n{"type":"mess`;
	const first = parseSessionLines(text, 0);
	assert.equal(first.entries.length, 2);
	assert.equal(first.next, 2);
	const second = parseSessionLines(text, 1);
	assert.equal(second.entries.length, 1);
	assert.equal(second.entries[0].text, "two");
});

test("summarizeSession is ended on stop and sums usage", () => {
	const dir = makePlansDir();
	try {
		writeSession(dir, "p1", "s1", [
			sessionHeader(),
			modelChange("m1"),
			userMsg("hi"),
			assistantMsg("done", { usage: { input: 10, output: 5, cost: { total: 0.25 } } }),
		]);
		const file = path.join(dir, "sessions", "p1", "2026-10-22T18-02-28-549Z_s1.jsonl");
		const summary = summarizeSession(file);
		assert.equal(summary.exists, true);
		assert.equal(summary.ended, true);
		assert.equal(summary.model, "m1");
		assert.equal(summary.tokens, 15);
		assert.equal(summary.cost, 0.25);
	} finally {
		cleanup(dir);
	}
});

test("summarizeSession is not ended while a tool call is pending", () => {
	const dir = makePlansDir();
	try {
		writeSession(dir, "p1", "s1", [assistantMsg("waiting", { stopReason: "toolUse" })]);
		const summary = summarizeSession(path.join(dir, "sessions", "p1", "2026-10-22T18-02-28-549Z_s1.jsonl"));
		assert.equal(summary.ended, false);
	} finally {
		cleanup(dir);
	}
});

test("summarizeSession reports missing and unreadable files", () => {
	assert.equal(summarizeSession(null).exists, false);
	assert.equal(summarizeSession("/definitely/missing").exists, false);
});

test("listSessionFiles and findSessionFile use the basename after the first underscore", () => {
	const dir = makePlansDir();
	try {
		writeSession(dir, "p1", "p1.a1", [sessionHeader()]);
		const files = listSessionFiles(dir, "p1");
		assert.equal(files.length, 1);
		assert.equal(files[0].id, "p1.a1");
		assert.equal(findSessionFile(dir, "p1", "p1.a1"), files[0].file);
		assert.equal(findSessionFile(dir, "p1", "nope"), null);
	} finally {
		cleanup(dir);
	}
});
