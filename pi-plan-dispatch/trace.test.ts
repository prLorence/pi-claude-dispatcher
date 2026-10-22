/** Run with: node --test pi-plan-dispatch/trace.test.ts (Node 24+) */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG, parsePlan, resumeCommand, runWorker, type Plan, type ToolRecord, type WorkerResult } from "./core.ts";
import { parseReviewReport } from "./review.ts";
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
} from "./trace.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pi-trace-"));

const PLAN = `---
id: feat-r2
trace: feat
parent: feat-r1
round: 2
status: ready
---
Context.

## task: api
files: src/api.ts
depends_on: []
Edit the api. Run npm test when done.

## task: ui
files: src/ui/
depends_on: [api]
Edit the ui.
`;

function done(plan: Plan, ids: string[]) {
	for (const t of plan.tasks) {
		t.state = ids.includes(t.id) ? "done" : "pending";
		t.attempts = 1;
	}
}

const report = (changed: string, tests = "npm test: pass") => `STATUS: done\nCHANGED:\n${changed}\nTESTS: ${tests}\nNOTES: ok\nNEEDS: none`;
const ok = (output: string, tools: WorkerResult["tools"] = []): WorkerResult => ({ ok: true, output, cost: 0, tools });

test("parsePlan reads trace, parent and round", () => {
	const p = parsePlan(PLAN, "x");
	assert.equal(p.trace, "feat");
	assert.equal(p.parent, "feat-r1");
	assert.equal(p.round, 2);
	const q = parsePlan(PLAN.replace(/trace:.*\n|parent:.*\n|round:.*\n/g, ""), "x");
	assert.equal(q.trace, "feat-r2", "trace defaults to the plan id");
	assert.equal(q.parent, undefined);
});

test("parseReport splits sections and ignores none/dry-run", () => {
	const r = parseReport(report("- src/api.ts\n- `src/b.ts`"));
	assert.deepEqual(r.changed, ["src/api.ts", "src/b.ts"]);
	assert.equal(r.hasAll, true);
	assert.deepEqual(parseReport(report("(none)")).changed, []);
	assert.equal(parseReport("just text").hasAll, false);
});

test("parseReport appends a repeated section key", () => {
	const r = parseReport(
		"STATUS: done\nCHANGED: src/api.ts\nCHANGED: src/b.ts\nTESTS: npm test: pass\nTESTS: tsc: pass\nNOTES: first\nNOTES: second\nNEEDS: none",
	);
	assert.deepEqual(r.changed, ["src/api.ts", "src/b.ts"]);
	assert.equal(r.tests, "npm test: pass\ntsc: pass");
	assert.equal(r.hasAll, true);
});

test("parseReport keeps a single section block as before", () => {
	const r = parseReport(report("- src/api.ts\n- src/b.ts"));
	assert.deepEqual(r.changed, ["src/api.ts", "src/b.ts"]);
	assert.equal(r.hasAll, true);
});

test("spread CHANGED lines raise no unreported_change", () => {
	const plan = parsePlan(
		`---\nid: spread-r1\nstatus: ready\n---\n## task: api\nfiles: src/api.ts, src/b.ts\ndepends_on: []\nEdit both.\n`,
		"x",
	);
	done(plan, ["api"]);
	const output = "STATUS: done\nCHANGED: src/api.ts\nCHANGED: src/b.ts\nTESTS: npm test: pass\nNOTES: ok\nNEEDS: none";
	const results = new Map<string, WorkerResult>([
		["api", ok(output, [{ name: "edit", path: "src/api.ts" }, { name: "edit", path: "src/b.ts" }])],
	]);
	const faults = detectFaults({ cwd: "/w", plan, results, changed: ["src/api.ts", "src/b.ts"], dry: false });
	assert.deepEqual(faults.filter((f) => f.code === "unreported_change"), []);
});

test("clean run: no faults, gate passes", () => {
	const plan = parsePlan(PLAN, "x");
	done(plan, ["api", "ui"]);
	const results = new Map<string, WorkerResult>([
		["api", ok(report("src/api.ts"), [{ name: "edit", path: "/w/src/api.ts" }])],
		["ui", ok(report("src/ui/a.tsx", "none"), [{ name: "write", path: "src/ui/a.tsx" }])],
	]);
	const faults = detectFaults({ cwd: "/w", plan, results, changed: ["src/api.ts", "src/ui/a.tsx"], dry: false });
	assert.deepEqual(faults, []);
	const gate = evaluateGate(plan, faults, false, true);
	assert.equal(gate.pass, true);
	assert.equal(gate.evidence, "git+tools");
});

test("out-of-scope edit and unowned change are errors that fail the gate", () => {
	const plan = parsePlan(PLAN, "x");
	done(plan, ["api", "ui"]);
	const results = new Map<string, WorkerResult>([
		["api", ok(report("src/api.ts"), [{ name: "edit", path: "src/api.ts" }, { name: "edit", path: "src/other.ts" }])],
		["ui", ok(report("src/ui/a.tsx", "none"), [{ name: "write", path: "src/ui/a.tsx" }])],
	]);
	const faults = detectFaults({ cwd: "/w", plan, results, changed: ["src/api.ts", "src/other.ts", "src/ui/a.tsx", "package.json"], dry: false });
	const codes = faults.map((f) => `${f.severity}:${f.code}:${f.task ?? ""}`);
	assert.ok(codes.includes("error:out_of_scope_edit:api"));
	assert.ok(codes.includes("error:unowned_change:"));
	assert.equal(evaluateGate(plan, faults, false, true).pass, false);
});

test("report mismatches are warnings, not gate failures", () => {
	const plan = parsePlan(PLAN, "x");
	done(plan, ["api", "ui"]);
	const results = new Map<string, WorkerResult>([
		// claims src/api.ts but made no edit and nothing changed; says tests: none though the task names npm test
		["api", ok(report("src/api.ts", "none"), [])],
		["ui", ok(report("(none)", "none"), [{ name: "edit", path: "src/ui/a.tsx" }])],
	]);
	const faults = detectFaults({ cwd: "/w", plan, results, changed: ["src/ui/a.tsx"], dry: false });
	const codes = faults.map((f) => `${f.code}:${f.task}`);
	assert.ok(codes.includes("claimed_not_changed:api"));
	assert.ok(codes.includes("no_op_done:api"));
	assert.ok(codes.includes("tests_not_run:api"));
	assert.ok(codes.includes("unreported_change:ui"));
	assert.ok(faults.every((f) => f.severity !== "error"));
	assert.equal(evaluateGate(plan, faults, false, true).pass, true);
});

