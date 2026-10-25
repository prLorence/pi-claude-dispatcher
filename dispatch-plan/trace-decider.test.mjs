/** Run with: node --test dispatch-plan/trace-decider.test.mjs (Node 24+) */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const here = path.dirname(new URL(import.meta.url).pathname);
const cli = path.join(here, "trace.mjs");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pi-trace-decider-"));

let seq = 0;
function ev(trace, kind, fields = {}) {
	seq += 1;
	return JSON.stringify({
		v: 1,
		ts: new Date(Date.UTC(2026, 9, 23, 12, 0, seq)).toISOString(),
		trace,
		span: `${kind}:${fields.plan || trace}`,
		actor: kind.startsWith("decision.") ? "decider" : "pi-dispatch",
		kind,
		...fields,
		plan: fields.plan ?? "p1",
	});
}

function writeTrace(dir, trace, lines) {
	fs.mkdirSync(path.join(dir, ".plans", "traces"), { recursive: true });
	fs.writeFileSync(path.join(dir, ".plans", "traces", `${trace}.jsonl`), `${lines.join("\n")}\n`);
}

function runReport(dir, trace) {
	const r = spawnSync(process.execPath, [cli, "report", "--trace", trace, "--root", dir], { encoding: "utf8" });
	assert.equal(r.status, 0, r.stderr);
	return r.stdout;
}

function section(out, name, next) {
	const start = out.indexOf(`## ${name}`);
	assert.ok(start >= 0, `report has a ${name} section`);
	const end = next ? out.indexOf(`## ${next}`, start) : -1;
	return out
		.slice(start, end > start ? end : undefined)
		.trim()
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
}

const baseEvents = (trace) => [ev(trace, "plan.received", { round: 1, data: { tasks: [{ id: "t1" }] } })];

const decisionEvents = (trace) => [
	ev(trace, "decision.effort", {
		round: 1,
		data: {
			task: "t1",
			suggested: "high",
			probabilities: { low: 0.2, high: 0.7, max: 0.1 },
			confidence: 0.7,
			complexity: 2,
			model: "perplexity/pplx-decider-flash-v1.2-20261016",
			cost: 0.000004,
			mode: "apply",
		},
	}),
	ev(trace, "decision.audit", {
		round: 1,
		data: {
			model: "perplexity/pplx-decider-flash-v1.2-20261016",
			cost: 0.000012,
			audit_round: 2,
			verdict: "pass",
			proposal: "approve",
			aggregate: 0.3456,
			findings: [],
		},
	}),
	ev(trace, "decision.error", { round: 1, data: { command: "audit", status: 504, kind: "timeout", message: "no answer" } }),
];

test("Decider table has one row per decision event", () => {
	const dir = tmp();
	const trace = "d-mixed";
	writeTrace(dir, trace, [...baseEvents(trace), ...decisionEvents(trace)]);

	const out = runReport(dir, trace);
	const decider = section(out, "Decider", "Timeline");
	assert.deepEqual(decider.slice(1, 3), [
		"| round | command | result | aggregate | cost |",
		"|---|---|---|---|---|",
	]);
	assert.deepEqual(decider.slice(3), [
		"| 1 | effort | t1=high | - | $0.000004 |",
		"| 1 | audit | approve (pass audit round 2) | 0.35 | $0.000012 |",
		"| 1 | audit | error timeout 504 | - | - |",
	]);
	assert.ok(out.indexOf("## Models") < out.indexOf("## Decider"), "Decider sits after Models");
	assert.ok(out.indexOf("## Decider") < out.indexOf("## Timeline"), "Decider sits before Timeline");
});

test("Decider is absent when the trace has no decision events", () => {
	const dir = tmp();
	const trace = "d-none";
	writeTrace(dir, trace, baseEvents(trace));

	const out = runReport(dir, trace);
	assert.ok(!out.includes("## Decider"), "no Decider heading");
	assert.ok(out.includes("## Models"), "Models section is kept");
	assert.ok(out.includes("## Timeline"), "Timeline section is kept");
});

test("decision events leave the other sections unchanged", () => {
	const plainDir = tmp();
	const fullDir = tmp();
	const trace = "d-same";
	writeTrace(plainDir, trace, baseEvents(trace));
	writeTrace(fullDir, trace, [...baseEvents(trace), ...decisionEvents(trace)]);

	const strip = (text) => {
		const start = text.indexOf("## Decider");
		if (start < 0) return text;
		const next = text.indexOf("\n## ", start);
		return next < 0 ? text.slice(0, start) : text.slice(0, start) + text.slice(next + 1);
	};
	const cut = (text) => {
		const i = text.indexOf("## Timeline");
		assert.ok(i > 0, "report has a Timeline section");
		return text.slice(0, i);
	};

	const plainOut = runReport(plainDir, trace);
	const fullOut = runReport(fullDir, trace);
	// The elapsed time in the headline depends on the timestamps, not on the Decider section.
	const headline = (text) => text.replace(/over \d{2}:\d{2}/, "over 00:00");
	assert.equal(headline(strip(cut(fullOut))), headline(cut(plainOut)), "sections before Timeline are identical");
	assert.deepEqual(section(fullOut, "Models", "Decider"), section(plainOut, "Models", "Timeline"), "Models table is identical");
});

test("Decider cells escape pipes", () => {
	const dir = tmp();
	const trace = "d-pipe";
	writeTrace(dir, trace, [
		ev(trace, "decision.effort", { round: 1, data: { task: "a|b", suggested: "low", model: "m", cost: 0.000004, mode: "apply" } }),
	]);

	const rows = section(runReport(dir, trace), "Decider", "Timeline").slice(3);
	assert.deepEqual(rows, ["| 1 | effort | a\\|b=low | - | $0.000004 |"]);
});
