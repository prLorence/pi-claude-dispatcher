/** Run with: node --test dispatch-plan/decide-stats.test.mjs (Node 24+) */
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderStats, statsReport } from "./decide-stats.mjs";

let seq = 0;
const PLAN = "t1-r1";

/** One trace event, with the fields the dispatcher and the decider write. */
function ev(trace, kind, fields = {}) {
	seq += 1;
	return {
		v: 1,
		ts: new Date(Date.UTC(2026, 9, 23, 12, 0, seq)).toISOString(),
		trace,
		plan: PLAN,
		round: 1,
		actor: "worker",
		kind,
		...fields,
	};
}

function start(trace, task, thinking, attempt = 1, fields = {}) {
	return ev(trace, "task.start", { task, attempt, data: { role: "implement", model: "m", thinking }, ...fields });
}

function end(trace, task, state, ok, attempt = 1) {
	return ev(trace, "task.end", { task, attempt, data: { state, ok } });
}

function review(trace, task, verdict, attempt = 1) {
	return ev(trace, "task.review", {
		task,
		attempt,
		data: { round: 1, reviewer_role: "review", verdict, findings: verdict === "changes" ? 1 : 0 },
	});
}

function effortEvent(trace, task, suggested, fields = {}) {
	return ev(trace, "decision.effort", {
		task,
		data: {
			task,
			suggested,
			probabilities: { low: 0.1, high: 0.7, max: 0.2 },
			confidence: 0.8,
			complexity: 3,
			model: "perplexity/pplx-decider-flash-v1.2-20261016",
			cost: 0.000004,
			mode: "apply",
		},
		...fields,
	});
}

function auditEvent(trace, proposal, verdict, fields = {}) {
	return ev(trace, "decision.audit", {
		data: {
			model: "perplexity/pplx-decider-flash-v1.2-20261016",
			cost: 0.000012,
			audit_round: 1,
			verdict,
			proposal,
			aggregate: 0.21,
			findings: [{ id: "F1", severity: "major", p: 0.21 }],
		},
		...fields,
	});
}

const row = (over) => ({ n: 0, first_try: 0, retried: 0, changes: 0, failed: 0, ...over });

test("a matched suggestion that passed first try", () => {
	const events = [
		effortEvent("t1", "a", "low"),
		start("t1", "a", "low"),
		end("t1", "a", "done", true),
	];
	assert.deepEqual(statsReport(events).effort, [row({ suggested: "low", ran: "low", n: 1, first_try: 1 })]);
});

test("a task that ran a different level and failed twice before done", () => {
	const events = [
		effortEvent("t1", "a", "max"),
		start("t1", "a", "low", 1),
		end("t1", "a", "retry", false, 1),
		start("t1", "a", "low", 2),
		end("t1", "a", "retry", false, 2),
		start("t1", "a", "low", 3),
		end("t1", "a", "done", true, 3),
	];
	// The first attempt's level is the one that ran; two failed retries count once.
	assert.deepEqual(statsReport(events).effort, [row({ suggested: "max", ran: "low", n: 1, retried: 1 })]);
});

test("two pair reviews that asked for changes", () => {
	const events = [
		effortEvent("t1", "a", "high"),
		start("t1", "a", "high", 1),
		review("t1", "a", "changes", 1),
		end("t1", "a", "retry", true, 1),
		start("t1", "a", "high", 2),
		review("t1", "a", "changes", 2),
		end("t1", "a", "retry", true, 2),
		start("t1", "a", "high", 3),
		review("t1", "a", "approve", 3),
		end("t1", "a", "done", true, 3),
	];
	const [effort] = statsReport(events).effort;
	assert.equal(effort.changes, 2);
	assert.equal(effort.first_try, 0);
	// A pair re-run ends its attempt `retry` with `ok: true`, so it is no retry.
	assert.equal(effort.retried, 0);
	assert.equal(effort.failed, 0);
});

test("one pair review that asked for changes", () => {
	const events = [
		effortEvent("t1", "a", "high"),
		start("t1", "a", "high", 1),
		review("t1", "a", "changes", 1),
		end("t1", "a", "retry", true, 1),
		start("t1", "a", "high", 2),
		review("t1", "a", "approve", 2),
		end("t1", "a", "done", true, 2),
	];
	assert.deepEqual(statsReport(events).effort, [row({ suggested: "high", ran: "high", n: 1, changes: 1 })]);
});