test("failed and skipped tasks fail the gate; dry run never passes", () => {
	const plan = parsePlan(PLAN, "x");
	plan.tasks[0].state = "failed";
	plan.tasks[0].summary = "boom\nmore";
	plan.tasks[1].state = "skipped";
	const faults = detectFaults({ cwd: "/w", plan, results: new Map(), changed: [], dry: false });
	assert.deepEqual(faults.map((f) => f.code), ["task_failed", "task_skipped"]);
	const g = evaluateGate(plan, faults, false, true);
	assert.equal(g.pass, false);
	done(plan, ["api", "ui"]);
	assert.equal(evaluateGate(plan, [], true, false).pass, false);
});

test("verify_failed is an error, per task and for the plan", () => {
	const plan = parsePlan(PLAN, "x");
	done(plan, ["api", "ui"]);
	const results = new Map<string, WorkerResult>([
		["api", ok(report("src/api.ts"), [{ name: "edit", path: "src/api.ts" }])],
		["ui", ok(report("src/ui/a.tsx", "none"), [{ name: "write", path: "src/ui/a.tsx" }])],
	]);
	const verify = new Map([
		["api", { ok: false, summary: "npm test exited 1" }],
		["ui", { ok: true, summary: "ok" }],
	]);
	const faults = detectFaults({ cwd: "/w", plan, results, changed: ["src/api.ts", "src/ui/a.tsx"], verify, dry: false });
	assert.deepEqual(
		faults.map((f) => `${f.severity}:${f.code}:${f.task ?? ""}`),
		["error:verify_failed:api"],
	);
	assert.match(faults[0].message, /npm test exited 1/);
	assert.equal(evaluateGate(plan, faults, false, true).pass, false);

	const planWide = detectFaults({ cwd: "/w", plan, results, changed: ["src/api.ts", "src/ui/a.tsx"], verify: new Map([["*", { ok: false, summary: "integration check failed" }]]), dry: false });
	assert.deepEqual(planWide.map((f) => [f.code, f.task]), [["verify_failed", undefined]]);
	assert.equal(evaluateGate(plan, planWide, false, true).pass, false);

	// all verified: no fault
	const clean = detectFaults({ cwd: "/w", plan, results, changed: ["src/api.ts", "src/ui/a.tsx"], verify: new Map([["api", { ok: true, summary: "ok" }], ["*", { ok: true, summary: "ok" }]]), dry: false });
	assert.deepEqual(clean, []);
});

test("blocked_action warns once per task and lists up to three calls", () => {
	const plan = parsePlan(PLAN, "x");
	done(plan, ["api", "ui"]);
	const blocked = (name: string, p?: string, detail?: string) => ({ name, path: p, detail, isError: true, blocked: true });
	const results = new Map<string, WorkerResult>([
		[
			"api",
			ok(report("src/api.ts"), [
				{ name: "edit", path: "src/api.ts" },
				blocked("edit", "src/secret.ts"),
				blocked("bash", undefined, "git push origin main"),
				blocked("write", "src/other.ts"),
				blocked("patch", "src/more.ts"),
			]),
		],
		["ui", ok(report("src/ui/a.tsx", "none"), [{ name: "write", path: "src/ui/a.tsx" }])],
	]);
	const faults = detectFaults({ cwd: "/w", plan, results, changed: ["src/api.ts", "src/ui/a.tsx"], dry: false });
	const b = faults.filter((f) => f.code === "blocked_action");
	assert.equal(b.length, 1, "one fault per task");
	assert.equal(b[0].severity, "warn");
	assert.equal(b[0].task, "api");
	assert.match(b[0].message, /4 tool call/);
	assert.match(b[0].message, /edit src\/secret\.ts/);
	assert.match(b[0].message, /bash git push origin main/);
	assert.doesNotMatch(b[0].message, /src\/more\.ts/, "only the first three are listed");
	assert.ok(!faults.some((f) => f.code === "out_of_scope_edit"), "a blocked call is not an edit");
	assert.equal(evaluateGate(plan, faults, false, true).pass, true, "warn does not fail the gate");
});

test("edit_unread_file warns for pre-existing files without an earlier read", () => {
	const plan = parsePlan(PLAN, "x");
	done(plan, ["api", "ui"]);
	const existing = new Set(["src/api.ts", "src/ui/a.tsx", "src/old.ts"]);
	const results = new Map<string, WorkerResult>([
		[
			"api",
			ok(report("src/api.ts"), [
				{ name: "edit", path: "src/api.ts" }, // pre-existing, never read -> hit
				{ name: "write", path: "src/brand-new.ts" }, // new file -> exempt
				{ name: "bash", detail: "cat src/old.ts" },
				{ name: "edit", path: "src/old.ts" }, // bash mentioned it earlier -> ok
			]),
		],
		[
			"ui",
			ok(report("src/ui/a.tsx", "none"), [
				{ name: "read", path: "src/ui/a.tsx" },
				{ name: "edit", path: "src/ui/a.tsx" }, // read first -> ok
			]),
		],
	]);
	const existed = (p: string) => existing.has(p);
	const faults = detectFaults({ cwd: "/w", plan, results, changed: ["src/api.ts", "src/ui/a.tsx"], existed, dry: false });
	const f = faults.filter((x) => x.code === "edit_unread_file");
	assert.equal(f.length, 1);
	assert.equal(f[0].severity, "warn");
	assert.equal(f[0].task, "api");
	assert.match(f[0].message, /src\/api\.ts/);
	assert.doesNotMatch(f[0].message, /brand-new|src\/old/);

	// without `existed` the check is skipped entirely
	const skipped = detectFaults({ cwd: "/w", plan, results, changed: ["src/api.ts", "src/ui/a.tsx"], dry: false });
	assert.equal(skipped.filter((x) => x.code === "edit_unread_file").length, 0);
});

