/** Run with: node --test pi-plan-dispatch/verify.test.ts (Node 24+) */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { commandExists, createVerifyLock, runVerify, VERIFY_OUTPUT_TAIL, verifyFeedback } from "./verify.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pi-verify-"));

test("runVerify: exit 0 verifies, non-zero does not", async () => {
	const dir = tmp();
	const good = await runVerify(dir, "echo hello", 1);
	assert.equal(good.ok, true);
	assert.equal(good.code, 0);
	assert.equal(good.timedOut, false);
	assert.match(good.output, /hello/);
	assert.ok(good.durationMs >= 0);

	const bad = await runVerify(dir, "echo boom >&2; exit 3", 1);
	assert.equal(bad.ok, false);
	assert.equal(bad.code, 3);
	assert.equal(bad.timedOut, false);
	assert.match(bad.output, /boom/, "stderr is collected too");
});

test("runVerify: runs in cwd, inherits no stdin, keeps only the output tail", async () => {
	const dir = tmp();
	fs.writeFileSync(path.join(dir, "marker.txt"), "x");
	const pwd = await runVerify(dir, "pwd", 1);
	assert.equal(pwd.output.trim(), fs.realpathSync(dir));

	const long = await runVerify(dir, `node -e 'process.stdout.write("x".repeat(2 * ${VERIFY_OUTPUT_TAIL}) + "END")'`, 1);
	assert.equal(long.ok, true);
	assert.equal(long.output.length, VERIFY_OUTPUT_TAIL);
	assert.ok(long.output.endsWith("END"), "the tail survives truncation");
});

test("runVerify: timeout kills the process group and is retried as a failure", async () => {
	const dir = tmp();
	const started = Date.now();
	const r = await runVerify(dir, "sleep 30", 0.01);
	assert.equal(r.timedOut, true);
	assert.equal(r.ok, false);
	assert.equal(r.code, null);
	assert.ok(Date.now() - started < 10_000, "the sleep is killed, not awaited");
});

test("runVerify: a timeout of 0 or less means no timeout", async () => {
	const dir = tmp();
	const zero = await runVerify(dir, "sleep 0.2; echo done", 0);
	assert.equal(zero.ok, true);
	assert.equal(zero.timedOut, false);
	assert.match(zero.output, /done/);

	const negative = await runVerify(dir, "echo hi", -1);
	assert.equal(negative.ok, true);
	assert.equal(negative.timedOut, false);
	assert.match(negative.output, /hi/);
});

test("runVerify: settles on the shell's exit, not on a lingering background child", async () => {
	const dir = tmp();
	const started = Date.now();
	const r = await runVerify(dir, "sleep 20 & echo hi", 1);
	assert.equal(r.ok, true);
	assert.equal(r.code, 0);
	assert.equal(r.timedOut, false);
	assert.match(r.output, /hi/);
	assert.ok(Date.now() - started < 5_000, "the backgrounded sleep does not hold the verify");
});

test("runVerify: a background child of the verify does not survive the shell", async () => {
	const dir = tmp();
	const marker = path.join(dir, "late.marker");
	try {
		const started = Date.now();
		const r = await runVerify(dir, `(sleep 3 && touch '${marker}') >/dev/null 2>&1 & echo hi`, 1);
		assert.equal(r.ok, true);
		assert.equal(r.timedOut, false);
		assert.match(r.output, /hi/);
		assert.ok(Date.now() - started < 5_000, "the verify returns without waiting for the child");

		await new Promise((done) => setTimeout(done, 4_000));
		assert.equal(fs.existsSync(marker), false, "the background child was killed with the group");
	} finally {
		fs.rmSync(marker, { force: true });
	}
});

test("runVerify: abort kills the run but is not a timeout", async () => {
	const dir = tmp();
	const ac = new AbortController();
	setTimeout(() => ac.abort(), 150);
	const r = await runVerify(dir, "sleep 30", 10, ac.signal);
	assert.equal(r.ok, false);
	assert.equal(r.timedOut, false);
	assert.ok(r.durationMs < 10_000);

	// An already-aborted signal must not wait for the timeout.
	const pre = new AbortController();
	pre.abort();
	const early = await runVerify(dir, "sleep 30", 10, pre.signal);
	assert.equal(early.ok, false);
	assert.ok(early.durationMs < 5_000);
});

