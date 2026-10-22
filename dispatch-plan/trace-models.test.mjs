/** Run with: node --test dispatch-plan/trace-models.test.mjs (Node 24+) */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const here = path.dirname(new URL(import.meta.url).pathname);
const cli = path.join(here, "trace.mjs");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pi-trace-models-"));

let seq = 0;
function ev(trace, kind, fields = {}) {
	seq += 1;
	return JSON.stringify({
		v: 1,
		ts: new Date(Date.UTC(2026, 9, 20, 12, 0, seq)).toISOString(),
		trace,
		span: `${kind}:${fields.plan || trace}`,
		actor: "pi-dispatch",
		kind,
		plan: "p1",
		...fields,
	});
}

function runReport(dir, trace) {
	const r = spawnSync(process.execPath, [cli, "report", "--trace", trace, "--root", dir], { encoding: "utf8" });
	assert.equal(r.status, 0, r.stderr);
	return r.stdout;
}

function modelsSection(out) {
	const start = out.indexOf("## Models");
	assert.ok(start >= 0, "report has a Models section");
	const end = out.indexOf("## Timeline", start);
	assert.ok(end > start, "Models sits before Timeline");
	return out.slice(start, end).trim().split("\n").map((l) => l.trim()).filter(Boolean);
}

test("Models table covers each model, retries, review cost and faults", () => {
	const dir = tmp();
	const trace = "m-models";
	fs.mkdirSync(path.join(dir, ".plans", "traces"), { recursive: true });
	const lines = [
		ev(trace, "task.start", { task: "a", attempt: 1, data: { model: "opencode-go/alpha", role: "implement", thinking: "low" } }),
		ev(trace, "task.end", { task: "a", attempt: 1, data: { state: "done", tokens: { total: 100 }, cost: 0.01 } }),
		ev(trace, "task.start", { task: "b", attempt: 1, data: { model: "opencode-go/alpha", role: "implement" } }),
		ev(trace, "task.end", { task: "b", attempt: 1, data: { state: "failed", tokens: { total: 50 }, cost: 0.005 } }),
		ev(trace, "task.start", { task: "b", attempt: 2, data: { model: "opencode-go/alpha", role: "implement" } }),
		ev(trace, "task.end", { task: "b", attempt: 2, data: { state: "done", tokens: { total: 60 }, cost: 0.006 } }),
		ev(trace, "task.start", { task: "c", attempt: 1, data: { model: "opencode-go/beta", role: "qa" } }),
		ev(trace, "task.end", { task: "c", attempt: 1, data: { state: "done", tokens: { total: 40 }, cost: 0.002 } }),
		ev(trace, "fault", { task: "a", data: { code: "report_malformed", severity: "error", message: "bad report" } }),
		ev(trace, "fault", { task: "c", data: { code: "tests_not_run", severity: "warn", message: "no tests" } }),
		ev(trace, "task.review", {
			task: "a",
			data: { model: "opencode-go/gamma-review", reviewer_role: "review", verdict: "approve", findings: 0, cost: 0.0003, tokens: { total: 30 } },
		}),
	];
	fs.writeFileSync(path.join(dir, ".plans", "traces", `${trace}.jsonl`), `${lines.join("\n")}\n`);

	const out = runReport(dir, trace);
	const section = modelsSection(out);
	assert.equal(section[0], "## Models");
	assert.deepEqual(section.slice(1, 3), [
		"| model | roles | tasks | reviews | tokens | cost | error faults | warn faults |",
		"|---|---|---|---|---|---|---|---|",
	]);
	const rows = section.slice(3);
	assert.equal(rows.length, 3, `one row per model, got:\n${rows.join("\n")}`);
	assert.equal(rows[0], "| opencode-go/alpha | implement | 2 | 0 | 210 | $0.0210 | 1 | 0 |");
	assert.equal(rows[1], "| opencode-go/beta | qa | 1 | 0 | 40 | $0.0020 | 0 | 1 |");
	assert.equal(rows[2], "| opencode-go/gamma-review | review | 0 | 1 | 30 | $0.0003 | 0 | 0 |");
	assert.ok(out.includes("## Faults"), "Faults section is kept");
	assert.ok(out.includes("## Timeline"), "Timeline section is kept");
});

test("Models says None. when no task started", () => {
	const dir = tmp();
	const trace = "m-empty";
	fs.mkdirSync(path.join(dir, ".plans", "traces"), { recursive: true });
	fs.writeFileSync(path.join(dir, ".plans", "traces", `${trace}.jsonl`), `${ev(trace, "plan.received", { data: { tasks: [] } })}\n`);
	const section = modelsSection(runReport(dir, trace));
	assert.deepEqual(section.slice(1), ["None."]);
});