test("a re-run without a failure is no retry", () => {
	const events = [
		effortEvent("t1", "a", "max"),
		start("t1", "a", "max", 1),
		review("t1", "a", "changes", 1),
		end("t1", "a", "retry", true, 1),
		start("t1", "a", "max", 2),
		end("t1", "a", "done", true, 2),
	];
	const [effort] = statsReport(events).effort;
	assert.equal(effort.first_try, 0);
	assert.equal(effort.retried, 0);
	assert.equal(effort.changes, 1);
});

test("a task that never started has no level and no outcome", () => {
	const events = [effortEvent("t1", "a", "high")];
	assert.deepEqual(statsReport(events).effort, [row({ suggested: "high", ran: "none", n: 1 })]);
});

test("a task that ended failed is counted as failed", () => {
	const events = [
		effortEvent("t1", "a", "low"),
		start("t1", "a", "low"),
		end("t1", "a", "retry", false),
		start("t1", "a", "low", 2),
		end("t1", "a", "failed", false, 2),
	];
	assert.deepEqual(statsReport(events).effort, [row({ suggested: "low", ran: "low", n: 1, retried: 1, failed: 1 })]);
});

test("tasks with the same suggested and ran level share one row", () => {
	const events = [
		effortEvent("t1", "a", "low"),
		effortEvent("t1", "b", "low"),
		start("t1", "a", "low"),
		start("t1", "b", "low"),
		end("t1", "a", "done", true),
		end("t1", "b", "failed", false),
	];
	// `low` sorts before `high` and `max`, whatever order the events came in.
	assert.deepEqual(statsReport(events).effort, [row({ suggested: "low", ran: "low", n: 2, first_try: 1, failed: 1 })]);
});

test("an approve proposal followed by the user's approval agrees", () => {
	const events = [
		auditEvent("t1", "approve", "pass"),
		ev("t1", "plan.approved", { actor: "sonnet-orchestrator", data: { approved_by: "user" } }),
	];
	assert.deepEqual(statsReport(events).audit, [
		{ proposal: "approve", verdict: "pass", next: "approved by user", n: 1, agree: true },
	]);
});

test("an approve proposal followed by another audit round disagrees", () => {
	const events = [
		auditEvent("t1", "approve", "pass"),
		ev("t1", "plan.audit", { actor: "opus-plan-auditor", data: { verdict: "fail", audit_round: 2 } }),
	];
	assert.deepEqual(statsReport(events).audit, [
		{ proposal: "approve", verdict: "pass", next: "fail", n: 1, agree: false },
	]);
});

test("a hold proposal followed by another audit round agrees", () => {
	const events = [
		auditEvent("t1", "hold", "pass"),
		ev("t1", "plan.audit", { actor: "opus-plan-auditor", data: { verdict: "pass", audit_round: 2 } }),
	];
	assert.deepEqual(statsReport(events).audit, [
		{ proposal: "hold", verdict: "pass", next: "pass", n: 1, agree: true },
	]);
});

test("a fix proposal followed by another audit round agrees", () => {
	const events = [
		auditEvent("t1", "fix", "fail"),
		ev("t1", "plan.audit", { actor: "opus-plan-auditor", data: { verdict: "fail", audit_round: 2 } }),
	];
	assert.deepEqual(statsReport(events).audit, [
		{ proposal: "fix", verdict: "fail", next: "fail", n: 1, agree: true },
	]);
});

test("a dismiss proposal followed by an approval agrees, and by a fail disagrees", () => {
	const agreed = [
		auditEvent("t1", "dismiss", "fail"),
		ev("t1", "plan.approved", { actor: "sonnet-orchestrator", data: { approved_by: "user" } }),
	];
	assert.equal(statsReport(agreed).audit[0].agree, true);
	const disagreed = [
		auditEvent("t1", "dismiss", "fail"),
		ev("t1", "plan.audit", { actor: "opus-plan-auditor", data: { verdict: "fail", audit_round: 2 } }),
	];
	assert.deepEqual(statsReport(disagreed).audit, [
		{ proposal: "dismiss", verdict: "fail", next: "fail", n: 1, agree: false },
	]);
});

test("a proposal with nothing after it is counted with no outcome", () => {
	const events = [auditEvent("t1", "hold", "pass")];
	assert.deepEqual(statsReport(events).audit, [
		{ proposal: "hold", verdict: "pass", next: "none", n: 1, agree: false },
	]);
});