test("runVerify: the child env drops AGENT_VAULT and marks itself a worker", async () => {
	const dir = tmp();
	const savedVault = process.env.AGENT_VAULT;
	const savedWorker = process.env.PI_PLAN_DISPATCH_WORKER;
	try {
		process.env.AGENT_VAULT = path.join(dir, "vault");
		delete process.env.PI_PLAN_DISPATCH_WORKER;
		const r = await runVerify(dir, 'printf "%s:%s" "${AGENT_VAULT-unset}" "${PI_PLAN_DISPATCH_WORKER-unset}"', 1);
		assert.equal(r.ok, true);
		assert.equal(r.output, "unset:1");
	} finally {
		if (savedVault === undefined) delete process.env.AGENT_VAULT;
		else process.env.AGENT_VAULT = savedVault;
		if (savedWorker === undefined) delete process.env.PI_PLAN_DISPATCH_WORKER;
		else process.env.PI_PLAN_DISPATCH_WORKER = savedWorker;
	}
});

test("runVerify: the child env keeps the rest of the environment", async () => {
	const dir = tmp();
	const home = path.join(dir, "home");
	fs.mkdirSync(home);
	const savedHome = process.env.HOME;
	try {
		process.env.HOME = home;
		const r = await runVerify(dir, 'printf "%s:%s" "$HOME" "${PATH:+set}"', 1);
		assert.equal(r.ok, true);
		assert.equal(r.output, `${home}:set`);
	} finally {
		if (savedHome === undefined) delete process.env.HOME;
		else process.env.HOME = savedHome;
	}
});

test("createVerifyLock: overlapping calls run strictly one at a time, in call order", async () => {
	const lock = createVerifyLock();
	const log: string[] = [];
	const slow = (name: string, ms: number) => async () => {
		log.push(`start ${name}`);
		await new Promise((r) => setTimeout(r, ms));
		log.push(`end ${name}`);
		return name;
	};

	const a = lock(slow("a", 60));
	const b = lock(slow("b", 5));
	const c = lock(slow("c", 5));
	assert.deepEqual(await Promise.all([a, b, c]), ["a", "b", "c"]);
	assert.deepEqual(log, ["start a", "end a", "start b", "end b", "start c", "end c"]);

	// A rejected callback must not poison the queue.
	await assert.rejects(lock(async () => {
		throw new Error("nope");
	}));
	assert.equal(await lock(async () => "still alive"), "still alive");
});

test("commandExists: paths, preludes and missing commands", async () => {
	const dir = tmp();
	assert.equal(commandExists(dir, "node"), true);
	assert.equal(commandExists(dir, "definitely-not-a-command-xyz"), false);
	assert.equal(commandExists(dir, "FOO=1 node -v"), true);
	assert.equal(commandExists(dir, "FOO=1 BAR=2 node -v"), true);

	fs.mkdirSync(path.join(dir, "sub"));
	assert.equal(commandExists(dir, "cd sub && node -v"), true);
	assert.equal(commandExists(dir, "cd nowhere && node -v"), true, "the executable is what is checked");

	const script = path.join(dir, "script.sh");
	fs.writeFileSync(script, "#!/bin/sh\nexit 0\n");
	fs.chmodSync(script, 0o755);
	assert.equal(commandExists(dir, "./script.sh"), true);
	assert.equal(commandExists(dir, "./missing.sh"), false);
});

test("verifyFeedback names the command, the exit code or timeout, and the output tail", async () => {
	const dir = tmp();
	const failed = await runVerify(dir, "echo 'AssertionError: expected 2 got 3' >&2; exit 1", 1);
	const text = verifyFeedback("npm test", failed);
	assert.match(text, /npm test/);
	assert.match(text, /exit code 1/);
	assert.match(text, /AssertionError: expected 2 got 3/);

	const timedOut = await runVerify(dir, "sleep 30", 0.01);
	const slow = verifyFeedback("npm test", timedOut);
	assert.match(slow, /timed out/);
	assert.match(slow, /npm test/);

	const silent = verifyFeedback("true", { ok: false, code: 1, timedOut: false, durationMs: 1, output: "" });
	assert.match(silent, /printed no output/);
});