test("trackedFiles lists git-tracked paths, undefined outside a repo", () => {
	assert.equal(trackedFiles(tmp()), undefined, "not a git repo");
	const dir = tmp();
	const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
	git("init", "-q");
	git("config", "user.email", "t@t");
	git("config", "user.name", "t");
	fs.mkdirSync(path.join(dir, "src"));
	fs.writeFileSync(path.join(dir, "src", "a.ts"), "1");
	fs.writeFileSync(path.join(dir, "b.md"), "1");
	git("add", "src/a.ts", "b.md");
	git("commit", "-qm", "init");
	fs.writeFileSync(path.join(dir, "untracked.ts"), "1");
	const files = trackedFiles(dir)!;
	assert.deepEqual([...files].sort(), ["b.md", "src/a.ts"]);
	assert.equal(files.has("untracked.ts"), false);
});

test("toolStats counts blocked results", () => {
	const stats = toolStats(
		[
			{ name: "edit", path: "src/a.ts" },
			{ name: "bash", detail: "git push", isError: true, blocked: true },
			{ name: "write", path: "src/b.ts", blocked: true },
		],
		"/w",
	);
	assert.equal(stats.total, 3);
	assert.equal(stats.errors, 1);
	assert.equal(stats.blocked, 2);
	assert.equal(toolStats(undefined, "/w").blocked, 0);
});

test("snapshots detect changes made during a run, including re-edits of dirty files", () => {
	const dir = tmp();
	const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
	git("init", "-q");
	git("config", "user.email", "t@t");
	git("config", "user.name", "t");
	fs.writeFileSync(path.join(dir, "a.ts"), "1");
	fs.writeFileSync(path.join(dir, "b.ts"), "1");
	git("add", ".");
	git("commit", "-qm", "init");
	fs.writeFileSync(path.join(dir, "a.ts"), "dirty before"); // already dirty
	const before = snapshotDirty(dir)!;
	fs.writeFileSync(path.join(dir, "a.ts"), "edited again");
	fs.writeFileSync(path.join(dir, "c.ts"), "new");
	fs.mkdirSync(path.join(dir, ".plans"));
	fs.writeFileSync(path.join(dir, ".plans", "x.md"), "ignored");
	const after = snapshotDirty(dir)!;
	assert.deepEqual(changedSince(before, after), ["a.ts", "c.ts"]);
	assert.equal(snapshotDirty(tmp()), undefined, "not a git repo");
});

test("runWorker records tool calls and token usage from Pi's event stream", async () => {
	const dir = tmp();
	const fake = path.join(dir, "fake-pi.mjs");
	const ev = (o: unknown) => `console.log(${JSON.stringify(JSON.stringify(o))});`;
	fs.writeFileSync(
		fake,
		[
			"#!/usr/bin/env node",
			`import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(path.join(dir, "argv.json"))}, JSON.stringify(process.argv.slice(2)));`,
			ev({ type: "tool_execution_start", toolCallId: "1", toolName: "edit", args: { path: "src/api.ts" } }),
			ev({ type: "tool_execution_end", toolCallId: "1", toolName: "edit", isError: false }),
			ev({ type: "tool_execution_start", toolCallId: "2", toolName: "bash", args: { command: "npm test" } }),
			ev({ type: "tool_execution_end", toolCallId: "2", toolName: "bash", isError: true }),
			ev({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "STATUS: done\nCHANGED:\nsrc/api.ts\nTESTS: x\nNOTES: y\nNEEDS: none" }],
					usage: { input: 100, output: 20, totalTokens: 120, cost: { total: 0.01 } },
					stopReason: "stop",
				},
			}),
		].join("\n"),
	);
	fs.chmodSync(fake, 0o755);
	const plan = parsePlan(PLAN, "x");
	const r = await runWorker(dir, { ...DEFAULT_CONFIG, piCommand: fake }, plan, plan.tasks[0], new AbortController().signal);
	assert.equal(r.ok, true);
	assert.deepEqual(r.tokens, { input: 100, output: 20, total: 120 });
	assert.equal(r.cost, 0.01);
	assert.deepEqual(r.tools?.map((t) => [t.name, t.path ?? t.detail, !!t.isError]), [["edit", "src/api.ts", false], ["bash", "npm test", true]]);
	assert.equal(r.model, DEFAULT_CONFIG.model);

	// sessions are persisted by default: one named session per task attempt, never --no-session
	const argv: string[] = JSON.parse(fs.readFileSync(path.join(dir, "argv.json"), "utf8"));
	assert.ok(!argv.includes("--no-session"));
	assert.equal(argv[argv.indexOf("--session-id") + 1], "feat-r2.api.a0");
	assert.equal(argv[argv.indexOf("--session-dir") + 1], path.join(dir, ".plans/sessions/feat-r2"));
	assert.equal(argv[argv.indexOf("--name") + 1], "feat-r2/api");
	assert.equal(r.session?.id, "feat-r2.api.a0");
	assert.equal(resumeCommand(dir, r.session!), "pi --session feat-r2.api.a0 --session-dir .plans/sessions/feat-r2");

	// ...and switched off by config
	await runWorker(dir, { ...DEFAULT_CONFIG, piCommand: fake, persistSessions: false }, plan, plan.tasks[0], new AbortController().signal);
	const off: string[] = JSON.parse(fs.readFileSync(path.join(dir, "argv.json"), "utf8"));
	assert.ok(off.includes("--no-session") && !off.includes("--session-id"));
});

