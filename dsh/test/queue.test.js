import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runPlanFile } from "../plugins/harness-dispatch/queue.js";
import { getDirs, loadConfig } from "../plugins/harness-dispatch/config.js";
import { readEvents } from "../plugins/harness-dispatch/trace.js";

function repo() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-queue-"));
	execFileSync("git", ["init", "-q"], { cwd: root });
	fs.writeFileSync(path.join(root, "base.txt"), "x\n");
	execFileSync("git", ["add", "."], { cwd: root });
	execFileSync("git", ["-c", "user.email=a@b.c", "-c", "user.name=a", "commit", "-qm", "init"], { cwd: root });
	const d = getDirs(root);
	for (const p of [d.inbox, d.running, d.done, d.failed]) fs.mkdirSync(p, { recursive: true });
	return { root, d };
}

const PLAN = `---
id: p1
trace: t1
round: 1
status: ready
max_parallel: 2
---
Context.

## task: a
files: src/shared.ts
verify: node --test
body a

## task: b
files: src/shared.ts
verify: node --test
body b
`;

test("two overlapping tasks serialise, one retries after a failed verify, and the plan passes", async () => {
	const { root, d } = repo();
	const planFile = path.join(d.inbox, "p1.md");
	fs.writeFileSync(planFile, PLAN);
	const order = [];
	let verifyCalls = 0;
	const cfg = { ...loadConfig(d), retries: 1, dryRun: false };
	const result = await runPlanFile(planFile, {
		cwd: root,
		runtime: {
			dirs: d,
			cfg,
			async runWorker({ plan, task }) {
				order.push(`${task.id}:start`);
				await new Promise((r) => setTimeout(r, 20));
				const file = path.join(root, "src", "shared.ts");
				fs.mkdirSync(path.dirname(file), { recursive: true });
				fs.writeFileSync(file, `// ${task.id}\n`);
				order.push(`${task.id}:end`);
				return {
					ok: true,
					cost: 0,
					output: `STATUS: done\nCHANGED: src/shared.ts\nTESTS: none\nNOTES:\nNEEDS: none`,
					tools: [{ name: "edit", path: "src/shared.ts" }],
					tokens: { input: 1, output: 1, total: 2 },
				};
			},
			async runVerify() {
				verifyCalls++;
				// Task a fails its first check, then passes; b always passes.
				const ok = verifyCalls !== 1;
				return { ok, code: ok ? 0 : 1, timedOut: false, durationMs: 5, output: ok ? "ok" : "first failure" };
			},
		},
	});
	assert.equal(result.gate.pass, true, JSON.stringify(result.faults));
	assert.equal(result.plan.tasks.length, 2);
	assert.equal(result.plan.tasks[0].attempts, 2);
	assert.equal(result.plan.tasks[0].state, "done");
	assert.equal(result.plan.tasks[1].state, "done");
	// The shared file forces b to wait for a to finish.
	assert.ok(order.indexOf("b:start") > order.indexOf("a:end"), order.join(","));
	assert.equal(fs.existsSync(path.join(d.done, "p1", "plan.md")), true);
	assert.equal(fs.existsSync(path.join(d.done, "p1", "_summary.md")), true);
	const evidence = JSON.parse(fs.readFileSync(path.join(d.done, "p1", "evidence.json"), "utf8"));
	assert.equal(evidence.gate.pass, true);
	assert.deepEqual(evidence.changed, ["src/shared.ts"]);
	const kinds = readEvents(d.root, "t1").map((e) => e.kind);
	for (const kind of ["plan.received", "task.start", "task.verify", "task.end", "gate", "plan.end"]) assert.ok(kinds.includes(kind), kind);
	fs.rmSync(root, { recursive: true, force: true });
});

test("a plan with a bad files entry is rejected to .plans/failed with an .error.md", async () => {
	const { root, d } = repo();
	const file = path.join(d.inbox, "bad.md");
	fs.writeFileSync(file, "---\nid: bad\ntrace: bad\nstatus: ready\n---\n## task: a\nfiles: ../outside.ts\nbody\n");
	const result = await runPlanFile(file, { cwd: root, runtime: { dirs: d, cfg: loadConfig(d) } });
	assert.equal(result.plan, null);
	assert.match(result.rejected, /\.\./);
	assert.equal(fs.existsSync(path.join(d.failed, "bad.md")), true);
	assert.match(fs.readFileSync(path.join(d.failed, "bad.error.md"), "utf8"), /Plan rejected/);
	assert.ok(readEvents(d.root, "bad").some((e) => e.kind === "plan.rejected"));
	fs.rmSync(root, { recursive: true, force: true });
});

