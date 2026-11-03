/** Run with: cd pi-plan-dispatch && node --test --test-force-exit adapters/pi.test.ts (Node 24+) */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { piAdapter } from "./pi.ts";
import type { AgentEvent } from "./types.ts";

type AssistantEnd = Extract<AgentEvent, { kind: "assistant_end" }>;
type ToolStart = Extract<AgentEvent, { kind: "tool_start" }>;
type ToolEnd = Extract<AgentEvent, { kind: "tool_end" }>;

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pi-adapter-"));

/** Read a fixture by its literal path relative to this test file. */
function fixtureEvents(rel: string): AgentEvent[] {
	const text = fs.readFileSync(path.join(here, rel), "utf8");
	return text
		.split("\n")
		.filter((line) => line.length > 0)
		.flatMap((line) => piAdapter.parseLine(line));
}

function assistantEnds(events: AgentEvent[]): AssistantEnd[] {
	return events.filter((e): e is AssistantEnd => e.kind === "assistant_end");
}

function toolStarts(events: AgentEvent[]): ToolStart[] {
	return events.filter((e): e is ToolStart => e.kind === "tool_start");
}

function toolEnds(events: AgentEvent[]): ToolEnd[] {
	return events.filter((e): e is ToolEnd => e.kind === "tool_end");
}

test("workerArgs builds the full Pi argument vector for a session with thinking and tools", () => {
	const session = { id: "plan.a1", dir: "/sessions/plan" };
	assert.deepEqual(
		piAdapter.workerArgs({ model: "m", thinking: "high", tools: ["read", "bash"], prompt: "do it", session, name: "plan/task" }),
		[
			"--mode",
			"json",
			"-p",
			"--session-id",
			"plan.a1",
			"--session-dir",
			"/sessions/plan",
			"--name",
			"plan/task",
			"--model",
			"m",
			"--thinking",
			"high",
			"--tools",
			"read,bash",
			"do it",
		],
	);
});

test("workerArgs omits the thinking and tools flags when a session has neither", () => {
	const session = { id: "plan.a1", dir: "/sessions/plan" };
	assert.deepEqual(
		piAdapter.workerArgs({ model: "m", thinking: "", tools: [], prompt: "do it", session, name: "plan/task" }),
		["--mode", "json", "-p", "--session-id", "plan.a1", "--session-dir", "/sessions/plan", "--name", "plan/task", "--model", "m", "do it"],
	);
});

test("workerArgs uses --no-session when the run has no session", () => {
	assert.deepEqual(piAdapter.workerArgs({ model: "m", thinking: "low", tools: ["read"], prompt: "do it", name: "plan/task" }), [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--model",
		"m",
		"--thinking",
		"low",
		"--tools",
		"read",
		"do it",
	]);
});

test("workerArgs leaves out --thinking for an empty thinking level", () => {
	assert.deepEqual(piAdapter.workerArgs({ model: "m", thinking: "", tools: ["read"], prompt: "do it", name: "plan/task" }), [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--model",
		"m",
		"--tools",
		"read",
		"do it",
	]);
});

test("workerArgs leaves out --tools for an empty tools list", () => {
	assert.deepEqual(piAdapter.workerArgs({ model: "m", thinking: "high", tools: [], prompt: "do it", name: "plan/task" }), [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--model",
		"m",
		"--thinking",
		"high",
		"do it",
	]);
});

test("smokeArgs builds the no-session smoke test with a thinking level", () => {
	assert.deepEqual(piAdapter.smokeArgs({ model: "m", thinking: "high" }), [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--model",
		"m",
		"--thinking",
		"high",
		"Reply with the single word OK",
	]);
});

test("smokeArgs leaves out --thinking for an empty thinking level", () => {
	assert.deepEqual(piAdapter.smokeArgs({ model: "m", thinking: "" }), [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--model",
		"m",
		"Reply with the single word OK",
	]);
});

test("command returns the configured Pi executable", () => {
	assert.equal(piAdapter.command({ piCommand: "/x/pi" }), "/x/pi");
});

test("sessionFor builds a session id and directory for a plain plan and task", () => {
	const cwd = tmp();
	const s = piAdapter.sessionFor({ cwd, planId: "plan-r1", taskId: "task-one", attempt: 1 });
	assert.deepEqual(s, { id: "plan-r1.task-one.a1", dir: path.join(cwd, ".plans", "sessions", "plan-r1") });
});

test("sessionFor appends the stable hash when safeId changes the task id", () => {
	const cwd = tmp();
	const taskId = "task one with spaces";
	const hash = createHash("sha256").update(taskId).digest("hex").slice(0, 8);
	const s = piAdapter.sessionFor({ cwd, planId: "plan-r1", taskId, attempt: 1 });
	assert.equal(s.id, `plan-r1.task-one-with-spaces-${hash}.a1`);
});

test("sessionFor records the attempt number in the session id", () => {
	const cwd = tmp();
	const s = piAdapter.sessionFor({ cwd, planId: "plan-r1", taskId: "task-one", attempt: 3 });
	assert.equal(s.id, "plan-r1.task-one.a3");
});