test("trace.mjs: event, report, gate and wait share one trace file", () => {
	const dir = tmp();
	const cli = path.resolve(import.meta.dirname, "../dispatch-plan/trace.mjs");
	const run = (...a: string[]) => spawnSync("node", [cli, ...a, "--root", dir], { encoding: "utf8" });

	assert.equal(run("event", "--trace", "t1", "--actor", "sonnet-planner", "--kind", "plan.drafted", "--plan", "t1-r1", "--round", "1", "--data", '{"tasks":2}').status, 0);
	// what the extension would write
	appendEvent(path.join(dir, ".plans"), { trace: "t1", span: "plan:t1-r1:end", parent: "plan:t1-r1", actor: "pi-dispatch", kind: "plan.end", plan: "t1-r1", round: 1, data: { done: 2, failed: 0, skipped: 0, cost: 0.02, duration_s: 30, gate_pass: true } });
	appendEvent(path.join(dir, ".plans"), { trace: "t1", span: "gate:t1-r1", parent: "plan:t1-r1", actor: "pi-dispatch", kind: "gate", plan: "t1-r1", round: 1, data: { pass: true, reasons: [], counts: { error: 0, warn: 1, info: 0 } } });
	assert.equal(run("event", "--trace", "t1", "--actor", "opus-auditor", "--kind", "audit.verdict", "--plan", "t1-r1", "--data", '{"verdict":"pass","findings":0}').status, 0);
	assert.equal(readEvents(path.join(dir, ".plans"), "t1").length, 4);

	const rep = run("report", "--trace", "t1");
	assert.equal(rep.status, 0);
	assert.match(rep.stdout, /\| 1 \| t1-r1 \| - \| 2\/0\/0 \| PASS \| PASS \(0\) \|/);
	assert.ok(fs.existsSync(path.join(dir, ".plans/traces/t1.md")));

	assert.equal(run("gate", "--plan", "t1-r1").status, 2, "no evidence yet");
	fs.mkdirSync(path.join(dir, ".plans/done/t1-r1"), { recursive: true });
	fs.writeFileSync(path.join(dir, ".plans/done/t1-r1/evidence.json"), JSON.stringify({ plan: "t1-r1", round: 1, gate: { pass: false }, faults: [], changed: [] }));
	assert.equal(run("gate", "--plan", "t1-r1").status, 1);

	fs.writeFileSync(path.join(dir, ".plans/done/t1-r1/_summary.md"), "# done");
	const w = run("wait", "--plan", "t1-r1", "--timeout", "5");
	assert.equal(w.status, 0);
	assert.match(w.stdout, /GATE FAIL/);
	assert.equal(run("wait", "--plan", "nope", "--timeout", "1").status, 3);
	// stale rejection from an earlier drop is ignored while the plan sits in the inbox
	fs.mkdirSync(path.join(dir, ".plans/failed"), { recursive: true });
	fs.mkdirSync(path.join(dir, ".plans/inbox"), { recursive: true });
	const stale = path.join(dir, ".plans/failed/again.error.md");
	fs.writeFileSync(stale, "old");
	fs.utimesSync(stale, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
	fs.writeFileSync(path.join(dir, ".plans/inbox/again.md"), "x");
	assert.equal(run("wait", "--plan", "again", "--timeout", "1", "--pickup", "100").status, 3);
	assert.match(run("new-id", "My Feature!").stdout, /^\d{8}-\d{4}-my-feature\n$/);
});

// ---------- Roles: read-only reviewers, pair reviews, security findings ----------

const SEC = `---
id: sec-r1
status: ready
---
Context: harden the auth path.

## task: audit
role: security
files: src/api.ts
depends_on: []
Look for injection in src/api.ts.
`;

/** The fixture is one read-only security task. */
const secPlan = () => parsePlan(SEC, "x");

test("read-only task: no implementer faults, a clean security verdict passes the gate", () => {
	const plan = secPlan();
	done(plan, ["audit"]);
	const text = "I inspected src/api.ts.\nVERDICT: clean\nFINDINGS: none";
	const results = new Map<string, WorkerResult>([
		["audit", ok(text, [{ name: "read", path: "src/api.ts" }, { name: "bash", detail: "git diff -- src/api.ts" }])],
	]);
	const reviews = new Map([["audit", { role: "security", report: parseReviewReport(text) }]]);
	const faults = detectFaults({ cwd: "/w", plan, results, changed: [], readonlyTasks: new Set(["audit"]), reviews, dry: false });
	assert.deepEqual(faults, [], "no report_malformed / no_op_done / tests_not_run for a read-only task");
	assert.equal(evaluateGate(plan, faults, false, true).pass, true);
});

test("read-only task that edits anything is a readonly_violation error", () => {
	const plan = secPlan();
	done(plan, ["audit"]);
	const clean = "VERDICT: clean\nFINDINGS: none";
	const results = new Map<string, WorkerResult>([["audit", ok(clean, [{ name: "edit", path: "src/api.ts" }])]]);
	const faults = detectFaults({ cwd: "/w", plan, results, changed: ["src/api.ts"], readonlyTasks: new Set(["audit"]), dry: false });
	assert.deepEqual(
		faults.map((f) => `${f.severity}:${f.code}:${f.task}`),
		["error:readonly_violation:audit"],
	);
	assert.match(faults[0].message, /src\/api\.ts/);
	assert.equal(evaluateGate(plan, faults, false, true).pass, false);

	// git evidence alone is enough
	const gitOnly = detectFaults({ cwd: "/w", plan, results: new Map([["audit", ok(clean, [])]]), changed: ["src/api.ts"], readonlyTasks: new Set(["audit"]), dry: false });
	assert.deepEqual(gitOnly.map((f) => f.code), ["readonly_violation"]);

	// a blocked call changed nothing: it stays a blocked_action warning
	const blocked = detectFaults({
		cwd: "/w",
		plan,
		results: new Map([["audit", ok(clean, [{ name: "edit", path: "src/api.ts", isError: true, blocked: true }])]]),
		changed: [],
		readonlyTasks: new Set(["audit"]),
		dry: false,
	});
	assert.deepEqual(blocked.map((f) => f.code), ["blocked_action"]);
});

test("security findings become faults with severity high=error, medium=warn, low=info", () => {
	const plan = secPlan();
	done(plan, ["audit"]);
	const text = [
		"I inspected the files.",
		"VERDICT: issues",
		"FINDINGS:",
		"- [high] src/api.ts:42: SQL built from req.query. Use a parameterised query.",
		"- [medium] src/api.ts:9: no rate limit on login. Add one.",
		"- [low] src/api.ts:70: verbose error text. Trim it.",
		"- src/api.ts:100: open redirect. Validate the target.",
	].join("\n");
	const reviews = new Map([["audit", { role: "security", report: parseReviewReport(text) }]]);
	const results = new Map<string, WorkerResult>([["audit", ok(text, [{ name: "read", path: "src/api.ts" }])]]);
	const faults = detectFaults({ cwd: "/w", plan, results, changed: [], readonlyTasks: new Set(["audit"]), reviews, dry: false });
	assert.deepEqual(
		faults.map((f) => `${f.severity}:${f.code}:${f.task}`),
		[
			"error:security_finding:audit",
			"warn:security_finding:audit",
			"info:security_finding:audit",
			"warn:security_finding:audit",
		],
		"an unlabelled finding counts as medium",
	);
	assert.equal(faults[0].message, "src/api.ts:42: SQL built from req.query. Use a parameterised query.");
	assert.equal(faults[1].message, "src/api.ts:9: no rate limit on login. Add one.");
	assert.equal(faults[3].message, "src/api.ts:100: open redirect. Validate the target.");
	const gate = evaluateGate(plan, faults, false, true);
	assert.equal(gate.pass, false);
	assert.equal(gate.counts.error, 1);
});

test("review findings only: an approve, a changes verdict or a pair review are not security faults", () => {
	const plan = parsePlan(PLAN, "x");
	done(plan, ["api", "ui"]);
	const results = new Map<string, WorkerResult>([
		["api", ok(report("src/api.ts"), [{ name: "edit", path: "src/api.ts" }])],
		["ui", ok(report("src/ui/a.tsx", "none"), [{ name: "write", path: "src/ui/a.tsx" }])],
	]);
	const reviews = new Map([
		["api", { role: "review", report: parseReviewReport("VERDICT: changes\nFINDINGS:\n- [high] src/api.ts:1: bad branch. Fix it.") }],
		["ui", { role: "review", report: parseReviewReport("VERDICT: approve\nFINDINGS: none") }],
	]);
	const faults = detectFaults({ cwd: "/w", plan, results, changed: ["src/api.ts", "src/ui/a.tsx"], reviews, dry: false });
	assert.deepEqual(faults, []);
});

test("pair_unresolved warns with up to three findings and the count", () => {
	const plan = parsePlan(PLAN, "x");
	done(plan, ["api"]);
	const results = new Map<string, WorkerResult>([["api", ok(report("src/api.ts"), [{ name: "edit", path: "src/api.ts" }])]]);
	const unresolved = [1, 2, 3, 4, 5].map((i) => ({ location: `src/api.ts:${i}`, text: `problem ${i}. Fix it.` }));
	const pairs = new Map([["api", { rounds: 2, unresolved, unparsed: false }]]);
	const faults = detectFaults({ cwd: "/w", plan, results, changed: ["src/api.ts"], pairs, dry: false });
	assert.deepEqual(
		faults.map((f) => `${f.severity}:${f.code}:${f.task}`),
		["warn:pair_unresolved:api"],
	);
	assert.match(faults[0].message, /5 finding\(s\) still open after 2 pair round\(s\)/);
	assert.match(faults[0].message, /src\/api\.ts:1: problem 1\. Fix it\./);
	assert.match(faults[0].message, /src\/api\.ts:3/);
	assert.doesNotMatch(faults[0].message, /src\/api\.ts:4/, "only the first three are listed");
	assert.match(faults[0].message, /\(\+2 more\)/);
	assert.equal(evaluateGate(plan, faults, false, true).pass, true, "warn does not fail the gate");

	// a resolved pair review is silent
	const clean = detectFaults({ cwd: "/w", plan, results, changed: ["src/api.ts"], pairs: new Map([["api", { rounds: 1, unresolved: [], unparsed: false }]]), dry: false });
	assert.deepEqual(clean, []);
});

test("review_unparsed warns for an unparseable pair review and a security review with no verdict", () => {
	const plan = parsePlan(PLAN, "x");
	done(plan, ["api"]);
	const results = new Map<string, WorkerResult>([["api", ok(report("src/api.ts"), [{ name: "edit", path: "src/api.ts" }])]]);
	const pair = detectFaults({ cwd: "/w", plan, results, changed: ["src/api.ts"], pairs: new Map([["api", { rounds: 1, unresolved: [], unparsed: true }]]), dry: false });
	assert.deepEqual(
		pair.map((f) => `${f.severity}:${f.code}:${f.task}`),
		["warn:review_unparsed:api"],
	);
	assert.equal(evaluateGate(plan, pair, false, true).pass, true);

	const sec = secPlan();
	done(sec, ["audit"]);
	const text = "I looked at the files, seems fine to me.";
	const unparsed = detectFaults({
		cwd: "/w",
		plan: sec,
		results: new Map<string, WorkerResult>([["audit", ok(text, [{ name: "read", path: "src/api.ts" }])]]),
		changed: [],
		readonlyTasks: new Set(["audit"]),
		reviews: new Map([["audit", { role: "security", report: parseReviewReport(text) }]]),
		dry: false,
	});
	assert.deepEqual(
		unparsed.map((f) => `${f.severity}:${f.code}:${f.task}`),
		["warn:review_unparsed:audit"],
	);
});

// ---------- Read-only attribution, reviewer backstop, pair verdict, retry count ----------

const MIXED = `---
id: mixed-r1
status: ready
---
Context.

## task: impl
files: src/api.ts
depends_on: []
Edit the api. Run npm test.

## task: audit
role: security
files: src/api.ts
depends_on: [impl]
Look for injection in src/api.ts.
`;

const cleanReport = (changed: string) => report(changed, "npm test: pass");

/** An implementer and a security task on the same file, the normal layout. */
function mixedRun() {
	const plan = parsePlan(MIXED, "x");
	done(plan, ["impl", "audit"]);
	const sec = "I inspected src/api.ts.\nVERDICT: clean\nFINDINGS: none";
	const results = new Map<string, WorkerResult>([
		["impl", ok(cleanReport("src/api.ts"), [{ name: "edit", path: "src/api.ts" }])],
		["audit", ok(sec, [{ name: "read", path: "src/api.ts" }])],
	]);
	return {
		mixed: { cwd: "/w", plan, results, changed: ["src/api.ts"], readonlyTasks: new Set(["audit"]), reviews: new Map([["audit", { role: "security", report: parseReviewReport(sec) }]]), dry: false },
		plan,
		results,
	};
}

test("a security task is not blamed for changes an implementer made to the same file", () => {
	const { mixed, plan } = mixedRun();
	const faults = detectFaults(mixed);
	assert.deepEqual(faults, [], "the file is also owned by an implementer, so it is not the reviewer's change");
	assert.equal(evaluateGate(plan, faults, false, true).pass, true);

	// the same file, but nobody else owns it: still the read-only task's fault
	const solo = parsePlan(MIXED, "x").tasks[1];
	const plan2 = parsePlan(MIXED, "x");
	plan2.tasks = [solo];
	done(plan2, ["audit"]);
	const alone = detectFaults({ cwd: "/w", plan: plan2, results: mixed.results, changed: ["src/api.ts"], readonlyTasks: new Set(["audit"]), dry: false });
	assert.deepEqual(
		alone.map((f) => `${f.severity}:${f.code}:${f.task}`),
		["error:readonly_violation:audit"],
	);
});

test("pair reviewer edits, dirty files and blocked calls are faults on the reviewed task", () => {
	const plan = parsePlan(PLAN, "x");
	done(plan, ["api", "ui"]);
	const results = new Map<string, WorkerResult>([
		["api", ok(cleanReport("src/api.ts"), [{ name: "edit", path: "src/api.ts" }])],
		["ui", ok(cleanReport("src/ui/a.tsx"), [{ name: "write", path: "src/ui/a.tsx" }])],
	]);
	const changed = ["src/api.ts", "src/ui/a.tsx"];

	const reviewed = detectFaults({ cwd: "/w", plan, results, changed, reviewerTools: new Map<string, ToolRecord[]>([["api", [{ name: "write", path: "src/api.ts" }]]]), dry: false });
	assert.deepEqual(
		reviewed.map((f) => `${f.severity}:${f.code}:${f.task}`),
		["error:readonly_violation:api"],
	);
	assert.match(reviewed[0].message, /pair reviewer changed files: src\/api\.ts/);
	assert.equal(evaluateGate(plan, reviewed, false, true).pass, false);

	// a shell write gets past the tool guard; the dirty-file snapshot is the backstop
	const snapshot = detectFaults({ cwd: "/w", plan, results, changed, reviewerWindows: new Map([["ui", [{ changed: ["src/ui/a.tsx"], concurrent: [] }]]]), dry: false });
	assert.deepEqual(
		snapshot.map((f) => `${f.severity}:${f.code}:${f.task}`),
		["error:readonly_violation:ui"],
	);
	assert.match(snapshot[0].message, /pair reviewer changed files: src\/ui\/a\.tsx/);

	// a blocked call changed nothing: it stays a blocked_action warning
	const blocked = detectFaults({
		cwd: "/w",
		plan,
		results,
		changed,
		reviewerTools: new Map<string, ToolRecord[]>([["api", [{ name: "edit", path: "src/api.ts", isError: true, blocked: true }]]]),
		dry: false,
	});
	assert.deepEqual(
		blocked.map((f) => `${f.severity}:${f.code}:${f.task}`),
		["warn:blocked_action:api"],
	);
	assert.match(blocked[0].message, /1 tool call\(s\) blocked by the guard: edit src\/api\.ts/);
});

test("pair_unresolved fires for a changes verdict even with no findings listed", () => {
	const plan = parsePlan(PLAN, "x");
	done(plan, ["api"]);
	const results = new Map<string, WorkerResult>([["api", ok(cleanReport("src/api.ts"), [{ name: "edit", path: "src/api.ts" }])]]);
	const pairs = new Map([["api", { rounds: 2, unresolved: [], unparsed: false, finalVerdict: "changes" as const }]]);
	const faults = detectFaults({ cwd: "/w", plan, results, changed: ["src/api.ts"], pairs, dry: false });
	assert.deepEqual(
		faults.map((f) => `${f.severity}:${f.code}:${f.task}`),
		["warn:pair_unresolved:api"],
	);
	assert.match(faults[0].message, /ended in changes after 2 pair round\(s\)/);
	assert.equal(evaluateGate(plan, faults, false, true).pass, true);

	const approved = detectFaults({
		cwd: "/w",
		plan,
		results,
		changed: ["src/api.ts"],
		pairs: new Map([["api", { rounds: 1, unresolved: [], unparsed: false, finalVerdict: "approve" as const }]]),
		dry: false,
	});
	assert.deepEqual(approved, []);
});

test("retried ignores pair re-runs and counts failed attempts only", () => {
	const plan = parsePlan(PLAN, "x");
	done(plan, ["api", "ui"]);
	const results = new Map<string, WorkerResult>([
		["api", ok(cleanReport("src/api.ts"), [{ name: "edit", path: "src/api.ts" }])],
		["ui", ok(cleanReport("src/ui/a.tsx"), [{ name: "write", path: "src/ui/a.tsx" }])],
	]);
	const changed = ["src/api.ts", "src/ui/a.tsx"];

	// two pair re-runs, one attempt each: no retry
	plan.tasks[0].attempts = 3;
	plan.tasks[0].pairRound = 2;
	const pairOnly = detectFaults({ cwd: "/w", plan, results, changed, dry: false });
	assert.deepEqual(pairOnly.map((f) => f.code), []);

	// one retry plus two pair re-runs: one retried info fault, naming the implementer attempt
	plan.tasks[1].attempts = 4;
	plan.tasks[1].pairRound = 2;
	const retried = detectFaults({ cwd: "/w", plan, results, changed, dry: false });
	assert.deepEqual(
		retried.map((f) => `${f.severity}:${f.code}:${f.task}`),
		["info:retried:ui"],
	);
	assert.match(retried[0].message, /succeeded on attempt 2/);
});

// ---------- Window rule: a read-only run is blamed for every file a concurrent task does not own ----------

const PAIRPLAN = `---
id: pairr1
status: ready
---
Context.

## task: a
files: src/a.ts
depends_on: []
pair: review
Edit a.

## task: b
files: src/b.ts
depends_on: []
Edit b.

## task: c
files: src/c.ts
depends_on: []
Edit c.
`;

/** Three tasks done in one checkout: A is pair-reviewed, B and C edit their own files. */
function pairRun() {
	const plan = parsePlan(PAIRPLAN, "x");
	done(plan, ["a", "b", "c"]);
	const results = new Map<string, WorkerResult>([
		["a", ok(cleanReport("src/a.ts"), [{ name: "edit", path: "src/a.ts" }])],
		["b", ok(cleanReport("src/b.ts"), [{ name: "edit", path: "src/b.ts" }])],
		["c", ok(cleanReport("src/c.ts"), [{ name: "edit", path: "src/c.ts" }])],
	]);
	return { plan, results, changed: ["src/a.ts", "src/b.ts", "src/c.ts"] };
}

test("a pair reviewer window blames files of tasks that are not concurrent, and spares the concurrent ones", () => {
	const { plan, results, changed } = pairRun();

	// B and C edited their own files while A's reviewer ran: their writes, not A's fault.
	const parallel = detectFaults({
		cwd: "/w",
		plan,
		results,
		changed,
		reviewerWindows: new Map([["a", [{ changed: ["src/b.ts", "src/c.ts"], concurrent: ["b", "c"] }]]]),
		dry: false,
	});
	assert.deepEqual(parallel, []);
	assert.equal(evaluateGate(plan, parallel, false, true).pass, true);

	// The reviewed task's implementer is not running during its reviewer run, so its own file is.
	const own = detectFaults({
		cwd: "/w",
		plan,
		results,
		changed,
		reviewerWindows: new Map([["a", [{ changed: ["src/a.ts"], concurrent: [] }]]]),
		dry: false,
	});
	assert.deepEqual(
		own.map((f) => `${f.severity}:${f.code}:${f.task}`),
		["error:readonly_violation:a"],
	);
	assert.match(own[0].message, /pair reviewer changed files: src\/a\.ts/);
	assert.equal(evaluateGate(plan, own, false, true).pass, false);
});

test("a pair reviewer window blames a finished dependency's file", () => {
	const plan = parsePlan(
		`---
id: dep-r1
status: ready
---
Context.

## task: b
files: src/b.ts
depends_on: []
Write b.

## task: a
files: src/a.ts
depends_on: [b]
pair: review
Edit a.
`,
		"x",
	);
	done(plan, ["a", "b"]);
	const results = new Map<string, WorkerResult>([
		["a", ok(cleanReport("src/a.ts"), [{ name: "edit", path: "src/a.ts" }])],
		["b", ok(cleanReport("src/b.ts"), [{ name: "edit", path: "src/b.ts" }])],
	]);
	// B had finished before A's reviewer ran, so nobody else was running: the change is A's.
	const faults = detectFaults({
		cwd: "/w",
		plan,
		results,
		changed: ["src/a.ts", "src/b.ts"],
		reviewerWindows: new Map([["a", [{ changed: ["src/b.ts"], concurrent: [] }]]]),
		dry: false,
	});
	assert.deepEqual(
		faults.map((f) => `${f.severity}:${f.code}:${f.task}`),
		["error:readonly_violation:a"],
	);
	assert.match(faults[0].message, /pair reviewer changed files: src\/b\.ts/);
	assert.equal(evaluateGate(plan, faults, false, true).pass, false);
});

test("a pair reviewer window blames an unowned file, with or without a files-less task in the plan", () => {
	const { plan, results, changed } = pairRun();
	// src/stray.ts belongs to no task, so only the window rule can blame it.
	const stray = detectFaults({
		cwd: "/w",
		plan,
		results,
		changed: [...changed, "src/stray.ts"],
		reviewerWindows: new Map([["a", [{ changed: ["src/stray.ts"], concurrent: ["ghost"] }]]]),
		dry: false,
	});
	assert.deepEqual(
		stray.map((f) => `${f.severity}:${f.code}:${f.task ?? ""}`),
		["error:readonly_violation:a", "error:unowned_change:"],
		"a concurrent id that is not in the plan is ignored",
	);

	// A files-less task switches off unowned_change, so the window rule is the only guard left.
	const free = parsePlan(
		`---
id: nofiles-r1
status: ready
---
Context.

## task: a
files: src/a.ts
depends_on: []
pair: review
Edit a.

## task: d
role: security
depends_on: [a]
Check the checkout.
`,
		"x",
	);
	done(free, ["a", "d"]);
	const text = "VERDICT: clean\nFINDINGS: none";
	const freeResults = new Map<string, WorkerResult>([
		["a", ok(cleanReport("src/a.ts"), [{ name: "edit", path: "src/a.ts" }])],
		["d", ok(text, [{ name: "read", path: "src/a.ts" }])],
	]);
	const unowned = detectFaults({
		cwd: "/w",
		plan: free,
		results: freeResults,
		changed: ["src/a.ts", "src/x.ts"],
		readonlyTasks: new Set(["d"]),
		reviews: new Map([["d", { role: "security", report: parseReviewReport(text) }]]),
		reviewerWindows: new Map([["a", [{ changed: ["src/x.ts"], concurrent: [] }]]]),
		dry: false,
	});
	assert.deepEqual(
		unowned.map((f) => `${f.severity}:${f.code}:${f.task}`),
		["error:readonly_violation:a"],
	);
	assert.match(unowned[0].message, /pair reviewer changed files: src\/x\.ts/);
});

const FREEPLAN = `---
id: free-r1
status: ready
---
Context.

## task: audit
role: security
depends_on: []
Look for injection in the checkout.
`;

test("a read-only task with no files counts every window change", () => {
	const plan = parsePlan(FREEPLAN, "x");
	done(plan, ["audit"]);
	const text = "VERDICT: clean\nFINDINGS: none";
	const results = new Map<string, WorkerResult>([["audit", ok(text, [{ name: "read", path: "src/a.ts" }])]]);
	const faults = detectFaults({
		cwd: "/w",
		plan,
		results,
		changed: undefined,
		readonlyTasks: new Set(["audit"]),
		reviews: new Map([["audit", { role: "security", report: parseReviewReport(text) }]]),
		readonlyWindows: new Map([["audit", [{ changed: ["src/a.ts", "src/b.ts"], concurrent: [] }]]]),
		dry: false,
	});
	assert.deepEqual(
		faults.map((f) => `${f.severity}:${f.code}:${f.task}`),
		["error:readonly_violation:audit"],
	);
	assert.match(faults[0].message, /read-only task changed files: src\/a\.ts, src\/b\.ts/);
});

test("a read-only task whose own run changed its own file raises one violation", () => {
	const { mixed } = mixedRun();
	const faults = detectFaults({ ...mixed, readonlyWindows: new Map([["audit", [{ changed: ["src/api.ts"], concurrent: [] }]]]) });
	assert.deepEqual(
		faults.map((f) => `${f.severity}:${f.code}:${f.task}`),
		["error:readonly_violation:audit"],
	);
	assert.match(faults[0].message, /read-only task changed files: src\/api\.ts/);
});

test("a window file inside the reviewed task's directory is blamed once, not as an unreported change", () => {
	const plan = parsePlan(
		`---
id: dir-r1
status: ready
---
Context.

## task: a
files: src/
depends_on: []
pair: review
Edit src.

## task: b
files: other/b.ts
depends_on: []
Edit b.
`,
		"x",
	);
	done(plan, ["a", "b"]);
	const results = new Map<string, WorkerResult>([
		["a", ok(cleanReport("src/a.ts"), [{ name: "edit", path: "src/a.ts" }])],
		["b", ok(cleanReport("other/b.ts"), [{ name: "edit", path: "other/b.ts" }])],
	]);
	const faults = detectFaults({
		cwd: "/w",
		plan,
		results,
		changed: ["src/a.ts", "src/zz.ts", "other/b.ts"],
		reviewerWindows: new Map([["a", [{ changed: ["src/zz.ts"], concurrent: [] }]]]),
		dry: false,
	});
	assert.deepEqual(
		faults.map((f) => `${f.severity}:${f.code}:${f.task}`),
		["error:readonly_violation:a"],
		"the reviewer's write is not also blamed on the implementer",
	);
	assert.match(faults[0].message, /pair reviewer changed files: src\/zz\.ts/);
});

test("a window file overlapping a concurrent task's directory is not blamed", () => {
	const plan = parsePlan(
		`---
id: dir2-r1
status: ready
---
Context.

## task: a
files: src/a.ts
depends_on: []
pair: review
Edit a.

## task: b
files: src/
depends_on: []
Edit src.
`,
		"x",
	);
	done(plan, ["a", "b"]);
	const results = new Map<string, WorkerResult>([
		["a", ok(cleanReport("src/a.ts"), [{ name: "edit", path: "src/a.ts" }])],
		["b", ok(cleanReport("src/b.ts"), [{ name: "edit", path: "src/b.ts" }])],
	]);
	const faults = detectFaults({
		cwd: "/w",
		plan,
		results,
		changed: ["src/a.ts", "src/b.ts"],
		reviewerWindows: new Map([["a", [{ changed: ["src/b.ts"], concurrent: ["b"] }]]]),
		dry: false,
	});
	assert.deepEqual(faults, []);
});

test("a security own-window is not blamed for a concurrent task's file", () => {
	const plan = parsePlan(
		`---
id: two-r1
status: ready
---
Context.

## task: audit
role: security
files: src/api.ts
depends_on: []
Look for injection.

## task: ui
files: src/ui/
depends_on: []
Edit the ui.
`,
		"x",
	);
	done(plan, ["audit", "ui"]);
	const text = "VERDICT: clean\nFINDINGS: none";
	const results = new Map<string, WorkerResult>([["audit", ok(text, [{ name: "read", path: "src/api.ts" }])]]);
	const base = {
		cwd: "/w",
		plan,
		results,
		changed: undefined,
		readonlyTasks: new Set(["audit"]),
		reviews: new Map([["audit", { role: "security", report: parseReviewReport(text) }]]),
		dry: false,
	};

	const parallel = detectFaults({ ...base, readonlyWindows: new Map([["audit", [{ changed: ["src/ui/a.tsx"], concurrent: ["ui"] }]]]) });
	assert.deepEqual(parallel, [], "the ui task was running, so the file may be its write");

	const alone = detectFaults({ ...base, readonlyWindows: new Map([["audit", [{ changed: ["src/ui/a.tsx"], concurrent: [] }]]]) });
	assert.deepEqual(
		alone.map((f) => `${f.severity}:${f.code}:${f.task}`),
		["error:readonly_violation:audit"],
		"nobody else was running, so the file is the security task's write",
	);
});

test("one readonly_violation per task merges tool edits and the run window", () => {
	const plan = parsePlan(
		`---
id: merge-r1
status: ready
---
Context.

## task: audit
role: security
files: src/api.ts, src/extra.ts
depends_on: []
Look for injection.`,
		"x",
	);
	done(plan, ["audit"]);
	const text = "VERDICT: clean\nFINDINGS: none";
	const results = new Map<string, WorkerResult>([["audit", ok(text, [{ name: "edit", path: "src/api.ts" }])]]);
	const faults = detectFaults({
		cwd: "/w",
		plan,
		results,
		changed: ["src/api.ts"],
		readonlyTasks: new Set(["audit"]),
		reviews: new Map([["audit", { role: "security", report: parseReviewReport(text) }]]),
		readonlyWindows: new Map([["audit", [{ changed: ["src/extra.ts"], concurrent: [] }]]]),
		dry: false,
	});
	assert.deepEqual(
		faults.map((f) => `${f.severity}:${f.code}:${f.task}`),
		["error:readonly_violation:audit"],
	);
	assert.equal(faults[0].message, "read-only task changed files: src/api.ts, src/extra.ts");
});

test("pair_unresolved fires for an issues verdict with no findings listed", () => {
	const { plan, results, changed } = pairRun();
	const faults = detectFaults({
		cwd: "/w",
		plan,
		results,
		changed,
		pairs: new Map([["a", { rounds: 2, unresolved: [], unparsed: false, finalVerdict: "issues" as const }]]),
		dry: false,
	});
	assert.deepEqual(
		faults.map((f) => `${f.severity}:${f.code}:${f.task}`),
		["warn:pair_unresolved:a"],
	);
	assert.match(faults[0].message, /ended in issues after 2 pair round\(s\)/);
	assert.equal(evaluateGate(plan, faults, false, true).pass, true);
});
