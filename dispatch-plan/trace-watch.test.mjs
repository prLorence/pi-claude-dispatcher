/** Run with: node --test dispatch-plan/trace-watch.test.mjs (Node 24+) */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const here = path.dirname(new URL(import.meta.url).pathname);
const cli = path.join(here, "trace.mjs");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pi-trace-watch-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const plans = (dir) => path.join(dir, ".plans");
const traceFile = (dir, trace) => path.join(plans(dir), "traces", `${trace}.jsonl`);

// The local wall clock of an event, which is what a watch line starts with.
function hhmmss(ts) {
	const d = new Date(ts);
	const p = (n) => String(n).padStart(2, "0");
	return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function ev(trace, kind, fields = {}) {
	return JSON.stringify({
		v: 1,
		ts: new Date().toISOString(),
		trace,
		span: `${kind}:${fields.task || trace}`,
		actor: "pi-dispatch",
		kind,
		plan: "p1",
		round: 1,
		...fields,
	});
}

function appendTrace(dir, trace, lines) {
	fs.mkdirSync(path.join(plans(dir), "traces"), { recursive: true });
	fs.appendFileSync(traceFile(dir, trace), lines.map((l) => `${l}\n`).join(""));
}

// A plan file wherever the dispatcher keeps it: running/, inbox/ or done/<id>/plan.md.
function writePlan(dir, where, id, trace) {
	const file = where === "done" ? path.join(plans(dir), "done", id, "plan.md") : path.join(plans(dir), where, `${id}.md`);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `---\nid: ${id}\ntrace: ${trace}\nround: 1\nstatus: ready\n---\n\nGoal: test the plan.\n`);
}

// The real shape of evidence.json: the counts live under gate.tasks and there is no cost.
function writeEvidence(dir, id, trace, gate, changed = []) {
	const file = path.join(plans(dir), "done", id, "evidence.json");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(
		file,
		JSON.stringify({ plan: id, trace, round: 1, parent: null, changed, faults: [], gate: { reasons: [], counts: { error: 0, warn: 0 }, evidence: true, ...gate } }),
	);
	fs.writeFileSync(path.join(plans(dir), "done", id, "_summary.md"), "gate: pass\n");
}

function startWatch(dir, args) {
	const child = spawn(process.execPath, [cli, "watch", ...args, "--root", dir], { stdio: ["ignore", "pipe", "pipe"] });
	const out = [];
	let err = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (s) => out.push(s));
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (s) => (err += s));
	const exit = new Promise((r) => child.on("close", (code) => r(code)));
	const done = async () => {
		const code = await Promise.race([exit, sleep(12000).then(() => "still running")]);
		assert.notEqual(code, "still running", `watch did not exit; output:\n${out.join("")}\nstderr:\n${err}`);
		return code;
	};
	const lines = () => out.join("").split("\n").filter(Boolean);
	const kill = () => {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	};
	return { child, out, lines, done, kill, stderr: () => err };
}

function runWatchSync(dir, args) {
	return spawnSync(process.execPath, [cli, "watch", ...args, "--root", dir], { encoding: "utf8" });
}

// Time for the child to boot and remember the trace size before the test appends.
const BOOT = 700;

