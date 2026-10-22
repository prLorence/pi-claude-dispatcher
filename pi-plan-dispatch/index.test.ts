/** Drives the real extension with a mocked Pi API. Run: node --test pi-plan-dispatch/index.test.ts */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import extension from "./index.ts";
import { BLOCKED_MARKER } from "./guard.ts";
import { readEvents } from "./trace.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(file: string, ms = 15000) {
	const t0 = Date.now();
	while (!fs.existsSync(file)) {
		if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${file}`);
		await sleep(100);
	}
}

function boot(cwd: string, dry: boolean) {
	// When these tests run inside a Pi worker the guard would disable the extension.
	delete process.env.PI_PLAN_DISPATCH_WORKER;
	const handlers = new Map<string, (e: unknown, ctx: unknown) => Promise<void>>();
	const messages: string[] = [];
	// A slash command can speak to the user through ctx.ui.notify, so capture it.
	const notes: string[] = [];
	type Handler = (args: string, ctx: unknown) => Promise<void>;
	const commands = new Map<string, Handler>();
	const pi = {
		registerFlag() {},
		getFlag: () => dry,
		registerCommand: (name: string, opts: { handler: Handler }) => commands.set(name, opts.handler),
		on: (n: string, h: (e: unknown, ctx: unknown) => Promise<void>) => handlers.set(n, h),
		sendMessage: (m: { content: string }) => messages.push(m.content),
	};
	extension(pi as never);
	const ctx = { cwd, hasUI: false };
	const ui = { notify: (msg: string) => notes.push(msg), setStatus() {}, setWidget() {} };
	return {
		start: () => handlers.get("session_start")!({}, ctx),
		stop: () => handlers.get("session_shutdown")!({}, ctx),
		messages,
		notes,
		command: (args: string) => commands.get("plans")!(args, { cwd, hasUI: true, ui }),
	};
}

type Booted = ReturnType<typeof boot>;

/**
 * Boot the extension, run the body, and always shut it down: a throw must not leave the
 * inbox watcher running, or the test process never exits.
 */
async function withExtension(dir: string, dry: boolean, fn: (x: Booted) => Promise<void>) {
	const x = boot(dir, dry);
	try {
		await x.start();
		await fn(x);
	} finally {
		await x.stop();
	}
}

function repo() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-idx-"));
	const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
	git("init", "-q");
	git("config", "user.email", "t@t");
	git("config", "user.name", "t");
	fs.mkdirSync(path.join(dir, "src"));
	fs.writeFileSync(path.join(dir, "src/api.ts"), "v1");
	git("add", ".");
	git("commit", "-qm", "init");
	return dir;
}

/** Install a fake `pi` (a node script) as the worker command. */
function fakePi(dir: string, script: string) {
	const fake = path.join(dir, "fake-pi.mjs");
	fs.writeFileSync(fake, script);
	fs.mkdirSync(path.join(dir, ".plans"), { recursive: true });
	fs.writeFileSync(path.join(dir, ".plans/config.json"), JSON.stringify({ piCommand: path.join(dir, "pi") }));
	fs.writeFileSync(path.join(dir, "pi"), `#!/bin/sh\nexec node ${fake} "$@"\n`, { mode: 0o755 });
}

/** Fake worker that reads src/api.ts, writes it, and reports exactly that. */
const editsApi = `import fs from "node:fs";
const out = (o) => console.log(JSON.stringify(o));
out({ type: "tool_execution_start", toolCallId: "1", toolName: "read", args: { path: "src/api.ts" } });
fs.writeFileSync("src/api.ts", "v2");
out({ type: "tool_execution_start", toolCallId: "2", toolName: "edit", args: { path: "src/api.ts" } });
out({ type: "message_end", message: { role: "assistant", stopReason: "stop", usage: { input: 5, output: 5, totalTokens: 10, cost: { total: 0 } },
  content: [{ type: "text", text: "STATUS: done\\nCHANGED:\\nsrc/api.ts\\nTESTS: none\\nNOTES: n\\nNEEDS: none" }] } });
`;

function bootWorker(cwd: string, policy: object) {
	process.env.PI_PLAN_DISPATCH_WORKER = "1";
	process.env.PI_PLAN_DISPATCH_GUARD = JSON.stringify(policy);
	const handlers = new Map<string, (e: unknown, ctx: unknown) => Promise<unknown>>();
	const pi = {
		registerFlag() {},
		getFlag: () => false,
		registerCommand() {},
		on: (n: string, h: (e: unknown, ctx: unknown) => Promise<unknown>) => handlers.set(n, h),
		sendMessage() {},
	};
	extension(pi as never);
	const ctx = { cwd, hasUI: false };
	return {
		toolCall: (toolName: string, input: unknown) => handlers.get("tool_call")!({ toolName, input }, ctx),
		start: () => handlers.get("session_start")!({}, ctx),
	};
}

const restoreGuardEnv = () => {
	delete process.env.PI_PLAN_DISPATCH_WORKER;
	delete process.env.PI_PLAN_DISPATCH_GUARD;
};

const planText = (id: string, extra = "") => `---
id: ${id}
${extra}status: ready
---
Context.

## task: api
files: src/api.ts
depends_on: []
Edit the api.
`;

function drop(dir: string, id: string, text: string) {
	const inbox = path.join(dir, ".plans/inbox");
	fs.mkdirSync(inbox, { recursive: true });
	fs.writeFileSync(path.join(inbox, `.${id}.md.tmp`), text);
	fs.renameSync(path.join(inbox, `.${id}.md.tmp`), path.join(inbox, `${id}.md`));
}

test("dry run: traced plan writes events, prompts, evidence, and a gate that refuses to pass", async () => {
	const dir = repo();
	const x = boot(dir, true);
	try {
		await x.start();
		drop(dir, "r1", planText("r1", "trace: tr\nround: 1\n"));
		await waitFor(path.join(dir, ".plans/done/r1/_summary.md"));
	} finally {
		await x.stop();
	}

	const out = path.join(dir, ".plans/done/r1");
	assert.ok(fs.existsSync(path.join(out, "api.prompt.md")), "exact prompt saved");
	const ev = JSON.parse(fs.readFileSync(path.join(out, "evidence.json"), "utf8"));
	assert.equal(ev.trace, "tr");
	assert.equal(ev.gate.pass, false);
	assert.equal(ev.gate.evidence, "dry-run");
	assert.deepEqual(ev.sessions, [], "dry runs have no sessions");
	const kinds = readEvents(path.join(dir, ".plans"), "tr").map((e) => e.kind);
	assert.deepEqual(kinds, ["plan.received", "task.start", "task.end", "gate", "plan.end"]);
	assert.match(fs.readFileSync(path.join(out, "_summary.md"), "utf8"), /gate: \*\*FAIL\*\*/);
	assert.match(x.messages[0], /gate FAIL/);
});

