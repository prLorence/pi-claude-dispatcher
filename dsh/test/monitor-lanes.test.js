import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { buildPlanView, STALL_MS } from "../plugins/harness-monitor/lanes.js";
import { applyDecider } from "../plugins/harness-monitor/decider.js";
import { readState } from "../plugins/harness-monitor/state.js";
import { cleanup, ev, makePlansDir, writeEvents, writePlan } from "../fixtures/monitor-fixture.js";
import { parsePlan, readTraceEvents } from "../plugins/harness-monitor/plans.js";

const NOW = Date.parse("2026-10-23T10:05:00.000Z");

test("a task with no events is skipped in a finished plan and waits for nothing", () => {
	const plan = parsePlan("---\nid: p\n---\n## task: a\ndepends_on: [b]\n\nbody\n## task: b\n\nbody\n");
	const view = buildPlanView(plan, false, [], [], NOW);
	assert.equal(view.state, "done");
	assert.equal(view.tasks[0].skipped, true);
	assert.deepEqual(view.tasks[0].waitsFor, []);
	assert.equal(view.tasks[0].reviewer, null);
});

test("waiting tasks list only dependencies that are not done", () => {
	const plan = parsePlan("---\nid: p\n---\n## task: a\n\nbody\n## task: b\ndepends_on: [a]\n\nbody\n");
	const events = [ev("task.end", "p", "2026-10-23T10:00:00Z", { task: "a", data: { state: "done" } })];
	const view = buildPlanView(plan, true, events, [], NOW);
	assert.deepEqual(view.tasks[1].waitsFor, []);
	assert.equal(view.done, 1);
});

test("done counts tasks whose latest task.end is done and gate follows plan.end", () => {
	const plan = parsePlan("---\nid: p\n---\n## task: a\n\nbody\n## task: b\n\nbody\n");
	const events = [
		ev("task.end", "p", "2026-10-23T10:00:00Z", { task: "a", data: { state: "done" } }),
		ev("task.end", "p", "2026-10-23T10:01:00Z", { task: "b", data: { state: "failed" } }),
		ev("plan.end", "p", "2026-10-23T10:02:00Z", { data: { gate_pass: false } }),
	];
	const view = buildPlanView(plan, false, events, [], NOW);
	assert.equal(view.done, 1);
	assert.equal(view.gate, "fail");
	assert.equal(view.state, "failed");
});

test("an implementer with a session file is live while recent and stalled when old", () => {
	const plan = parsePlan("---\nid: p\n---\n## task: a\n\nbody\n");
	const events = [ev("task.start", "p", "2026-10-23T10:00:00Z", { task: "a", attempt: 1, data: { model: "m", thinking: "low" } })];
	const recent = buildPlanView(plan, true, events, [{ id: "p.a.a1", file: "/s" }], NOW, () => ({ exists: true, ended: false, mtimeMs: NOW - 1000, startedAt: null, lastTs: null, model: null, thinking: null, tokens: null, cost: null, lastTool: null, error: null, stopReason: null }));
	assert.equal(recent.tasks[0].implementer.state, "live");
	const old = buildPlanView(plan, true, events, [{ id: "p.a.a1", file: "/s" }], NOW, () => ({ exists: true, ended: false, mtimeMs: NOW - STALL_MS - 1, startedAt: null, lastTs: null, model: null, thinking: null, tokens: null, cost: null, lastTool: null, error: null, stopReason: null }));
	assert.equal(old.tasks[0].implementer.state, "stalled");
});

test("a reviewer lane appears only with a pair, and its verdict is pinned", () => {
	const plan = parsePlan("---\nid: p\n---\n## task: a\npair: review\n\nbody\n## task: b\n\nbody\n");
	const events = [ev("task.review", "p", "2026-10-23T10:00:00Z", { task: "a", attempt: 1, data: { round: 1, verdict: "approve", findings: 0, model: "r" } })];
	const view = buildPlanView(plan, true, events, [], NOW);
	assert.equal(view.tasks[0].reviewer.state, "done");
	assert.equal(view.tasks[0].reviewer.attempts[0].review.verdict, "approve");
	assert.equal(view.tasks[1].reviewer, null);
});

test("decider effort and audit events fill the task and plan views", () => {
	const plan = parsePlan("---\nid: p\n---\n## task: a\n\nbody\n");
	const events = [
		ev("decision.effort", "p", "2026-10-23T10:00:00Z", { task: "a", data: { suggested: "high", probabilities: { low: 0.1, high: 0.9 }, confidence: 0.9, complexity: 3 } }),
		ev("task.start", "p", "2026-10-23T10:01:00Z", { task: "a", attempt: 1, data: { thinking: "high" } }),
		ev("decision.audit", "p", "2026-10-23T10:02:00Z", { data: { proposal: "approve", aggregate: 0.2, verdict: "pass", audit_round: 1, findings: [{ id: "f1", severity: "minor", p: 0.2 }] } }),
	];
	const view = applyDecider(buildPlanView(plan, true, events, [], NOW), events);
	assert.equal(view.tasks[0].decider.suggested, "high");
	assert.equal(view.tasks[0].decider.ran, "high");
	assert.equal(view.audit.proposal, "approve");
	assert.equal(view.audit.findings.length, 1);
});

test("state puts active repos first and idle by last activity", () => {
	const a = makePlansDir();
	const b = makePlansDir();
	try {
		writePlan(a, "running", "pa", [{ id: "a" }]);
		writeEvents(a, "pa", [ev("task.start", "pa", "2026-10-23T10:00:00Z", { task: "a" })]);
		writePlan(b, "done", "pb", [{ id: "a" }]);
		writeEvents(b, "pb", [ev("plan.end", "pb", "2026-10-23T09:00:00Z", { data: { gate_pass: true } })]);
		const state = readState([{ name: "b", dir: b }, { name: "a", dir: a }], NOW);
		assert.deepEqual(state.repos.map((r) => r.name), ["a", "b"]);
		assert.equal(state.repos[0].active, true);
	} finally {
		cleanup(a);
		cleanup(b);
	}
});
