import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	appendEvent,
	changedSince,
	detectFaults,
	evaluateGate,
	parseReport,
	readEvents,
	snapshotDirty,
	toolStats,
	trackedFiles,
} from "../plugins/harness-dispatch/trace.js";

function gitRepo() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-trace-"));
	execFileSync("git", ["init", "-q"], { cwd: root });
	fs.writeFileSync(path.join(root, "tracked.txt"), "one\n");
	execFileSync("git", ["add", "."], { cwd: root });
	execFileSync("git", ["-c", "user.email=a@b.c", "-c", "user.name=a", "commit", "-qm", "init"], { cwd: root });
	return root;
}

const task = (over = {}) => ({ id: "a", files: ["a.ts"], dependsOn: [], state: "done", attempts: 1, pairRound: 0, body: "", summary: "", ...over });
const plan = (tasks) => ({ id: "p", trace: "t", tasks });

test("append and read events keep the on-disk shape", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-events-"));
	try {
		appendEvent(root, { trace: "t", span: "plan:p", actor: "pi-dispatch", kind: "plan.received", plan: "p", round: 1, data: { x: 1 } });
		const events = readEvents(root, "t");
		assert.equal(events.length, 1);
		assert.equal(events[0].v, 1);
		assert.equal(events[0].kind, "plan.received");
		assert.equal(events[0].data.x, 1);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("snapshots see dirty and new files but ignore .plans", () => {
	const root = gitRepo();
	try {
		fs.writeFileSync(path.join(root, "tracked.txt"), "two\n");
		fs.writeFileSync(path.join(root, "new.txt"), "x\n");
		fs.mkdirSync(path.join(root, ".plans"));
		fs.writeFileSync(path.join(root, ".plans", "x"), "x");
		const before = new Map();
		const after = snapshotDirty(root);
		assert.ok(after.has("tracked.txt"));
		assert.ok(after.has("new.txt"));
		assert.equal(after.has(".plans/x"), false);
		assert.deepEqual(changedSince(before, after), ["new.txt", "tracked.txt"]);
		assert.equal(trackedFiles(root).has("tracked.txt"), true);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("parseReport reads STATUS/CHANGED/TESTS/NOTES/NEEDS", () => {
	const r = parseReport("STATUS: done\nCHANGED:\n- a.ts\n- `b.ts`\nTESTS: node --test\nNOTES: x\nNEEDS: none");
	assert.equal(r.status, "done");
	assert.deepEqual(r.changed, ["a.ts", "b.ts"]);
	assert.equal(r.tests, "node --test");
	assert.equal(r.hasAll, true);
	assert.equal(parseReport("CHANGED: (none)").changed.length, 0);
});

test("a clean done task has no error faults", () => {
	const faults = detectFaults({
		cwd: "/repo",
		plan: plan([task()]),
		results: new Map([
			["a", { output: "STATUS: done\nCHANGED: a.ts\nTESTS: none\nNOTES:\nNEEDS:", tools: [{ name: "edit", path: "/repo/a.ts" }] }],
		]),
		changed: ["a.ts"],
		existed: () => false,
		dry: false,
	});
	assert.deepEqual(faults.filter((f) => f.severity === "error"), []);
});

test("out-of-scope edits, unowned changes and verify failures are errors", () => {
	const out = detectFaults({
		cwd: "/repo",
		plan: plan([task()]),
		results: new Map([["a", { output: "STATUS: done\nCHANGED: a.ts\nTESTS: none\nNOTES:\nNEEDS:", tools: [{ name: "edit", path: "/repo/b.ts" }] }]]),
		changed: ["b.ts"],
		dry: false,
	});
	assert.ok(out.some((f) => f.code === "out_of_scope_edit" && f.severity === "error"));
	const stray = detectFaults({ cwd: "/repo", plan: plan([task()]), results: new Map(), changed: ["stray.ts"], dry: false });
	assert.ok(stray.some((f) => f.code === "unowned_change" && f.severity === "error"));
	const verified = detectFaults({ cwd: "/repo", plan: plan([task()]), results: new Map(), changed: [], verify: new Map([["a", { ok: false, summary: "boom" }]]), dry: false });
	assert.ok(verified.some((f) => f.code === "verify_failed" && f.severity === "error"));
});

test("failed and skipped tasks, retries, blocked calls and unread edits are faults", () => {
	const p = plan([task({ state: "failed", summary: "bad" }), task({ id: "b", state: "skipped", summary: "skip" }), task({ id: "c", attempts: 2 })]);
	const faults = detectFaults({
		cwd: "/repo",
		plan: p,
		results: new Map([["c", { output: "STATUS: done\nCHANGED: a.ts\nTESTS: none\nNOTES:\nNEEDS:", tools: [{ name: "bash", detail: "x", blocked: true }, { name: "edit", path: "/repo/a.ts" }] }]]),
		changed: ["a.ts"],
		existed: () => true,
		dry: false,
	});
	assert.ok(faults.some((f) => f.code === "task_failed" && f.severity === "error"));
	assert.ok(faults.some((f) => f.code === "task_skipped" && f.severity === "warn"));
	assert.ok(faults.some((f) => f.code === "retried" && f.severity === "info"));
	assert.ok(faults.some((f) => f.code === "blocked_action" && f.severity === "warn"));
	assert.ok(faults.some((f) => f.code === "edit_unread_file" && f.severity === "warn"));
});

test("security findings map high to error and unknown reports warn", () => {
	const faults = detectFaults({
		cwd: "/repo",
		plan: plan([task()]),
		results: new Map(),
		changed: [],
		reviews: new Map([["a", { role: "security", report: { verdict: "issues", findings: [{ severity: "high", text: "x" }, { text: "y" }] } }]]),
		dry: false,
	});
	assert.ok(faults.some((f) => f.code === "security_finding" && f.severity === "error"));
	assert.ok(faults.some((f) => f.code === "security_finding" && f.severity === "warn"));
	const unparsed = detectFaults({ cwd: "/repo", plan: plan([task()]), results: new Map(), changed: [], reviews: new Map([["a", { role: "security", report: { verdict: "unknown", findings: [] } }]]), dry: false });
	assert.ok(unparsed.some((f) => f.code === "review_unparsed"));
});

test("pair_unresolved is a warning", () => {
	const faults = detectFaults({
		cwd: "/repo",
		plan: plan([task()]),
		results: new Map(),
		changed: [],
		pairs: new Map([["a", { rounds: 2, unresolved: [{ text: "open" }], unparsed: false, finalVerdict: "changes" }]]),
		dry: false,
	});
	assert.ok(faults.some((f) => f.code === "pair_unresolved" && f.severity === "warn"));
});

test("the gate passes only with every task done and zero error faults", () => {
	const p = plan([task()]);
	const pass = evaluateGate(p, [], false, true);
	assert.equal(pass.pass, true);
	assert.equal(pass.evidence, "git+tools");
	assert.equal(evaluateGate(p, [], true, true).pass, false);
	assert.equal(evaluateGate(plan([task({ state: "failed" })]), [], false, true).pass, false);
	assert.equal(evaluateGate(p, [{ code: "x", severity: "error", message: "x" }], false, false).evidence, "tools");
});

test("toolStats counts edits, errors and blocked calls", () => {
	const stats = toolStats([{ name: "edit", path: "/repo/a.ts" }, { name: "bash", isError: true, blocked: true }], "/repo");
	assert.equal(stats.total, 2);
	assert.deepEqual(stats.by_name, { edit: 1, bash: 1 });
	assert.deepEqual(stats.edits, ["a.ts"]);
	assert.equal(stats.errors, 1);
	assert.equal(stats.blocked, 1);
});
