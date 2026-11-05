import { test } from "node:test";
import assert from "node:assert/strict";
import { PlanParseError, parsePlan, readStatus, safeId } from "../plugins/harness-dispatch/plan.js";

const PLAN = `---
id: trace-r1
trace: trace
spec: .plans/specs/trace.md
round: 1
status: ready
max_parallel: 2
verify: npm test
---
Shared context.
Covers: R1.

## task: api
files: src/api.ts, src/api.test.ts
depends_on: []
role: implement
thinking: high
verify: node --test src/api.test.ts
pair: review
pair_rounds: 3
Covers: R1.
Implement the API.

## task: ui
files: src/ui/
depends_on: [api]
Covers: R2.
Do the UI.
`;

test("parses frontmatter and task blocks", () => {
	const plan = parsePlan(PLAN, "fallback");
	assert.equal(plan.id, "trace-r1");
	assert.equal(plan.trace, "trace");
	assert.equal(plan.status, "ready");
	assert.equal(plan.maxParallel, 2);
	assert.equal(plan.verify, "npm test");
	assert.equal(plan.context, "Shared context.\nCovers: R1.");
	assert.equal(plan.tasks.length, 2);
	const [api, ui] = plan.tasks;
	assert.deepEqual(api.files, ["src/api.ts", "src/api.test.ts"]);
	assert.equal(api.role, "implement");
	assert.equal(api.thinking, "high");
	assert.equal(api.verify, "node --test src/api.test.ts");
	assert.equal(api.pair, "review");
	assert.equal(api.pairSource, "task");
	assert.equal(api.pairRounds, 3);
	assert.equal(api.body, "Covers: R1.\nImplement the API.");
	assert.deepEqual(ui.dependsOn, ["api"]);
});

test("missing frontmatter, no tasks and duplicate ids are rejected", () => {
	assert.throws(() => parsePlan("no frontmatter", "x"), PlanParseError);
	assert.throws(() => parsePlan("---\nid: x\n---\n", "x"), /no '## task:/);
	assert.throws(() => parsePlan("---\nid: x\n---\n## task: a\nbody\n## task: a\nbody\n", "x"), /Duplicate task id/);
});

test("unknown dependency and cycles are rejected", () => {
	assert.throws(() => parsePlan("---\nid: x\n---\n## task: a\ndepends_on: [b]\nbody\n", "x"), /unknown task b/);
	const cyc = "---\nid: x\n---\n## task: a\ndepends_on: [b]\nbody\n## task: b\ndepends_on: [a]\nbody\n";
	assert.throws(() => parsePlan(cyc, "x"), /Dependency cycle/);
});

test("pair: none is recorded as the opt-out source", () => {
	const p = parsePlan("---\nid: x\n---\n## task: a\nfiles: a.ts\npair: none\nbody\n", "x");
	assert.equal(p.tasks[0].pair, undefined);
	assert.equal(p.tasks[0].pairSource, "none");
});

test("readStatus reads only frontmatter", () => {
	assert.equal(readStatus("---\nid: x\nstatus: ready # comment\n---\nstatus: draft"), "ready");
	assert.equal(readStatus("no frontmatter"), "");
});

test("safeId replaces unsafe runs", () => {
	assert.equal(safeId("a b/c"), "a-b-c");
	assert.equal(safeId("ok.name-1"), "ok.name-1");
});