test("real worker path: scope violation is caught from tool calls and git, linked across rounds", async () => {
	const dir = repo();
	// Fake pi: edits src/api.ts (in scope) and src/rogue.ts (out of scope), reports honestly about api only.
	const fake = path.join(dir, "fake-pi.mjs");
	fs.writeFileSync(
		fake,
		`import fs from "node:fs";
const out = (o) => console.log(JSON.stringify(o));
fs.writeFileSync("src/api.ts", "v2");
out({ type: "tool_execution_start", toolCallId: "1", toolName: "edit", args: { path: "src/api.ts" } });
fs.writeFileSync("src/rogue.ts", "oops");
out({ type: "tool_execution_start", toolCallId: "2", toolName: "write", args: { path: "src/rogue.ts" } });
out({ type: "message_end", message: { role: "assistant", stopReason: "stop", usage: { input: 5, output: 5, totalTokens: 10, cost: { total: 0 } },
  content: [{ type: "text", text: "STATUS: done\\nCHANGED:\\nsrc/api.ts\\nTESTS: none\\nNOTES: n\\nNEEDS: none" }] } });
`,
	);
	fs.mkdirSync(path.join(dir, ".plans"), { recursive: true });
	// A shell wrapper lets piCommand be a single executable that ignores pi's flags.
	fs.writeFileSync(path.join(dir, "pi"), `#!/bin/sh\nexec node ${fake} "$@"\n`, { mode: 0o755 });
	fs.writeFileSync(path.join(dir, ".plans/config.json"), JSON.stringify({ piCommand: path.join(dir, "pi") }));

	const x = boot(dir, false);
	try {
		await x.start();
		drop(dir, "r1", planText("r1", "trace: tr\nround: 1\n"));
		await waitFor(path.join(dir, ".plans/done/r1/_summary.md"));
		// round 2 follows round 1
		drop(dir, "r2", planText("r2", "trace: tr\nround: 2\nparent: r1\n"));
		await waitFor(path.join(dir, ".plans/done/r2/_summary.md"));
	} finally {
		await x.stop();
	}

	const ev = JSON.parse(fs.readFileSync(path.join(dir, ".plans/done/r1/evidence.json"), "utf8"));
	const codes = ev.faults.map((f: { code: string }) => f.code);
	assert.ok(codes.includes("out_of_scope_edit"), codes.join());
	assert.ok(codes.includes("unowned_change"), codes.join());
	assert.equal(ev.gate.pass, false);
	assert.deepEqual(ev.changed, ["src/api.ts", "src/rogue.ts"]);
	assert.equal(ev.sessions.length, 1);
	assert.equal(ev.sessions[0].id, "r1.api.a1");
	assert.match(ev.sessions[0].resume, /^pi --session r1\.api\.a1 --session-dir \.plans\/sessions\/r1$/);
	assert.match(fs.readFileSync(path.join(dir, ".plans/done/r1/_summary.md"), "utf8"), /sessions \(reopen a worker/);
	assert.match(fs.readFileSync(path.join(dir, ".plans/done/r1/api.md"), "utf8"), /- session: `r1\.api\.a1`/);

	const events = readEvents(path.join(dir, ".plans"), "tr");
	const r2 = events.find((e) => e.kind === "plan.received" && e.plan === "r2")!;
	assert.equal(r2.parent, "plan:r1", "fix round links to the plan it follows");
	const end = events.find((e) => e.kind === "task.end" && e.plan === "r1")!;
	assert.deepEqual((end.data as { tools: { edits: string[] } }).tools.edits, ["src/api.ts", "src/rogue.ts"]);
});

test("a rejected plan re-dropped under the same id runs, and its stale rejection files are cleared", async () => {
	const dir = repo();
	const x = boot(dir, true);
	try {
		await x.start();
		const bad = planText("fixme").replace("depends_on: []", "depends_on: [ghost]");
		drop(dir, "fixme", bad);
		await waitFor(path.join(dir, ".plans/failed/fixme.error.md"));
		drop(dir, "fixme", planText("fixme"));
		await waitFor(path.join(dir, ".plans/done/fixme/_summary.md"));
	} finally {
		await x.stop();
	}
	assert.equal(fs.existsSync(path.join(dir, ".plans/failed/fixme.error.md")), false);
	assert.equal(fs.existsSync(path.join(dir, ".plans/failed/fixme.md")), false);
});

test("worker mode: the guard blocks out-of-scope edits and destructive shell commands, and starts no watcher", async () => {
	const dir = repo();
	try {
		const w = bootWorker(dir, { files: ["src/api.ts"], bash: true });

		const outside = (await w.toolCall("edit", { path: "src/rogue.ts" })) as { block: boolean; reason: string };
		assert.equal(outside.block, true);
		assert.ok(outside.reason.startsWith(BLOCKED_MARKER), outside.reason);
		assert.match(outside.reason, /NEEDS/);

		assert.equal(await w.toolCall("write", { file_path: "src/api.ts", content: "v2" }), undefined, "a listed file is allowed");

		const push = (await w.toolCall("bash", { command: "git push origin main" })) as { block: boolean; reason: string };
		assert.equal(push.block, true);
		assert.ok(push.reason.startsWith(BLOCKED_MARKER), push.reason);

		assert.equal(await w.toolCall("bash", { command: "npm test" }), undefined, "an ordinary command is allowed");

		await w.start();
		assert.equal(fs.existsSync(path.join(dir, ".plans")), false, "a worker never installs the watcher or its dirs");
	} finally {
		restoreGuardEnv();
	}
});

test("preflight: unsafe files and missing verify commands reject the plan before any worker starts", async () => {
	const dir = repo();
	const x = boot(dir, true);
	try {
		await x.start();

		drop(
			dir,
			"badfiles",
			`---
id: badfiles
trace: tr
status: ready
---
Context.

## task: api
files: ../x.ts
depends_on: []
Edit.
`,
		);
		await waitFor(path.join(dir, ".plans/failed/badfiles.error.md"));
		const filesErr = fs.readFileSync(path.join(dir, ".plans/failed/badfiles.error.md"), "utf8");
		assert.match(filesErr, /\.\.\/x\.ts/);
		assert.equal(fs.existsSync(path.join(dir, ".plans/done/badfiles")), false, "no worker starts");

		drop(dir, "badverify", planText("badverify", "trace: tr\nverify: definitely-not-a-command-xyz\n"));
		await waitFor(path.join(dir, ".plans/failed/badverify.error.md"));
		const verifyErr = fs.readFileSync(path.join(dir, ".plans/failed/badverify.error.md"), "utf8");
		assert.match(verifyErr, /definitely-not-a-command-xyz/);
		assert.equal(fs.existsSync(path.join(dir, ".plans/done/badverify")), false, "no worker starts");

		drop(
			dir,
			"badtaskverify",
			`---
id: badtaskverify
trace: tr
status: ready
---
Context.

## task: api
files: src/api.ts
verify: also-not-a-command-xyz
depends_on: []
Edit.
`,
		);
		await waitFor(path.join(dir, ".plans/failed/badtaskverify.error.md"));
		const taskErr = fs.readFileSync(path.join(dir, ".plans/failed/badtaskverify.error.md"), "utf8");
		assert.match(taskErr, /task api: verify command not found: also-not-a-command-xyz/);
	} finally {
		await x.stop();
	}

	const rejected = readEvents(path.join(dir, ".plans"), "tr").filter((e) => e.kind === "plan.rejected");
	assert.deepEqual(rejected.map((e) => e.plan).sort(), ["badfiles", "badtaskverify", "badverify"]);
});

test("verify: the dispatcher runs the task command itself and records a PASS", async () => {
	const dir = repo();
	fakePi(dir, editsApi);
	const x = boot(dir, false);
	try {
		await x.start();
		drop(
			dir,
			"vr1",
			`---
id: vr1
trace: tr
status: ready
---
Context.

## task: api
files: src/api.ts
verify: node -e "process.exit(0)"
depends_on: []
Edit the api.
`,
		);
		await waitFor(path.join(dir, ".plans/done/vr1/_summary.md"));
	} finally {
		await x.stop();
	}

	const out = path.join(dir, ".plans/done/vr1");
	assert.ok(fs.existsSync(path.join(out, "api.verify.md")), "verification report saved");
	const ev = JSON.parse(fs.readFileSync(path.join(out, "evidence.json"), "utf8"));
	assert.deepEqual(ev.verify, [{ scope: "api", ok: true, command: 'node -e "process.exit(0)"' }]);
	assert.equal(ev.gate.pass, true, JSON.stringify(ev.faults));

	const verifyEvents = readEvents(path.join(dir, ".plans"), "tr").filter((e) => e.kind === "task.verify");
	assert.equal(verifyEvents.length, 1);
	assert.equal(verifyEvents[0].task, "api");
	assert.equal((verifyEvents[0].data as { ok: boolean }).ok, true);
	assert.match(fs.readFileSync(path.join(out, "_summary.md"), "utf8"), /verification:\n- api: PASS `node -e "process\.exit\(0\)"`/);
});

test("verify: a failed check retries with its output and the retried worker is told what failed", async () => {
	const dir = repo();
	// Run 1 leaves no marker, so the verify command fails; run 2 creates it.
	fakePi(
		dir,
		`import fs from "node:fs";
const out = (o) => console.log(JSON.stringify(o));
const prompt = process.argv[process.argv.length - 1];
const n = fs.existsSync(".plans/runs.txt") ? Number(fs.readFileSync(".plans/runs.txt", "utf8")) + 1 : 1;
fs.writeFileSync(".plans/runs.txt", String(n));
fs.writeFileSync(".plans/prompt-" + n + ".md", prompt);
out({ type: "tool_execution_start", toolCallId: "1", toolName: "read", args: { path: "src/api.ts" } });
fs.writeFileSync("src/api.ts", "v" + (n + 1));
out({ type: "tool_execution_start", toolCallId: "2", toolName: "edit", args: { path: "src/api.ts" } });
if (n > 1) fs.writeFileSync(".plans/fixed.txt", "ok");
out({ type: "message_end", message: { role: "assistant", stopReason: "stop", usage: { input: 5, output: 5, totalTokens: 10, cost: { total: 0 } },
  content: [{ type: "text", text: "STATUS: done\\nCHANGED:\\nsrc/api.ts\\nTESTS: none\\nNOTES: n\\nNEEDS: none" }] } });
`,
	);
	const x = boot(dir, false);
	try {
		await x.start();
		drop(
			dir,
			"vr2",
			`---
id: vr2
trace: tr
status: ready
---
Context.

## task: api
files: src/api.ts
verify: test -f .plans/fixed.txt
depends_on: []
Edit the api.
`,
		);
		await waitFor(path.join(dir, ".plans/done/vr2/_summary.md"));
	} finally {
		await x.stop();
	}

	const out = path.join(dir, ".plans/done/vr2");
	const ev = JSON.parse(fs.readFileSync(path.join(out, "evidence.json"), "utf8"));
	assert.equal(ev.gate.pass, true, JSON.stringify(ev.faults));
	assert.equal(ev.verify.length, 1, "evidence keeps the last outcome per scope");
	assert.equal(ev.verify[0].scope, "api");
	assert.equal(ev.verify[0].ok, true);
	assert.match(fs.readFileSync(path.join(out, "api.md"), "utf8"), /# api: done/);

	const first = fs.readFileSync(path.join(dir, ".plans/prompt-1.md"), "utf8");
	const second = fs.readFileSync(path.join(dir, ".plans/prompt-2.md"), "utf8");
	assert.doesNotMatch(first, /Your previous attempt failed verification/);
	assert.match(second, /Your previous attempt failed verification/);
	assert.match(second, /Independent verification failed/);
	assert.match(second, /test -f \.plans\/fixed\.txt/);

	const verifyEvents = readEvents(path.join(dir, ".plans"), "tr").filter((e) => e.kind === "task.verify");
	assert.deepEqual(
		verifyEvents.map((e) => (e.data as { ok: boolean }).ok),
		[false, true],
	);
	assert.match(fs.readFileSync(path.join(out, "_summary.md"), "utf8"), /verification:\n- api: PASS/);
});

test("verify: a check that keeps failing fails the task, skips its dependents and fails the gate", async () => {
	const dir = repo();
	fakePi(dir, editsApi);
	const x = boot(dir, false);
	try {
		await x.start();
		drop(
			dir,
			"vr3",
			`---
id: vr3
trace: tr
status: ready
---
Context.

## task: api
files: src/api.ts
verify: node -e "process.exit(3)"
depends_on: []
Edit the api.

## task: docs
files: README.md
depends_on: [api]
Document the api.
`,
		);
		await waitFor(path.join(dir, ".plans/done/vr3/_summary.md"));
	} finally {
		await x.stop();
	}

	const out = path.join(dir, ".plans/done/vr3");
	const ev = JSON.parse(fs.readFileSync(path.join(out, "evidence.json"), "utf8"));
	assert.equal(ev.gate.pass, false);
	assert.deepEqual(ev.verify, [{ scope: "api", ok: false, command: 'node -e "process.exit(3)"' }]);
	const faults = ev.faults as { code: string; severity: string; task?: string }[];
	const verifyFault = faults.find((f) => f.code === "verify_failed")!;
	assert.ok(verifyFault, JSON.stringify(faults));
	assert.equal(verifyFault.severity, "error");
	assert.equal(verifyFault.task, "api");
	assert.match(fs.readFileSync(path.join(out, "api.md"), "utf8"), /# api: failed/);
	assert.match(fs.readFileSync(path.join(out, "docs.md"), "utf8"), /# docs: skipped/);
	assert.equal(fs.existsSync(path.join(out, "api.prompt.md")), true, "the first attempt saved its prompt");
	assert.match(fs.readFileSync(path.join(out, "api.verify.md"), "utf8"), /verification: FAIL/);
	assert.match(fs.readFileSync(path.join(out, "_summary.md"), "utf8"), /verification:\n- api: FAIL/);
});

test("verify: a failing plan-level check fails the gate even when every task is done", async () => {
	const dir = repo();
	fakePi(dir, editsApi);
	const x = boot(dir, false);
	try {
		await x.start();
		drop(
			dir,
			"vr4",
			`---
id: vr4
trace: tr
verify: node -e "process.exit(4)"
status: ready
---
Context.

## task: api
files: src/api.ts
depends_on: []
Edit the api.
`,
		);
		await waitFor(path.join(dir, ".plans/done/vr4/_summary.md"));
	} finally {
		await x.stop();
	}

	const out = path.join(dir, ".plans/done/vr4");
	const ev = JSON.parse(fs.readFileSync(path.join(out, "evidence.json"), "utf8"));
	assert.equal(ev.gate.tasks.done, 1);
	assert.equal(ev.gate.pass, false);
	assert.deepEqual(ev.verify, [{ scope: "plan", ok: false, command: 'node -e "process.exit(4)"' }]);
	const faults = ev.faults as { code: string; severity: string; task?: string }[];
	const verifyFault = faults.find((f) => f.code === "verify_failed")!;
	assert.ok(verifyFault, JSON.stringify(faults));
	assert.equal(verifyFault.task, undefined, "a plan-level fault names no task");
	assert.match(fs.readFileSync(path.join(out, "plan.verify.md"), "utf8"), /verification: FAIL/);
	assert.match(fs.readFileSync(path.join(out, "_summary.md"), "utf8"), /verification:\n- plan: FAIL/);

	const verifyEvents = readEvents(path.join(dir, ".plans"), "tr").filter((e) => e.kind === "task.verify");
	assert.equal(verifyEvents.length, 1);
	assert.equal(verifyEvents[0].task, undefined);
	assert.equal((verifyEvents[0].data as { scope: string }).scope, "plan");
});

// ---------- Pair mode ----------

const REPORT_DONE = "STATUS: done\nCHANGED:\nsrc/api.ts\nTESTS: none\nNOTES: n\nNEEDS: none";
const APPROVE = "VERDICT: approve\nFINDINGS: none";
const CHANGES = "VERDICT: changes\nFINDINGS:\n- src/api.ts:2: the value is not handled. Handle it.";

/**
 * Fake pi that behaves as implementer or reviewer from the prompt it gets.
 * An empty review reply means the reviewer crashes (no output, exit 1).
 */
function pairFake(dir: string, impl: string[], review: string[], config: object = {}) {
	fakePi(
		dir,
		`import fs from "node:fs";
const out = (o) => console.log(JSON.stringify(o));
const prompt = process.argv[process.argv.length - 1];
const isReview = /You are the reviewer for task/.test(prompt);
const bump = (kind) => {
	const f = ".plans/" + kind + ".n";
	const n = fs.existsSync(f) ? Number(fs.readFileSync(f, "utf8")) + 1 : 1;
	fs.writeFileSync(f, String(n));
	fs.writeFileSync(".plans/prompt-" + kind + "-" + n + ".md", prompt);
	return n;
};
const say = (text, cost) =>
	out({ type: "message_end", message: { role: "assistant", stopReason: "stop", usage: { input: 5, output: 5, totalTokens: 10, cost: { total: cost } },
		content: [{ type: "text", text }] } });
if (isReview) {
	const replies = ${JSON.stringify(review)};
	const n = bump("review");
	const text = replies[Math.min(n, replies.length) - 1];
	if (!text) process.exit(1);
	say(text, 0.001);
} else {
	const replies = ${JSON.stringify(impl)};
	const n = bump("impl");
	fs.writeFileSync("src/api.ts", "v" + (n + 1));
	// Run 2 breaks the verify command so a pair re-run can fail verification.
	if (n === 2) fs.writeFileSync(".plans/break.txt", "x");
	if (n >= 3) fs.rmSync(".plans/break.txt", { force: true });
	out({ type: "tool_execution_start", toolCallId: "1", toolName: "read", args: { path: "src/api.ts" } });
	out({ type: "tool_execution_start", toolCallId: "2", toolName: "edit", args: { path: "src/api.ts" } });
	say(replies[Math.min(n, replies.length) - 1], 0);
}
`,
	);
	const file = path.join(dir, ".plans/config.json");
	if (Object.keys(config).length) fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), ...config }));
}