test("findSessionFile finds the task attempt file and retireSession moves it aside", () => {
	const cwd = tmp();
	const s = piAdapter.sessionFor({ cwd, planId: "plan-r1", taskId: "task-one", attempt: 1 });
	fs.mkdirSync(s.dir, { recursive: true });
	const sessionFile = `2026-01-01T00-00-00-000Z_${s.id}.jsonl`;
	const otherFile = "2026-01-01T00-00-00-000Z_someone-else.jsonl";
	fs.writeFileSync(path.join(s.dir, sessionFile), "old conversation\n");
	fs.writeFileSync(path.join(s.dir, otherFile), "someone else\n");

	assert.equal(piAdapter.findSessionFile(s), sessionFile);

	piAdapter.retireSession(s);
	const names = fs.readdirSync(s.dir);
	const moved = names.find((n) => n.startsWith(`${sessionFile}.prev-`));
	assert.ok(moved, "the old session file is renamed with a .prev- suffix");
	assert.match(moved!, /\.prev-\d+$/);
	assert.equal(names.includes(otherFile), true, "another id's session is left alone");
	assert.equal(piAdapter.findSessionFile(s), undefined);
});

test("resumeCommand reopens the session with a relative session directory", () => {
	const cwd = tmp();
	const s = piAdapter.sessionFor({ cwd, planId: "plan-r1", taskId: "task-one", attempt: 1 });
	assert.equal(piAdapter.resumeCommand(cwd, s), `pi --session ${s.id} --session-dir .plans/sessions/plan-r1`);
});

test("parseLine returns no events for a blank line", () => {
	assert.deepEqual(piAdapter.parseLine(""), []);
	assert.deepEqual(piAdapter.parseLine("   "), []);
});

test("parseLine keeps a line that is not JSON as plain text", () => {
	assert.deepEqual(piAdapter.parseLine("not json at all"), [{ kind: "plain", text: "not json at all" }]);
});

test("parseLine turns pi/text into one assistant end with usage and progress for the rest", () => {
	const events = fixtureEvents("../fixtures/agents/pi/text.jsonl");
	assert.deepEqual(
		events.map((e) => e.kind),
		["progress", "progress", "progress", "progress", "progress", "assistant_end", "progress"],
	);
	const ends = assistantEnds(events);
	assert.equal(ends.length, 1);
	assert.equal(ends[0].text, "READY");
	assert.deepEqual(ends[0].usage, { input: 120, output: 3, total: 123, cost: 0 });
	assert.equal(ends[0].stopReason, "stop");
	assert.equal(ends[0].errorMessage, "");
});

test("parseLine turns pi/tool-call into a tool start, a blocked tool end and an assistant end", () => {
	const events = fixtureEvents("../fixtures/agents/pi/tool-call.jsonl");
	assert.deepEqual(events.map((e) => e.kind), ["progress", "tool_start", "tool_end", "assistant_end", "progress"]);

	const starts = toolStarts(events);
	assert.equal(starts.length, 1);
	assert.equal(starts[0].id, "tool-1");
	assert.equal(starts[0].name, "edit");
	assert.deepEqual(starts[0].args, { path: "src/other.ts" });

	const ends = toolEnds(events);
	assert.equal(ends.length, 1);
	assert.equal(ends[0].id, "tool-1");
	assert.equal(ends[0].name, "edit");
	assert.equal(ends[0].isError, true);
	assert.ok(ends[0].text.startsWith("BLOCKED by pi-plan-dispatch:"), "the blocked marker survives in text");

	assert.equal(assistantEnds(events).length, 1);
});

test("parseLine turns omp/text into one assistant end and ignores the user message end", () => {
	const events = fixtureEvents("../fixtures/agents/omp/text.jsonl");
	const ends = assistantEnds(events);
	assert.equal(ends.length, 1, "only the assistant message_end is an assistant end");
	assert.equal(ends[0].text, "READY");
	assert.equal(ends[0].usage.total, 123);
	assert.equal(ends[0].usage.cost, 0);
	assert.equal(ends[0].stopReason, "stop");

	for (const e of events) {
		if (e.kind !== "assistant_end") assert.equal(e.kind, "progress");
	}
});

test("parseLine turns omp/tool-call into a read tool pair and two assistant ends", () => {
	const events = fixtureEvents("../fixtures/agents/omp/tool-call.jsonl");

	const starts = toolStarts(events);
	assert.equal(starts.length, 1);
	assert.equal(starts[0].name, "read");
	assert.equal(starts[0].args.path, "README.md");

	const ends = toolEnds(events);
	assert.equal(ends.length, 1);
	assert.equal(ends[0].isError, false);
	assert.equal(ends[0].text, "# Title");

	assert.deepEqual(
		assistantEnds(events).map((e) => e.stopReason),
		["toolUse", "stop"],
	);
});

test("parseLine turns omp/error-400 into an assistant error end with retry lines as progress", () => {
	const events = fixtureEvents("../fixtures/agents/omp/error-400.jsonl");
	const ends = assistantEnds(events);
	assert.equal(ends.length, 1);
	assert.equal(ends[0].stopReason, "error");
	assert.equal(ends[0].errorMessage, "400 Request is missing x-opencode-session and cannot be routed efficiently");

	const text = fs.readFileSync(path.join(here, "../fixtures/agents/omp/error-400.jsonl"), "utf8");
	const retryStart = text.split("\n").find((line) => line.includes('"auto_retry_start"'));
	const retryEnd = text.split("\n").find((line) => line.includes('"auto_retry_end"'));
	assert.ok(retryStart);
	assert.ok(retryEnd);
	assert.deepEqual(piAdapter.parseLine(retryStart!), [{ kind: "progress" }]);
	assert.deepEqual(piAdapter.parseLine(retryEnd!), [{ kind: "progress" }]);
});