test("the same proposal and outcome share one row", () => {
	const events = [
		auditEvent("t1", "approve", "pass"),
		auditEvent("t1", "approve", "pass"),
		ev("t1", "plan.approved", { actor: "sonnet-orchestrator", data: { approved_by: "user" } }),
	];
	assert.deepEqual(statsReport(events).audit, [
		{ proposal: "approve", verdict: "pass", next: "approved by user", n: 2, agree: true },
	]);
});

test("outcomes never cross traces or plans", () => {
	const events = [
		effortEvent("t1", "a", "low"),
		start("t2", "a", "max"),
		end("t2", "a", "done", true),
		auditEvent("t1", "approve", "pass"),
		// Another plan's approval says nothing about t1's proposal.
		ev("t1", "plan.approved", { plan: "t1-r2", data: { approved_by: "user" } }),
	];
	const report = statsReport(events);
	assert.deepEqual(report.effort, [row({ suggested: "low", ran: "none", n: 1 })]);
	assert.deepEqual(report.audit, [
		{ proposal: "approve", verdict: "pass", next: "none", n: 1, agree: false },
	]);
});

test("mixed traces keep their own task events", () => {
	const events = [
		effortEvent("t1", "a", "low"),
		effortEvent("t2", "a", "high"),
		start("t2", "a", "high"),
		end("t2", "a", "done", true),
		start("t1", "a", "low"),
		end("t1", "a", "done", true),
	];
	// `low` sorts before `high` and `max`, whatever order the events came in.
	assert.deepEqual(statsReport(events).effort, [
		row({ suggested: "low", ran: "low", n: 1, first_try: 1 }),
		row({ suggested: "high", ran: "high", n: 1, first_try: 1 }),
	]);
});

test("the cost sums the decider events only", () => {
	const events = [
		effortEvent("t1", "a", "low"),
		effortEvent("t1", "b", "high"),
		auditEvent("t1", "fix", "fail"),
		ev("t1", "decision.error", { actor: "decider", data: { command: "audit", status: 500, kind: "http", message: "boom" } }),
		end("t1", "a", "done", true),
	];
	const report = statsReport(events);
	// Two effort events and one audit event; the task costs and the error do not count.
	assert.ok(Math.abs(report.cost - 0.00002) < 1e-12, `cost ${report.cost}`);
});

test("an empty input gives an empty report", () => {
	const report = statsReport([]);
	assert.deepEqual(report, { effort: [], audit: [], cost: 0 });
	assert.equal(renderStats(report), "no decisions recorded");
	assert.deepEqual(statsReport(undefined), { effort: [], audit: [], cost: 0 });
	assert.deepEqual(statsReport([null, 5, "x"]), { effort: [], audit: [], cost: 0 });
});

test("the rendered text of a small report", () => {
	const events = [
		effortEvent("t1", "a", "low"),
		start("t1", "a", "low"),
		end("t1", "a", "done", true),
		effortEvent("t1", "b", "max"),
		start("t1", "b", "low"),
		review("t1", "b", "changes"),
		end("t1", "b", "retry", true),
		start("t1", "b", "low", 2),
		end("t1", "b", "done", true, 2),
		auditEvent("t1", "approve", "pass"),
		ev("t1", "plan.approved", { actor: "sonnet-orchestrator", data: { approved_by: "user" } }),
	];
	const rendered = renderStats(statsReport(events));
	const expected = [
		"decider stats",
		"",
		"effort: suggested level vs the level the task ran with",
		"suggested  ran  tasks  first try  retried  changes  failed",
		"---------  ---  -----  ---------  -------  -------  ------",
		"low        low      1          1        0        0       0",
		"max        low      1          0        0        1       0",
		"",
		"audit: proposal vs the next event of the trace",
		"proposal  verdict  next              times  agree",
		"--------  -------  ----------------  -----  -----",
		"approve   pass     approved by user      1  yes",
		"",
		"total cost $0.000020",
	].join("\n");
	assert.equal(rendered, expected);
});

test("a report with only one kind of decision still shows both sections", () => {
	const rendered = renderStats(statsReport([effortEvent("t1", "a", "low")]));
	assert.match(rendered, /^decider stats\n/);
	assert.match(rendered, /\neffort: suggested level vs the level the task ran with\n/);
	assert.match(rendered, /\naudit: proposal vs the next event of the trace\n\(none\)\n/);
	assert.match(rendered, /\ntotal cost \$0\.000004$/);
});