test("watch prints the notable events of its plan, and only those that came after it started", async (t) => {
	const dir = tmp();
	const trace = "w1";
	let w;
	t.after(() => {
		w?.kill();
		fs.rmSync(dir, { recursive: true, force: true });
	});
	writePlan(dir, "running", "p1", trace);
	// Before the start: never replayed, because watch skips to the end of the trace.
	appendTrace(dir, trace, [ev(trace, "task.end", { task: "old", attempt: 1, data: { state: "done", ok: true, duration_s: 1 } })]);
	appendTrace(dir, "w-other", [ev("w-other", "task.end", { plan: "p2", task: "old-other", data: { state: "done", ok: true } })]);

	w = startWatch(dir, ["--plan", "p1", "--timeout", "15"]);
	await sleep(BOOT);

	const doneTs = new Date().toISOString();
	const failedTs = new Date().toISOString();
	const reviewTs = new Date().toISOString();
	const badReviewTs = new Date().toISOString();
	const faultTs = new Date().toISOString();
	const gateTs = new Date().toISOString();
	const endTs = new Date().toISOString();
	appendTrace(dir, trace, [
		ev(trace, "task.start", { task: "a", data: { model: "opencode-go/x", thinking: "low" } }),
		ev(trace, "task.end", { ts: doneTs, task: "a", attempt: 1, data: { state: "done", ok: true, duration_s: 12.5 } }),
		ev(trace, "task.verify", { task: "a", data: { command: "npm test", ok: true } }),
		ev(trace, "task.review", { ts: reviewTs, task: "a", data: { verdict: "approve", ok: true } }),
		ev(trace, "task.review", { ts: reviewTs, task: "a", round: 2, data: { verdict: "changes", ok: true, findings: 2 } }),
		ev(trace, "task.review", { ts: badReviewTs, task: "b", data: { verdict: "approve", ok: false } }),
		ev(trace, "task.end", { ts: failedTs, task: "b", attempt: 2, data: { state: "failed", ok: false, duration_s: 3, error: `bad ${"x".repeat(200)}` } }),
		ev(trace, "fault", { ts: faultTs, task: undefined, data: { severity: "error", code: "tests_not_run", message: "no tests were run" } }),
		ev(trace, "task.end", { ts: new Date().toISOString(), plan: "p2", task: "elsewhere", data: { state: "done", ok: true } }),
		ev("w-other", "task.end", { ts: new Date().toISOString(), plan: "p2", task: "elsewhere", data: { state: "done", ok: true } }),
		ev(trace, "gate", { ts: gateTs, data: { pass: false, reasons: ["b failed"] } }),
		ev(trace, "plan.end", { ts: endTs, data: { done: 1, failed: 1, skipped: 0, gate_pass: false, cost: 0.01234 } }),
	]);

	const code = await w.done();
	assert.equal(code, 0);
	const lines = w.lines();
	assert.equal(lines.length, 7, `one line per notable event, got:\n${lines.join("\n")}`);
	assert.equal(lines[0], `${hhmmss(doneTs)} END a a1 done ok=true 12.5s`);
	assert.equal(lines[1], `${hhmmss(reviewTs)} REVIEW a changes ok=true`);
	assert.equal(lines[2], `${hhmmss(badReviewTs)} REVIEW b approve ok=false`);
	assert.match(lines[3], new RegExp(`^${hhmmss(failedTs)} END b a2 failed ok=false 3s ERR bad x+`));
	assert.ok(lines[3].length < 200, `the error is cut short: ${lines[3]}`);
	assert.equal(lines[4], `${hhmmss(faultTs)} FAULT error tests_not_run - no tests were run`);
	assert.equal(lines[5], `${hhmmss(gateTs)} GATE pass=false ["b failed"]`);
	assert.equal(lines[6], `${hhmmss(endTs)} PLAN END done=1 failed=1 skipped=0 gate_pass=false cost=$0.0123`);
	assert.ok(!w.out.join("").includes("old"), "an event from before the start is not replayed");
	assert.ok(!w.out.join("").includes("elsewhere"), "another plan's events are ignored");
});

test("watch exits 0 at once on a finished plan, with the counts from the evidence and the cost from plan.end", async (t) => {
	const dir = tmp();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	writePlan(dir, "done", "p1", "w2");
	writeEvidence(dir, "p1", "w2", { pass: true, tasks: { done: 2, failed: 0, skipped: 1 } });
	appendTrace(dir, "w2", [ev("w2", "plan.end", { data: { done: 2, failed: 0, skipped: 1, gate_pass: true, cost: 0.025 } })]);

	const one = startWatch(dir, ["--plan", "p1", "--timeout", "15"]);
	assert.equal(await one.done(), 0);
	assert.deepEqual(
		one.lines().map((l) => l.slice(9)),
		["PLAN END done=2 failed=0 skipped=1 gate_pass=true cost=$0.0250"],
	);

	// No plan.end event, so there is no cost to report.
	writePlan(dir, "done", "p3", "w3");
	writeEvidence(dir, "p3", "w3", { pass: false, tasks: { done: 0, failed: 1, skipped: 0 } });

	const two = startWatch(dir, ["--plan", "p3", "--timeout", "15"]);
	assert.equal(await two.done(), 0);
	assert.deepEqual(
		two.lines().map((l) => l.slice(9)),
		["PLAN END done=0 failed=1 skipped=0 gate_pass=false cost=$-"],
	);
});

