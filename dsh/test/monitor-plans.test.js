import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parsePlan, readTraceEvents, selectPlan } from "../plugins/harness-monitor/plans.js";
import { resolveRepos, MAX_REPOS } from "../plugins/harness-monitor/repos.js";
import { cleanup, ev, makePlansDir, writeEvents, writePlan } from "../fixtures/monitor-fixture.js";

test("parsePlan reads frontmatter and both depends_on forms", () => {
	const text = "---\nid: p1\ntrace: t1\nround: 2\n---\n## task: a\ndepends_on: [b, c]\npair: review\n\nbody\n## task: b\ndepends_on: c\n";
	const plan = parsePlan(text);
	assert.equal(plan.id, "p1");
	assert.equal(plan.trace, "t1");
	assert.equal(plan.round, 2);
	assert.deepEqual(plan.tasks[0].dependsOn, ["b", "c"]);
	assert.deepEqual(plan.tasks[1].dependsOn, ["c"]);
	assert.equal(plan.tasks[0].pair, "review");
	assert.equal(plan.tasks[1].pair, null);
});

test("parsePlan defaults trace and round and rejects a missing id", () => {
	assert.equal(parsePlan("---\nid: p\n---\n").trace, "p");
	assert.equal(parsePlan("---\nid: p\n---\n").round, 1);
	assert.equal(parsePlan("---\ntrace: t\n---\n"), null);
});

test("readTraceEvents keeps only this plan and skips bad lines", () => {
	const dir = makePlansDir();
	try {
		writeEvents(dir, "t", [ev("task.start", "p1", "2026-10-22T18:00:00Z", { task: "a" }), ev("task.end", "p2", "2026-10-22T18:00:01Z", { task: "a" })]);
		fs.appendFileSync(path.join(dir, "traces", "t.jsonl"), "{bad\n");
		const events = readTraceEvents(dir, "t", "p1");
		assert.equal(events.length, 1);
		assert.equal(events[0].kind, "task.start");
		assert.deepEqual(readTraceEvents(dir, "missing", "p1"), []);
	} finally {
		cleanup(dir);
	}
});

test("selectPlan prefers running, then newest done by plan.end", () => {
	const dir = makePlansDir();
	try {
		writePlan(dir, "done", "old", [{ id: "a" }]);
		writeEvents(dir, "old", [ev("plan.end", "old", "2026-10-22T18:00:00Z")]);
		writePlan(dir, "done", "new", [{ id: "a" }]);
		writeEvents(dir, "new", [ev("plan.end", "new", "2026-10-22T19:00:00Z")]);
		assert.equal(selectPlan(dir).plan.id, "new");
		writePlan(dir, "running", "live", [{ id: "a" }]);
		assert.equal(selectPlan(dir).plan.id, "live");
		assert.equal(selectPlan(dir).running, true);
	} finally {
		cleanup(dir);
	}
});

test("selectPlan reports missing folders and empty plans", () => {
	assert.equal(selectPlan("/definitely/missing").message, "No plans folder found");
	const dir = makePlansDir();
	try {
		assert.equal(selectPlan(dir).message, "No plan has run yet");
	} finally {
		cleanup(dir);
	}
});

test("resolveRepos handles flags, list, root, single, names and duplicates", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-repos-"));
	try {
		fs.writeFileSync(path.join(tmp, "a"), "");
		fs.mkdirSync(path.join(tmp, "one"));
		fs.mkdirSync(path.join(tmp, "two", ".plans"), { recursive: true });
		fs.mkdirSync(path.join(tmp, ".hidden"));
		const flags = resolveRepos({ flags: [`x=${tmp}/one`, `${tmp}/two/.plans`] }, tmp);
		assert.deepEqual(flags.repos.map((r) => r.name), ["x", "two"]);
		const root = resolveRepos({ root: tmp }, tmp);
		assert.deepEqual(root.repos.map((r) => r.name), ["one", "two"]);
		const single = resolveRepos({ single: `${tmp}/one` }, tmp);
		assert.equal(single.repos[0].name, "one");
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("resolveRepos caps the list and reports the overflow", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-repos-cap-"));
	try {
		for (let i = 0; i < MAX_REPOS + 2; i++) fs.mkdirSync(path.join(tmp, `r${i}`));
		const out = resolveRepos({ root: tmp }, tmp);
		assert.equal(out.repos.length, MAX_REPOS);
		assert.match(out.message, /2 more repos ignored/);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});