const pairPlan = (id: string, taskLines = "") => `---
id: ${id}
trace: tr
status: ready
---
Context.

## task: api
files: src/api.ts
${taskLines}
depends_on: []
Edit the api.
`;

const evidence = (dir: string, id: string) => JSON.parse(fs.readFileSync(path.join(dir, ".plans/done", id, "evidence.json"), "utf8"));

test("pair: an approving reviewer leaves the task done and its cost joined the task", async () => {
	const dir = repo();
	pairFake(dir, [REPORT_DONE], [APPROVE]);
	await withExtension(dir, false, async () => {
		drop(dir, "pa1", pairPlan("pa1", "pair: review"));
		await waitFor(path.join(dir, ".plans/done/pa1/_summary.md"));
	});

	const out = path.join(dir, ".plans/done/pa1");
	const ev = evidence(dir, "pa1");
	assert.equal(ev.gate.pass, true, JSON.stringify(ev.faults));
	assert.deepEqual(ev.pairs, [{ task: "api", rounds: 1, verdict: "approve", finalVerdict: "approve", unresolved: [], unparsed: false }]);

	const reviews = readEvents(path.join(dir, ".plans"), "tr").filter((e) => e.kind === "task.review");
	assert.equal(reviews.length, 1);
	const data = reviews[0].data as { round: number; reviewer_role: string; model: string; verdict: string; cost: number };
	assert.equal(data.round, 1);
	assert.equal(data.reviewer_role, "review");
	assert.equal(data.model, "opencode-go/minimax-m3.1-flash-free");
	assert.equal(data.verdict, "approve");
	assert.equal(data.cost, 0.001);

	const summary = fs.readFileSync(path.join(out, "_summary.md"), "utf8");
	assert.match(summary, /cost \$0\.0010/, "reviewer cost is part of the task cost");
	assert.match(summary, /pairs:\n- api: 1 round\(s\), verdict approve/);
	assert.match(fs.readFileSync(path.join(out, "api.prompt.md"), "utf8"), /You are a worker executing one task/);
	assert.match(fs.readFileSync(path.join(out, "api.review1.prompt.md"), "utf8"), /You are the reviewer for task "api"/);
});

