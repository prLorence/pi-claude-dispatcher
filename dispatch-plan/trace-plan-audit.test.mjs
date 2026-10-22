/** Run with: node --test dispatch-plan/trace-plan-audit.test.mjs (Node 24+) */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const here = path.dirname(new URL(import.meta.url).pathname);
const cli = path.join(here, "trace.mjs");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pi-trace-plan-audit-"));

let seq = 0;
function ev(trace, kind, fields = {}) {
	seq += 1;
	return JSON.stringify({
		v: 1,
		ts: new Date(Date.UTC(2026, 9, 21, 12, 0, seq)).toISOString(),
		trace,
		span: `${kind}:${fields.plan || trace}`,
		actor: "pi-dispatch",
		kind,
		...fields,
	});
}

function runReport(dir, trace) {
	const r = spawnSync(process.execPath, [cli, "report", "--trace", trace, "--root", dir], { encoding: "utf8" });
	assert.equal(r.status, 0, r.stderr);
	return r.stdout;
}

function section(out, name, next) {
	const start = out.indexOf(`## ${name}`);
	assert.ok(start >= 0, `report has a ${name} section`);
	const end = out.indexOf(`## ${next}`, start);
	assert.ok(end > start, `${name} sits before ${next}`);
	return out.slice(start, end).trim().split("\n").map((l) => l.trim()).filter(Boolean);
}

test("plan audit renders in the timeline, its own section and the headline", () => {
	const dir = tmp();
	const trace = "t-audit";
	fs.mkdirSync(path.join(dir, ".plans", "traces"), { recursive: true });
	const lines = [
		ev(trace, "spec.confirmed", { plan: "p1", data: { spec: ".plans/specs/t-audit.md", requirements: 3 } }),
		// p2's first event is a plan.audit with an event-level round: it must not seed the Rounds round.
		ev(trace, "plan.audit", { plan: "p2", round: 3, data: { verdict: "pass", audit_round: 1, blockers: 0, majors: 0, minors: 2, summary: "notes only" } }),
		ev(trace, "task.start", { plan: "p2", task: "a", data: { model: "opencode-go/alpha", thinking: "low", role: "implement" } }),
		ev(trace, "plan.drafted", { plan: "p1", round: 1, data: { tasks: 2, spec: ".plans/specs/t-audit.md" } }),
		ev(trace, "plan.audit", { plan: "p1", round: 1, data: { verdict: "fail", audit_round: 1, blockers: 2, majors: 1, minors: 0, summary: "missing verify" } }),
		// wrong-style event round: 3 must not touch p1's Rounds round, and audit_round wins.
		ev(trace, "plan.audit", { plan: "p1", round: 3, data: { verdict: "pass", audit_round: 2, blockers: 0, majors: 0, minors: 1, summary: "clean" } }),
	];
	fs.writeFileSync(path.join(dir, ".plans", "traces", `${trace}.jsonl`), `${lines.join("\n")}\n`);

	const out = runReport(dir, trace);

	assert.match(out, /plan audit: PASS audit round 2/);

	const audit = section(out, "Plan audit", "Faults");
	assert.deepEqual(audit.slice(0, 2), [
		"## Plan audit",
		"| plan | audit round | verdict | blockers | majors | minors |",
	]);
	assert.deepEqual(audit.slice(2), [
		"|---|---|---|---|---|---|",
		"| p2 | 1 | PASS | 0 | 0 | 2 |",
		"| p1 | 1 | FAIL | 2 | 1 | 0 |",
		"| p1 | 2 | PASS | 0 | 0 | 1 |",
	]);

	// p1 keeps round 1: the plan.audit events (round 1 then the wrong-style round 3) do not update it.
	assert.match(out, /\| 1 \| p1 \| - \|/);
	// p2's first event seeded nothing, so its row stays "-".
	assert.match(out, /\| - \| p2 \| - \|/);

	assert.match(out, /\| spec\.confirmed \| `spec\.confirmed:p1` \| 3 requirements, \.plans\/specs\/t-audit\.md \|/);
	assert.match(out, /\| plan\.audit \| `plan\.audit:p1` \| FAIL audit round 1: 2 blocker, 1 major, 0 minor: missing verify \|/);
	assert.match(out, /\| plan\.audit \| `plan\.audit:p1` \| PASS audit round 2: 0 blocker, 0 major, 1 minor: clean \|/);
});

test("Plan audit says None. when no plan.audit event exists", () => {
	const dir = tmp();
	const trace = "t-no-audit";
	fs.mkdirSync(path.join(dir, ".plans", "traces"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, ".plans", "traces", `${trace}.jsonl`),
		`${ev(trace, "plan.drafted", { plan: "p1", round: 1, data: { tasks: 1 } })}\n`,
	);
	const audit = section(runReport(dir, trace), "Plan audit", "Faults");
	assert.deepEqual(audit.slice(1), ["None."]);
});