test("watch exits 2 on a rejection by file and by event", async (t) => {
	const dir = tmp();
	let w;
	t.after(() => {
		w?.kill();
		fs.rmSync(dir, { recursive: true, force: true });
	});
	writePlan(dir, "running", "p1", "w4");
	w = startWatch(dir, ["--plan", "p1", "--timeout", "15"]);
	await sleep(BOOT);
	// Written after the start, so it is this run's rejection and not a stale one.
	fs.mkdirSync(path.join(plans(dir), "failed"), { recursive: true });
	fs.writeFileSync(path.join(plans(dir), "failed", "p1.error.md"), "# Plan rejected\n\na files entry leaves the repo\n\nmore text\n");
	assert.equal(await w.done(), 2);
	assert.deepEqual(
		w.lines().map((l) => l.slice(9)),
		["REJECTED a files entry leaves the repo"],
	);

	writePlan(dir, "running", "p2", "w5");
	const byEvent = startWatch(dir, ["--plan", "p2", "--timeout", "15"]);
	t.after(() => byEvent.kill());
	await sleep(BOOT);
	appendTrace(dir, "w5", [ev("w5", "plan.rejected", { plan: "p2", data: { reason: "task needs verify" } })]);
	assert.equal(await byEvent.done(), 2);
	assert.deepEqual(
		byEvent.lines().map((l) => l.slice(9)),
		["REJECTED task needs verify"],
	);
});

test("watch exits 2 at once for an old rejection file of a plan that is no longer queued", (t) => {
	const dir = tmp();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	fs.mkdirSync(path.join(plans(dir), "failed"), { recursive: true });
	fs.writeFileSync(path.join(plans(dir), "failed", "p1.error.md"), "# Plan rejected\n\nstale reason\n");

	const r = runWatchSync(dir, ["--plan", "p1", "--timeout", "15"]);
	assert.equal(r.status, 2, r.stderr);
	assert.deepEqual(
		r.stdout.split("\n").filter(Boolean).map((l) => l.slice(9)),
		["REJECTED stale reason"],
	);
});

test("watch exits 4 after the pickup window for a plan only in the inbox", async (t) => {
	const dir = tmp();
	let w;
	t.after(() => {
		w?.kill();
		fs.rmSync(dir, { recursive: true, force: true });
	});
	writePlan(dir, "inbox", "p1", "w6");

	w = startWatch(dir, ["--plan", "p1", "--pickup", "1", "--timeout", "15"]);
	assert.equal(await w.done(), 4);
	const lines = w.lines();
	assert.equal(lines.length, 1, lines.join("\n"));
	assert.match(lines[0], /^\d\d:\d\d:\d\d WATCH NOT PICKED UP \(the Pi session is probably not running\)$/);
});

test("watch exits 3 when --timeout passes first", async (t) => {
	const dir = tmp();
	let w;
	t.after(() => {
		w?.kill();
		fs.rmSync(dir, { recursive: true, force: true });
	});
	writePlan(dir, "running", "p1", "w7");

	w = startWatch(dir, ["--plan", "p1", "--timeout", "1"]);
	assert.equal(await w.done(), 3);
	const lines = w.lines();
	assert.equal(lines.length, 1, lines.join("\n"));
	assert.match(lines[0], /^\d\d:\d\d:\d\d WATCH TIMEOUT after \d+s$/);
});

test("watch tolerates a missing trace file and a line written in two chunks", async (t) => {
	const dir = tmp();
	let w;
	t.after(() => {
		w?.kill();
		fs.rmSync(dir, { recursive: true, force: true });
	});
	writePlan(dir, "running", "p1", "w8");

	w = startWatch(dir, ["--plan", "p1", "--timeout", "15"]);
	await sleep(BOOT);
	assert.ok(!fs.existsSync(traceFile(dir, "w8")), "the trace file does not exist yet");

	const ts = new Date().toISOString();
	const line = Buffer.from(`${ev("w8", "task.end", { ts, task: "a", attempt: 1, data: { state: "done", ok: true, duration_s: 1, error: "café" } })}\n`, "utf8");
	// Split inside the two bytes of the é, so a byte-wise tail is what keeps the text whole.
	const at = line.indexOf(Buffer.from("é", "utf8")) + 1;
	fs.mkdirSync(path.join(plans(dir), "traces"), { recursive: true });
	fs.writeFileSync(traceFile(dir, "w8"), line.subarray(0, at));
	await sleep(1500);
	assert.deepEqual(w.lines(), [], `a half-written line prints nothing:\n${w.lines().join("\n")}`);
	fs.appendFileSync(traceFile(dir, "w8"), line.subarray(at));
	await sleep(1500);
	assert.deepEqual(w.lines(), [`${hhmmss(ts)} END a a1 done ok=true 1s ERR café`]);

	w.kill();
});