test("a task with no files runs alone", async () => {
	const { root, d } = repo();
	const file = path.join(d.inbox, "solo.md");
	fs.writeFileSync(file, "---\nid: solo\ntrace: solo\nstatus: ready\n---\n## task: a\nfiles:\nbody\n## task: b\nfiles: b.ts\nbody\n");
	let concurrent = 0;
	let maxConcurrent = 0;
	const result = await runPlanFile(file, {
		cwd: root,
		runtime: {
			dirs: d,
			cfg: loadConfig(d),
			async runWorker({ task }) {
				concurrent++;
				maxConcurrent = Math.max(maxConcurrent, concurrent);
				await new Promise((r) => setTimeout(r, 5));
				concurrent--;
				return { ok: true, cost: 0, output: "STATUS: done\nCHANGED: (none)\nTESTS: none\nNOTES:\nNEEDS:", tools: [] };
			},
		},
	});
	assert.equal(result.gate.pass, true);
	assert.equal(maxConcurrent, 1);
	fs.rmSync(root, { recursive: true, force: true });
});

test("requirePlanAudit rejects a plan without a passing plan.audit", async () => {
	const { root, d } = repo();
	const file = path.join(d.inbox, "audit-me.md");
	fs.writeFileSync(file, "---\nid: audit-me\ntrace: audit-t\nstatus: ready\n---\n## task: a\nfiles: a.ts\nbody\n");
	try {
		const result = await runPlanFile(file, {
			cwd: root,
			runtime: { dirs: d, cfg: { ...loadConfig(d), requirePlanAudit: true } },
		});
		assert.equal(result.plan, null);
		assert.match(result.rejected, /plan audit has not passed/);
		assert.equal(fs.existsSync(path.join(d.failed, "audit-me.error.md")), true);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("requirePlanAudit accepts a passing plan.audit and runs the plan", async () => {
	const { root, d } = repo();
	fs.mkdirSync(path.join(d.root, "traces"), { recursive: true });
	fs.writeFileSync(
		path.join(d.root, "traces", "audit-t.jsonl"),
		`${JSON.stringify({ v: 1, ts: new Date().toISOString(), trace: "audit-t", span: "plan:audit-me", actor: "opus-plan-auditor", kind: "plan.audit", plan: "audit-me", round: 1, data: { verdict: "pass", audit_round: 1, blockers: 0, majors: 0 } })}\n`,
	);
	const file = path.join(d.inbox, "audit-me.md");
	fs.writeFileSync(file, "---\nid: audit-me\ntrace: audit-t\nstatus: ready\n---\n## task: a\nfiles: a.ts\nbody\n");
	try {
		const result = await runPlanFile(file, {
			cwd: root,
			runtime: {
				dirs: d,
				cfg: { ...loadConfig(d), requirePlanAudit: true },
				async runWorker() {
					const target = path.join(root, "a.ts");
					fs.writeFileSync(target, "export const a = 1;\n");
					return { ok: true, cost: 0, output: "STATUS: done\nCHANGED: a.ts\nTESTS: none\nNOTES:\nNEEDS:", tools: [{ name: "edit", path: "a.ts" }] };
				},
			},
		});
		assert.equal(result.gate.pass, true, JSON.stringify(result.faults));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("onFinish sees the finished plan and a throwing observer cannot fail it", async () => {
	const { root, d } = repo();
	const file = path.join(d.inbox, "fin.md");
	fs.writeFileSync(file, "---\nid: fin\ntrace: fin\nstatus: ready\n---\n## task: a\nfiles:\nbody\n");
	let seen;
	const result = await runPlanFile(file, {
		cwd: root,
		runtime: {
			dirs: d,
			cfg: loadConfig(d),
			async runWorker() {
				return { ok: true, cost: 0, output: "STATUS: done\nCHANGED: (none)\nTESTS: none\nNOTES:\nNEEDS:", tools: [] };
			},
			onFinish(value) {
				seen = value;
				throw new Error("observer exploded");
			},
		},
	});
	assert.equal(seen.plan.id, "fin");
	assert.equal(seen.gate.pass, true);
	assert.equal(seen.cwd, root);
	assert.equal(result.gate.pass, true);
	fs.rmSync(root, { recursive: true, force: true });
});