test("pair: changes send the implementer back with the findings, and a retry still works after a pair re-run", async () => {
	const dir = repo();
	pairFake(dir, [REPORT_DONE, REPORT_DONE, REPORT_DONE], [CHANGES, APPROVE]);
	await withExtension(dir, false, async () => {
		drop(dir, "pb1", pairPlan("pb1", "pair: review\nverify: test ! -f .plans/break.txt"));
		await waitFor(path.join(dir, ".plans/done/pb1/_summary.md"));
	});

	const out = path.join(dir, ".plans/done/pb1");
	const ev = evidence(dir, "pb1");
	assert.equal(ev.gate.pass, true, JSON.stringify(ev.faults));
	assert.equal(ev.pairs[0].rounds, 2);
	assert.equal(ev.pairs[0].verdict, "approve");
	assert.deepEqual(ev.pairs[0].unresolved, []);
	// Run 2 fails verification, so run 3 is the task's own retry: the pair round
	// did not use it up, because attempts - pairRound is 1 at that point.
	assert.match(fs.readFileSync(path.join(out, "api.md"), "utf8"), /# api: done\n- attempts: 3/);
	const second = fs.readFileSync(path.join(dir, ".plans/prompt-impl-2.md"), "utf8");
	assert.match(second, /Review findings from review/);
	assert.match(second, /the value is not handled/);
	assert.match(fs.readFileSync(path.join(dir, ".plans/prompt-impl-3.md"), "utf8"), /Your previous attempt failed verification/);
	assert.match(fs.readFileSync(path.join(dir, ".plans/prompt-review-2.md"), "utf8"), /review round 2/);
});

test("pair: findings open after the last round keep the task done with a pair_unresolved warning", async () => {
	const dir = repo();
	pairFake(dir, [REPORT_DONE, REPORT_DONE], [CHANGES, CHANGES]);
	await withExtension(dir, false, async () => {
		drop(dir, "pc1", pairPlan("pc1", "pair: review"));
		await waitFor(path.join(dir, ".plans/done/pc1/_summary.md"));
	});

	const ev = evidence(dir, "pc1");
	assert.equal(ev.gate.pass, true, JSON.stringify(ev.faults));
	assert.equal(ev.gate.tasks.done, 1);
	const fault = (ev.faults as { code: string; severity: string; task?: string; message: string }[]).find((f) => f.code === "pair_unresolved")!;
	assert.ok(fault, JSON.stringify(ev.faults));
	assert.equal(fault.severity, "warn");
	assert.equal(fault.task, "api");
	assert.match(fault.message, /1 finding\(s\) still open after 2 pair round\(s\)/);
	assert.equal(ev.pairs[0].verdict, "changes");
	assert.equal(ev.pairs[0].unresolved.length, 1);
	assert.equal(readEvents(path.join(dir, ".plans"), "tr").filter((e) => e.kind === "task.review").length, 2);
	assert.match(fs.readFileSync(path.join(dir, ".plans/done/pc1/_summary.md"), "utf8"), /verdict changes, 1 unresolved/);
});

test("pair: a reviewer that crashes never fails the task and is reported as review_unparsed", async () => {
	const dir = repo();
	pairFake(dir, [REPORT_DONE], [""]);
	await withExtension(dir, false, async () => {
		drop(dir, "pd1", pairPlan("pd1", "pair: review"));
		await waitFor(path.join(dir, ".plans/done/pd1/_summary.md"));
	});

	const ev = evidence(dir, "pd1");
	assert.equal(ev.gate.pass, true, JSON.stringify(ev.faults));
	assert.equal(ev.gate.tasks.done, 1);
	const fault = (ev.faults as { code: string; severity: string; task?: string }[]).find((f) => f.code === "review_unparsed")!;
	assert.ok(fault, JSON.stringify(ev.faults));
	assert.equal(fault.severity, "warn");
	assert.equal(ev.pairs[0].verdict, "unknown");
	assert.equal(ev.pairs[0].unparsed, true);
	assert.match(fs.readFileSync(path.join(dir, ".plans/done/pd1/api.md"), "utf8"), /# api: done/);
});

test("pair: a pair role that is not read-only, or a read-only role that is paired, is rejected at preflight", async () => {
	const dir = repo();
	await withExtension(dir, true, async () => {
		drop(dir, "pe1", pairPlan("pe1", "pair: implement"));
		await waitFor(path.join(dir, ".plans/failed/pe1.error.md"));
		assert.match(fs.readFileSync(path.join(dir, ".plans/failed/pe1.error.md"), "utf8"), /pair role "implement" is not read-only/);
		assert.equal(fs.existsSync(path.join(dir, ".plans/done/pe1")), false);

		drop(dir, "pe2", pairPlan("pe2", "role: review\npair: review"));
		await waitFor(path.join(dir, ".plans/failed/pe2.error.md"));
		assert.match(fs.readFileSync(path.join(dir, ".plans/failed/pe2.error.md"), "utf8"), /role "review" is read-only, so it cannot be paired/);
	});
});

test("pair: maxRunsPerTask stops a reviewer that keeps asking for changes", async () => {
	const dir = repo();
	pairFake(dir, [REPORT_DONE, REPORT_DONE], [CHANGES, CHANGES, CHANGES], { maxRunsPerTask: 3 });
	await withExtension(dir, false, async () => {
		drop(dir, "pf1", pairPlan("pf1", "pair: review\npair_rounds: 3"));
		await waitFor(path.join(dir, ".plans/done/pf1/_summary.md"));
	});

	const ev = evidence(dir, "pf1");
	assert.equal(ev.gate.pass, true, JSON.stringify(ev.faults));
	assert.equal(ev.gate.tasks.done, 1);
	assert.equal(readEvents(path.join(dir, ".plans"), "tr").filter((e) => e.kind === "task.review").length, 1, "the cap stops a second review");
	assert.match(fs.readFileSync(path.join(dir, ".plans/done/pf1/api.md"), "utf8"), /# api: done\n- attempts: 2/);
	assert.equal(ev.pairs[0].rounds, 1);
	const fault = (ev.faults as { code: string; message: string }[]).find((f) => f.code === "pair_unresolved")!;
	assert.ok(fault, JSON.stringify(ev.faults));
	assert.match(fault.message, /maxRunsPerTask \(3 worker runs\)/);
});

// ---------- Security role (read-only reviewer) ----------

const SECURITY_ISSUES = "VERDICT: issues\nFINDINGS:\n- [high] src/api.ts:1: user input reaches exec. Escape it.";
const SECURITY_CLEAN = "VERDICT: clean\nFINDINGS: none";

/** Fake pi that answers as a read-only security reviewer; `edit` makes it break that rule. */
function securityFake(dir: string, text: string, edit = false) {
	fakePi(
		dir,
		`import fs from "node:fs";
const out = (o) => console.log(JSON.stringify(o));
const prompt = process.argv[process.argv.length - 1];
fs.writeFileSync(".plans/prompt-security.md", prompt);
${edit ? 'fs.writeFileSync("src/api.ts", "v2");\nout({ type: "tool_execution_start", toolCallId: "1", toolName: "edit", args: { path: "src/api.ts" } });' : ""}
out({ type: "message_end", message: { role: "assistant", stopReason: "stop", usage: { input: 5, output: 5, totalTokens: 10, cost: { total: 0 } },
  content: [{ type: "text", text: ${JSON.stringify(text)} }] } });
`,
	);
}

const securityPlan = (id: string) => `---
id: ${id}
trace: tr
status: ready
---
Context.

## task: audit
files: src/api.ts
role: security
depends_on: []
Review the api for security problems.
`;

test("security: a high finding is an error fault that fails the gate, and the report is evidence", async () => {
	const dir = repo();
	securityFake(dir, SECURITY_ISSUES);
	await withExtension(dir, false, async () => {
		drop(dir, "se1", securityPlan("se1"));
		await waitFor(path.join(dir, ".plans/done/se1/_summary.md"));
	});

	const out = path.join(dir, ".plans/done/se1");
	const ev = evidence(dir, "se1");
	assert.equal(ev.gate.pass, false);
	const fault = (ev.faults as { code: string; severity: string; task?: string; message: string }[]).find((f) => f.code === "security_finding")!;
	assert.ok(fault, JSON.stringify(ev.faults));
	assert.equal(fault.severity, "error");
	assert.equal(fault.task, "audit");
	assert.match(fault.message, /user input reaches exec/);
	assert.deepEqual(ev.reviews, [
		{
			task: "audit",
			role: "security",
			verdict: "issues",
			findings: [{ severity: "high", location: "src/api.ts:1", text: "user input reaches exec. Escape it." }],
		},
	]);

	// The security prompt replaces the implementer prompt that would contradict its format.
	const prompt = fs.readFileSync(path.join(out, "audit.prompt.md"), "utf8");
	assert.match(prompt, /You are the security reviewer for task "audit"/);
	assert.doesNotMatch(prompt, /You are a worker executing one task/);

	const reviews = readEvents(path.join(dir, ".plans"), "tr").filter((e) => e.kind === "task.review");
	assert.equal(reviews.length, 1);
	const data = reviews[0].data as { reviewer_role: string; verdict: string; findings: number; model: string };
	assert.equal(data.reviewer_role, "security");
	assert.equal(data.verdict, "issues");
	assert.equal(data.findings, 1);
	assert.equal(data.model, "opencode-go/glm-5.3-flash");
});

test("security: a clean verdict passes the gate with no implementer noise", async () => {
	const dir = repo();
	securityFake(dir, SECURITY_CLEAN);
	await withExtension(dir, false, async () => {
		drop(dir, "se2", securityPlan("se2"));
		await waitFor(path.join(dir, ".plans/done/se2/_summary.md"));
	});

	const ev = evidence(dir, "se2");
	assert.deepEqual(ev.faults, [], "a read-only reviewer is not judged by the implementer checks");
	assert.equal(ev.gate.pass, true);
	assert.deepEqual(ev.reviews, [{ task: "audit", role: "security", verdict: "clean", findings: [] }]);
});

test("security: a read-only task that edits a file is a readonly_violation error", async () => {
	const dir = repo();
	securityFake(dir, SECURITY_CLEAN, true);
	await withExtension(dir, false, async () => {
		drop(dir, "se3", securityPlan("se3"));
		await waitFor(path.join(dir, ".plans/done/se3/_summary.md"));
	});

	const ev = evidence(dir, "se3");
	assert.equal(ev.gate.pass, false);
	const fault = (ev.faults as { code: string; severity: string; task?: string; message: string }[]).find((f) => f.code === "readonly_violation")!;
	assert.ok(fault, JSON.stringify(ev.faults));
	assert.equal(fault.severity, "error");
	assert.equal(fault.task, "audit");
	assert.match(fault.message, /src\/api\.ts/);
});

test("security: an unreadable report only warns as review_unparsed", async () => {
	const dir = repo();
	securityFake(dir, "I looked around and found nothing to report.");
	await withExtension(dir, false, async () => {
		drop(dir, "se4", securityPlan("se4"));
		await waitFor(path.join(dir, ".plans/done/se4/_summary.md"));
	});

	const ev = evidence(dir, "se4");
	assert.equal(ev.gate.pass, true);
	assert.equal(ev.reviews[0].verdict, "unknown");
	const fault = (ev.faults as { code: string; severity: string }[]).find((f) => f.code === "review_unparsed")!;
	assert.ok(fault, JSON.stringify(ev.faults));
	assert.equal(fault.severity, "warn");
});

// ---------- /plans roles ----------

/** Fake pi for the model smoke test: a single assistant reply, or a failure. */
const smokeFake = (dir: string, ok: boolean) =>
	fakePi(
		dir,
		ok
			? `const out = (o) => console.log(JSON.stringify(o));
out({ type: "message_end", message: { role: "assistant", stopReason: "stop", usage: { input: 3, output: 1, totalTokens: 4, cost: { total: 0.0002 } },
  content: [{ type: "text", text: "OK" }] } });
`
			: `console.error("unknown model opencode-go/nope");
process.exit(1);
`,
	);

test("/plans roles lists each role with its resolved model, thinking level and readonly flag", async () => {
	const dir = repo();
	await withExtension(dir, false, async (x) => {
		await x.command("roles");

		assert.equal(x.notes.length, 4, x.notes.join("\n"));
		assert.match(x.notes[0], /^implement: opencode-go\/deepseek-v4\.1-flash, thinking low, read-write$/);
		assert.match(x.notes[1], /^review: opencode-go\/minimax-m3\.1-flash-free, thinking low, readonly$/);
		assert.match(x.notes[2], /^security: opencode-go\/glm-5\.3-flash, thinking high, readonly$/);
		assert.match(x.notes[3], /^qa: opencode-go\/mimo-v2\.6-flash, thinking none, read-write$/);
	});
});

test("/plans roles test smoke-tests every distinct model and reports PASS", async () => {
	const dir = repo();
	smokeFake(dir, true);
	await withExtension(dir, false, async (x) => {
		await x.command("roles test");

		assert.match(x.notes[0], /^Testing 4 model\(s\) with a tiny call$/);
		const results = x.notes.slice(1);
		assert.equal(results.length, 4, x.notes.join("\n"));
		for (const line of results) assert.match(line, /^PASS opencode-go\/\S+( \(thinking [a-z]+\))?, \$0\.0002, \d+(\.\d)?s$/, line);
		assert.ok(
			results.some((l) => /^PASS opencode-go\/glm-5\.3-flash \(thinking high\)/.test(l)),
			"the security role's model and thinking level are both tested",
		);
		assert.ok(results.some((l) => /^PASS opencode-go\/mimo-v2\.6-flash, /.test(l)), "a role with no thinking level runs without the flag");
	});
});

test("/plans roles test reports FAIL with the error when a model call fails", async () => {
	const dir = repo();
	smokeFake(dir, false);
	await withExtension(dir, false, async (x) => {
		await x.command("roles test");

		const results = x.notes.slice(1);
		assert.equal(results.length, 4, x.notes.join("\n"));
		for (const line of results) assert.match(line, /^FAIL opencode-go\/\S+( \(thinking [a-z]+\))?, \$0\.0000, \d+(\.\d)?s, unknown model opencode-go\/nope$/, line);
	});
});

test("/plans roles test refuses to run while a plan is running", async () => {
	const dir = repo();
	// A worker slow enough to catch the plan mid-flight.
	fakePi(
		dir,
		`const out = (o) => console.log(JSON.stringify(o));
setTimeout(() => out({ type: "message_end", message: { role: "assistant", stopReason: "stop", usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } },
  content: [{ type: "text", text: "STATUS: done\\nCHANGED:\\nTESTS: none\\nNOTES: n\\nNEEDS: none" }] } }), 4000);
`,
	);
	await withExtension(dir, false, async (x) => {
		drop(dir, "rg1", planText("rg1", "trace: tr\n"));
		await waitFor(path.join(dir, ".plans/running/rg1.md"));
		await x.command("roles test");
		const text = x.notes.join("\n");
		assert.match(text, /A plan is running/);
		assert.doesNotMatch(text, /^(PASS|FAIL) /m);
		// Stop mid-plan: the helper's own stop afterwards is then a no-op.
		await x.stop();
		await waitFor(path.join(dir, ".plans/done/rg1/_summary.md"));
	});
});

// ---------- Round 2: fixes from the audit ----------

/** Fake pi: an implementer that edits src/api.ts, or a security reviewer, chosen by prompt. */
function implementThenSecurity(dir: string, implCost: number, securityCost: number, securityText = SECURITY_CLEAN) {
	fakePi(
		dir,
		`import fs from "node:fs";
const out = (o) => console.log(JSON.stringify(o));
const prompt = process.argv[process.argv.length - 1];
const say = (text, cost) =>
	out({ type: "message_end", message: { role: "assistant", stopReason: "stop", usage: { input: 5, output: 5, totalTokens: 10, cost: { total: cost } },
		content: [{ type: "text", text }] } });
if (/You are the security reviewer for task/.test(prompt)) {
	say(${JSON.stringify(securityText)}, ${securityCost});
} else {
	out({ type: "tool_execution_start", toolCallId: "1", toolName: "read", args: { path: "src/api.ts" } });
	fs.writeFileSync("src/api.ts", "v2");
	out({ type: "tool_execution_start", toolCallId: "2", toolName: "edit", args: { path: "src/api.ts" } });
	say(${JSON.stringify(REPORT_DONE)}, ${implCost});
}
`,
	);
}

const implementThenSecurityPlan = (id: string) => `---
id: ${id}
trace: tr
status: ready
---
Context.

## task: api
files: src/api.ts
depends_on: []
Edit the api.

## task: audit
files: src/api.ts
role: security
depends_on: [api]
Review the api for security problems.
`;

test("security: an implementer's change to the same file is never blamed on the read-only reviewer", async () => {
	const dir = repo();
	implementThenSecurity(dir, 0.002, 0.004);
	await withExtension(dir, false, async () => {
		drop(dir, "ri1", implementThenSecurityPlan("ri1"));
		await waitFor(path.join(dir, ".plans/done/ri1/_summary.md"));
	});

	const ev = evidence(dir, "ri1");
	assert.deepEqual(ev.faults, [], "the reviewer gets no readonly_violation for the implementer's edit");
	assert.equal(ev.gate.pass, true);
	assert.equal(ev.gate.tasks.done, 2);
	assert.deepEqual(ev.reviews, [{ task: "audit", role: "security", verdict: "clean", findings: [] }]);
});

test("security: its task.review event carries no cost or tokens, so the Models table counts them once", async () => {
	const dir = repo();
	implementThenSecurity(dir, 0.002, 0.004);
	await withExtension(dir, false, async () => {
		drop(dir, "ri2", implementThenSecurityPlan("ri2"));
		await waitFor(path.join(dir, ".plans/done/ri2/_summary.md"));
	});

	const events = readEvents(path.join(dir, ".plans"), "tr");
	const review = events.filter((e) => e.kind === "task.review")[0];
	const data = review.data as Record<string, unknown>;
	assert.equal(data.reviewer_role, "security");
	assert.equal(data.cost, undefined, "the cost is already on the task.end event");
	assert.equal(data.tokens, undefined);
	const end = events.find((e) => e.kind === "task.end" && e.task === "audit")!;
	assert.equal((end.data as { cost: number }).cost, 0.004);

	const cli = path.resolve(import.meta.dirname, "../dispatch-plan/trace.mjs");
	const report = execFileSync("node", [cli, "report", "--trace", "tr", "--root", dir], { encoding: "utf8" });
	const row = report.split("\n").find((l) => l.startsWith("| opencode-go/glm-5.3-flash |"));
	assert.ok(row, report);
	assert.equal(row, "| opencode-go/glm-5.3-flash | security | 1 | 1 | 10 | $0.0040 | 0 | 0 |");
});

/** Fake pi: an implementer that edits src/api.ts, and a reviewer that misbehaves (`body`). */
function misbehavingReviewer(dir: string, body: string) {
	fakePi(
		dir,
		`import fs from "node:fs";
const out = (o) => console.log(JSON.stringify(o));
const prompt = process.argv[process.argv.length - 1];
const say = (text) =>
	out({ type: "message_end", message: { role: "assistant", stopReason: "stop", usage: { input: 5, output: 5, totalTokens: 10, cost: { total: 0 } },
		content: [{ type: "text", text }] } });
if (/You are the reviewer for task/.test(prompt)) {
${body}
} else {
	out({ type: "tool_execution_start", toolCallId: "1", toolName: "read", args: { path: "src/api.ts" } });
	fs.writeFileSync("src/api.ts", "v2");
	out({ type: "tool_execution_start", toolCallId: "2", toolName: "edit", args: { path: "src/api.ts" } });
	say(${JSON.stringify(REPORT_DONE)});
}
`,
	);
}

test("pair: a reviewer that writes a file anyway is a readonly_violation on the reviewed task", async () => {
	const dir = repo();
	misbehavingReviewer(
		dir,
		`	fs.writeFileSync("src/api.ts", "tampered");
	out({ type: "tool_execution_start", toolCallId: "9", toolName: "edit", args: { path: "src/api.ts" } });
	say(${JSON.stringify(APPROVE)});`,
	);
	await withExtension(dir, false, async () => {
		drop(dir, "ri3", pairPlan("ri3", "pair: review"));
		await waitFor(path.join(dir, ".plans/done/ri3/_summary.md"));
	});

	const ev = evidence(dir, "ri3");
	assert.equal(ev.gate.pass, false);
	const fault = (ev.faults as { code: string; severity: string; task?: string; message: string }[]).find((f) => f.code === "readonly_violation")!;
	assert.ok(fault, JSON.stringify(ev.faults));
	assert.equal(fault.severity, "error");
	assert.equal(fault.task, "api");
	assert.match(fault.message, /pair reviewer changed files: src\/api\.ts/);
	assert.equal(ev.pairs[0].verdict, "approve", "the reviewer approved its own change");
});

test("pair: a reviewer's blocked edit is a blocked_action warning, never a violation", async () => {
	const dir = repo();
	misbehavingReviewer(
		dir,
		`	out({ type: "tool_execution_start", toolCallId: "9", toolName: "edit", args: { path: "src/api.ts" } });
	out({ type: "tool_execution_end", toolCallId: "9", isError: true, result: { content: [{ type: "text", text: "${BLOCKED_MARKER} src/api.ts is outside your files" }] } });
	say(${JSON.stringify(APPROVE)});`,
	);
	await withExtension(dir, false, async () => {
		drop(dir, "ri4", pairPlan("ri4", "pair: review"));
		await waitFor(path.join(dir, ".plans/done/ri4/_summary.md"));
	});

	const ev = evidence(dir, "ri4");
	assert.equal(ev.gate.pass, true, JSON.stringify(ev.faults));
	const faults = ev.faults as { code: string; severity: string; task?: string; message: string }[];
	const blocked = faults.find((f) => f.code === "blocked_action")!;
	assert.ok(blocked, JSON.stringify(faults));
	assert.equal(blocked.severity, "warn");
	assert.equal(blocked.task, "api");
	assert.match(blocked.message, /1 tool call\(s\) blocked by the guard: edit src\/api\.ts/);
	assert.equal(
		faults.some((f) => f.code === "readonly_violation"),
		false,
		"a blocked call changed nothing",
	);
});

const ISSUES = "VERDICT: issues\nFINDINGS:\n- src/api.ts:2: the value is not handled. Handle it.";
const CHANGES_EMPTY = "VERDICT: changes\nFINDINGS: none";

test("pair: an `issues` verdict keeps its findings open for the auditor", async () => {
	const dir = repo();
	pairFake(dir, [REPORT_DONE], [ISSUES]);
	await withExtension(dir, false, async () => {
		drop(dir, "ri5", pairPlan("ri5", "pair: review"));
		await waitFor(path.join(dir, ".plans/done/ri5/_summary.md"));
	});

	const ev = evidence(dir, "ri5");
	assert.equal(ev.gate.pass, true, JSON.stringify(ev.faults));
	assert.equal(ev.pairs[0].finalVerdict, "issues");
	assert.equal(ev.pairs[0].unresolved.length, 1);
	const fault = (ev.faults as { code: string; severity: string; task?: string; message: string }[]).find((f) => f.code === "pair_unresolved")!;
	assert.ok(fault, JSON.stringify(ev.faults));
	assert.equal(fault.severity, "warn");
	assert.match(fault.message, /1 finding\(s\) still open after 1 pair round\(s\): src\/api\.ts:2: the value is not handled/);
	assert.equal(readEvents(path.join(dir, ".plans"), "tr").filter((e) => e.kind === "task.review").length, 1, "issues ends the loop like changes on its last round");
});

test("pair: changes with no findings on the last round still leaves pair_unresolved", async () => {
	const dir = repo();
	pairFake(dir, [REPORT_DONE, REPORT_DONE], [CHANGES_EMPTY, CHANGES_EMPTY]);
	await withExtension(dir, false, async () => {
		drop(dir, "ri6", pairPlan("ri6", "pair: review"));
		await waitFor(path.join(dir, ".plans/done/ri6/_summary.md"));
	});

	const ev = evidence(dir, "ri6");
	assert.equal(ev.gate.pass, true, JSON.stringify(ev.faults));
	assert.equal(ev.pairs[0].rounds, 2);
	assert.equal(ev.pairs[0].finalVerdict, "changes");
	assert.deepEqual(ev.pairs[0].unresolved, []);
	const fault = (ev.faults as { code: string; severity: string; message: string }[]).find((f) => f.code === "pair_unresolved")!;
	assert.ok(fault, JSON.stringify(ev.faults));
	assert.match(fault.message, /pair review ended in changes after 2 pair round\(s\) and listed no findings/);
});

test("pair: the implementer's retry prompt after a review is the review one, not the verify one", async () => {
	const dir = repo();
	pairFake(dir, [REPORT_DONE, REPORT_DONE], [CHANGES, APPROVE]);
	await withExtension(dir, false, async () => {
		drop(dir, "ri7", pairPlan("ri7", "pair: review"));
		await waitFor(path.join(dir, ".plans/done/ri7/_summary.md"));
	});

	const first = fs.readFileSync(path.join(dir, ".plans/prompt-impl-1.md"), "utf8");
	const second = fs.readFileSync(path.join(dir, ".plans/prompt-impl-2.md"), "utf8");
	assert.doesNotMatch(first, /## A reviewer found problems with your change/);
	assert.doesNotMatch(first, /## Your previous attempt failed verification/);
	assert.match(second, /## A reviewer found problems with your change/);
	assert.match(second, /Review findings from review/);
	assert.doesNotMatch(second, /## Your previous attempt failed verification/);
	assert.equal(evidence(dir, "ri7").pairs[0].finalVerdict, "approve");
});

// ---------- Round 3: read-only run windows ----------

/** Fake pi: task `a` implements at once and is reviewed by a reviewer that sleeps;
 * tasks b and c write their own files inside that reviewer's window. */
function windowFake(dir: string) {
	fakePi(
		dir,
		`import fs from "node:fs";
const out = (o) => console.log(JSON.stringify(o));
const prompt = process.argv[process.argv.length - 1];
const say = (text) =>
	out({ type: "message_end", message: { role: "assistant", stopReason: "stop", usage: { input: 5, output: 5, totalTokens: 10, cost: { total: 0 } },
		content: [{ type: "text", text }] } });
const write = (file) => {
	fs.writeFileSync(file, "v2");
	out({ type: "tool_execution_start", toolCallId: "1", toolName: "read", args: { path: file } });
	out({ type: "tool_execution_start", toolCallId: "2", toolName: "edit", args: { path: file } });
	say("STATUS: done\\nCHANGED:\\n" + file + "\\nTESTS: none\\nNOTES: n\\nNEEDS: none");
};
const id = /## Your task: (\\w+)/.exec(prompt)?.[1];
if (/You are the reviewer for task/.test(prompt)) {
	// Hold the reviewer's snapshot window open while the other tasks write.
	setTimeout(() => say("VERDICT: approve\\nFINDINGS: none"), 2000);
} else if (id === "a") {
	write("src/a.ts");
} else {
	setTimeout(() => write("src/" + id + ".ts"), 1500);
}
`,
	);
}

const threeTaskPlan = (id: string) => `---
id: ${id}
trace: tr
status: ready
---
Context.

## task: a
files: src/a.ts
pair: review
depends_on: []
Create the a module.

## task: b
files: src/b.ts
depends_on: []
Create the b module.

## task: c
files: src/c.ts
depends_on: []
Create the c module.
`;

test("pair: another task's parallel edit never counts against a sleeping pair reviewer", async () => {
	const dir = repo();
	windowFake(dir);
	await withExtension(dir, false, async () => {
		drop(dir, "rw1", threeTaskPlan("rw1"));
		await waitFor(path.join(dir, ".plans/done/rw1/_summary.md"));
	});

	const ev = evidence(dir, "rw1");
	assert.equal(ev.gate.tasks.done, 3);
	assert.deepEqual(ev.changed, ["src/a.ts", "src/b.ts", "src/c.ts"], "b and c wrote inside the reviewer's window");
	const faults = ev.faults as { code: string; severity: string; task?: string; message: string }[];
	assert.equal(faults.some((f) => f.code === "readonly_violation"), false, JSON.stringify(faults));
	assert.equal(ev.gate.pass, true, JSON.stringify(faults));
	assert.deepEqual(ev.pairs, [{ task: "a", rounds: 1, verdict: "approve", finalVerdict: "approve", unresolved: [], unparsed: false }]);
});

/** Fake pi: an implementer that edits src/api.ts, and a security reviewer that
 * overwrites the same file without an edit tool call, as a shell write would. */
function shellWritingSecurity(dir: string) {
	fakePi(
		dir,
		`import fs from "node:fs";
const out = (o) => console.log(JSON.stringify(o));
const prompt = process.argv[process.argv.length - 1];
const say = (text) =>
	out({ type: "message_end", message: { role: "assistant", stopReason: "stop", usage: { input: 5, output: 5, totalTokens: 10, cost: { total: 0 } },
		content: [{ type: "text", text }] } });
if (/You are the security reviewer for task/.test(prompt)) {
	fs.writeFileSync("src/api.ts", "tampered by the shell");
	say(${JSON.stringify(SECURITY_CLEAN)});
} else {
	out({ type: "tool_execution_start", toolCallId: "1", toolName: "read", args: { path: "src/api.ts" } });
	fs.writeFileSync("src/api.ts", "v2");
	out({ type: "tool_execution_start", toolCallId: "2", toolName: "edit", args: { path: "src/api.ts" } });
	say(${JSON.stringify(REPORT_DONE)});
}
`,
	);
}

test("security: a shell write to a file it owns is one readonly_violation and fails the gate", async () => {
	const dir = repo();
	shellWritingSecurity(dir);
	await withExtension(dir, false, async () => {
		drop(dir, "rw2", implementThenSecurityPlan("rw2"));
		await waitFor(path.join(dir, ".plans/done/rw2/_summary.md"));
	});

	const ev = evidence(dir, "rw2");
	assert.equal(ev.gate.pass, false);
	const faults = ev.faults as { code: string; severity: string; task?: string; message: string }[];
	const violations = faults.filter((f) => f.code === "readonly_violation");
	assert.equal(violations.length, 1, JSON.stringify(faults));
	assert.equal(violations[0].severity, "error");
	assert.equal(violations[0].task, "audit");
	assert.match(violations[0].message, /read-only task changed files: src\/api\.ts/);
});

/** Fake pi: an implementer that edits src/api.ts, and a security reviewer that only reads it. */
function readingSecurity(dir: string) {
	fakePi(
		dir,
		`import fs from "node:fs";
const out = (o) => console.log(JSON.stringify(o));
const prompt = process.argv[process.argv.length - 1];
const say = (text) =>
	out({ type: "message_end", message: { role: "assistant", stopReason: "stop", usage: { input: 5, output: 5, totalTokens: 10, cost: { total: 0 } },
		content: [{ type: "text", text }] } });
if (/You are the security reviewer for task/.test(prompt)) {
	out({ type: "tool_execution_start", toolCallId: "3", toolName: "read", args: { path: "src/api.ts" } });
	say(${JSON.stringify(SECURITY_CLEAN)});
} else {
	out({ type: "tool_execution_start", toolCallId: "1", toolName: "read", args: { path: "src/api.ts" } });
	fs.writeFileSync("src/api.ts", "v2");
	out({ type: "tool_execution_start", toolCallId: "2", toolName: "edit", args: { path: "src/api.ts" } });
	say(${JSON.stringify(REPORT_DONE)});
}
`,
	);
}

test("security: a read-only task that only reads shares a file with an implementer and passes", async () => {
	const dir = repo();
	readingSecurity(dir);
	await withExtension(dir, false, async () => {
		drop(dir, "rw3", implementThenSecurityPlan("rw3"));
		await waitFor(path.join(dir, ".plans/done/rw3/_summary.md"));
	});

	const ev = evidence(dir, "rw3");
	assert.deepEqual(ev.faults, [], "a read-only task's snapshot window saw no change");
	assert.equal(ev.gate.pass, true);
	assert.equal(ev.gate.tasks.done, 2);
	assert.deepEqual(ev.reviews, [{ task: "audit", role: "security", verdict: "clean", findings: [] }]);
});

// ---------- Round 4: the exact window rule ----------

/**
 * Fake pi: every implementer writes `src/<task id>.ts` and reports it; a pair reviewer runs
 * `body` (which may write) and then approves. Both prompts name their task, so the script
 * picks the worker from it.
 */
function windowWriteFake(dir: string, body: string) {
	fakePi(
		dir,
		`import fs from "node:fs";
const out = (o) => console.log(JSON.stringify(o));
const prompt = process.argv[process.argv.length - 1];
const say = (text) =>
	out({ type: "message_end", message: { role: "assistant", stopReason: "stop", usage: { input: 5, output: 5, totalTokens: 10, cost: { total: 0 } },
		content: [{ type: "text", text }] } });
const write = (file) => {
	out({ type: "tool_execution_start", toolCallId: "1", toolName: "read", args: { path: file } });
	fs.writeFileSync(file, "v2");
	out({ type: "tool_execution_start", toolCallId: "2", toolName: "edit", args: { path: file } });
	say("STATUS: done\\nCHANGED:\\n" + file + "\\nTESTS: none\\nNOTES: n\\nNEEDS: none");
};
if (/You are the reviewer for task/.test(prompt)) {
${body}
	say(${JSON.stringify(APPROVE)});
} else {
	write("src/" + /## Your task: (\\w+)/.exec(prompt)[1] + ".ts");
}
`,
	);
}

test("window: a reviewer that overwrites a finished dependency's file is a readonly_violation", async () => {
	const dir = repo();
	// b is done and no longer running, so nothing else can have written src/b.ts: this is the reviewer.
	windowWriteFake(dir, '\tfs.writeFileSync("src/b.ts", "overwritten by the reviewer");');
	await withExtension(dir, false, async () => {
		drop(
			dir,
			"rx1",
			`---
id: rx1
trace: tr
status: ready
---
Context.

## task: b
files: src/b.ts
depends_on: []
Create the b module.

## task: a
files: src/a.ts
pair: review
depends_on: [b]
Create the a module.
`,
		);
		await waitFor(path.join(dir, ".plans/done/rx1/_summary.md"));
	});

	const ev = evidence(dir, "rx1");
	const faults = ev.faults as { code: string; severity: string; task?: string; message: string }[];
	const violation = faults.find((f) => f.code === "readonly_violation");
	assert.ok(violation, JSON.stringify(faults));
	assert.equal(violation.task, "a", "blamed on the task whose reviewer wrote it");
	assert.equal(violation.message, "pair reviewer changed files: src/b.ts");
	assert.equal(ev.gate.pass, false);
});

test("window: a reviewer's unowned file is a violation even when a task lists no files", async () => {
	const dir = repo();
	// `d` has no `files:`, which used to silence the unowned_change check for the whole plan.
	windowWriteFake(dir, '\tfs.writeFileSync("src/x.ts", "stray");');
	await withExtension(dir, false, async () => {
		drop(
			dir,
			"rx2",
			`---
id: rx2
trace: tr
status: ready
---
Context.

## task: a
files: src/a.ts
pair: review
depends_on: []
Create the a module.

## task: d
depends_on: [a]
Rewrite whatever needs rewriting.
`,
		);
		await waitFor(path.join(dir, ".plans/done/rx2/_summary.md"));
	});

	const ev = evidence(dir, "rx2");
	const faults = ev.faults as { code: string; severity: string; task?: string; message: string }[];
	const violation = faults.find((f) => f.code === "readonly_violation");
	assert.ok(violation, JSON.stringify(faults));
	assert.equal(violation.task, "a");
	assert.match(violation.message, /src\/x\.ts/);
	assert.equal(ev.gate.pass, false);
});