test("watch prints a RESUME line for a task.resume event", async (t) => {
	const dir = tmp();
	let w;
	t.after(() => {
		w?.kill();
		fs.rmSync(dir, { recursive: true, force: true });
	});
	writePlan(dir, "running", "p1", "wa");
	w = startWatch(dir, ["--plan", "p1", "--timeout", "15"]);
	await sleep(BOOT);

	const ts = new Date().toISOString();
	appendTrace(dir, "wa", [
		ev("wa", "task.resume", { ts, task: "a", attempt: 2, data: { resume: 1, wait_s: 4, error: `connection reset ${"y".repeat(200)}` } }),
		ev("wa", "plan.end", { data: { done: 1, failed: 0, skipped: 0, gate_pass: true, cost: 0 } }),
	]);

	assert.equal(await w.done(), 0);
	const lines = w.lines();
	assert.match(lines[0], new RegExp(`^${hhmmss(ts)} RESUME a a2 #1 wait=4s connection reset y+$`));
	assert.ok(lines[0].length < 160, `the error is cut short: ${lines[0]}`);
});

test("watch prints a STALL line for a task.stall event", async (t) => {
	const dir = tmp();
	let w;
	t.after(() => {
		w?.kill();
		fs.rmSync(dir, { recursive: true, force: true });
	});
	writePlan(dir, "running", "p1", "wb");
	w = startWatch(dir, ["--plan", "p1", "--timeout", "15"]);
	await sleep(BOOT);

	const ts = new Date().toISOString();
	appendTrace(dir, "wb", [
		ev("wb", "task.stall", { ts, task: "b", attempt: 1, data: { minutes: 10 } }),
		ev("wb", "plan.end", { data: { done: 1, failed: 0, skipped: 0, gate_pass: true, cost: 0 } }),
	]);

	assert.equal(await w.done(), 0);
	assert.equal(w.lines()[0], `${hhmmss(ts)} STALL b 10min`);
});

test("watch prints OUTAGE START then OUTAGE END in event order", async (t) => {
	const dir = tmp();
	let w;
	t.after(() => {
		w?.kill();
		fs.rmSync(dir, { recursive: true, force: true });
	});
	writePlan(dir, "running", "p1", "wc");
	w = startWatch(dir, ["--plan", "p1", "--timeout", "15"]);
	await sleep(BOOT);

	const startTs = new Date().toISOString();
	const endTs = new Date().toISOString();
	appendTrace(dir, "wc", [
		ev("wc", "outage.start", { ts: startTs, task: undefined, data: { reason: `fetch failed ${"z".repeat(200)}` } }),
		ev("wc", "outage.end", { ts: endTs, task: undefined, data: { outcome: "healthy", duration_s: 42 } }),
		ev("wc", "plan.end", { data: { done: 1, failed: 0, skipped: 0, gate_pass: true, cost: 0 } }),
	]);

	assert.equal(await w.done(), 0);
	const lines = w.lines();
	assert.match(lines[0], new RegExp(`^${hhmmss(startTs)} OUTAGE START fetch failed z+$`));
	assert.ok(lines[0].length < 160, `the reason is cut short: ${lines[0]}`);
	assert.equal(lines[1], `${hhmmss(endTs)} OUTAGE END healthy after 42s`);
});

test("watch ignores an outage event of another plan", async (t) => {
	const dir = tmp();
	let w;
	t.after(() => {
		w?.kill();
		fs.rmSync(dir, { recursive: true, force: true });
	});
	writePlan(dir, "running", "p1", "wd");
	w = startWatch(dir, ["--plan", "p1", "--timeout", "15"]);
	await sleep(BOOT);

	appendTrace(dir, "wd", [
		ev("wd", "outage.start", { plan: "p2", task: undefined, data: { reason: "another plan's outage" } }),
		ev("wd", "outage.end", { plan: "p2", task: undefined, data: { outcome: "gave-up", duration_s: 7 } }),
		ev("wd", "plan.end", { data: { done: 1, failed: 0, skipped: 0, gate_pass: true, cost: 0 } }),
	]);

	assert.equal(await w.done(), 0);
	const lines = w.lines();
	assert.equal(lines.length, 1, lines.join("\n"));
	assert.match(lines[0], /PLAN END/);
	assert.ok(!w.out.join("").includes("another plan's outage"), "another plan's outage is ignored");
});

test("watch exits 64 on a usage error", (t) => {
	const dir = tmp();
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	writePlan(dir, "running", "p1", "w9");

	const noPlan = runWatchSync(dir, ["--timeout", "15"]);
	assert.equal(noPlan.status, 64, noPlan.stderr);
	assert.match(noPlan.stderr, /watch needs --plan/);

	for (const bad of ["soon", "0", "-5"]) {
		const r = runWatchSync(dir, ["--plan", "p1", "--timeout", bad]);
		assert.equal(r.status, 64, `--timeout ${bad} is a usage error, stderr: ${r.stderr}`);
	}
	const badPickup = runWatchSync(dir, ["--plan", "p1", "--pickup", "later"]);
	assert.equal(badPickup.status, 64, badPickup.stderr);
});
