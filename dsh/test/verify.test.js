import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { commandExists, createVerifyLock, runVerify, verifyFeedback, VERIFY_OUTPUT_TAIL } from "../plugins/harness-dispatch/verify.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "dsh-verify-"));

test("runVerify returns exit 0 as ok and captures output", async () => {
	const root = tmp();
	try {
		const r = await runVerify(root, "printf hello", 1);
		assert.equal(r.ok, true);
		assert.equal(r.code, 0);
		assert.equal(r.output, "hello");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("runVerify reports a non-zero exit with its output", async () => {
	const root = tmp();
	try {
		const r = await runVerify(root, "printf nope; exit 3", 1);
		assert.equal(r.ok, false);
		assert.equal(r.code, 3);
		assert.match(r.output, /nope/);
		assert.match(verifyFeedback("false", r), /exit code 3/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("runVerify times out and kills the process group", async () => {
	const root = tmp();
	try {
		const r = await runVerify(root, "sleep 5", 0.005);
		assert.equal(r.ok, false);
		assert.equal(r.timedOut, true);
		assert.match(verifyFeedback("sleep 5", r), /timed out/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("runVerify can be aborted", async () => {
	const root = tmp();
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 50);
	try {
		const r = await runVerify(root, "sleep 5", 10, controller.signal);
		assert.equal(r.ok, false);
		assert.equal(r.timedOut, false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("the verify lock serialises callbacks in call order", async () => {
	const lock = createVerifyLock();
	const order = [];
	const a = lock(async () => {
		await new Promise((r) => setTimeout(r, 20));
		order.push("a");
		return "a";
	});
	const b = lock(async () => {
		order.push("b");
		return "b";
	});
	assert.deepEqual(await Promise.all([a, b]), ["a", "b"]);
	assert.deepEqual(order, ["a", "b"]);
});

test("commandExists handles simple commands, env prefixes, cd and absolute paths", () => {
	const root = tmp();
	try {
		assert.equal(commandExists(root, "node --test"), true);
		assert.equal(commandExists(root, "FOO=1 node x"), true);
		assert.equal(commandExists(root, "node --version"), true);
		assert.equal(commandExists(root, "cd . && node x"), true);
		assert.equal(commandExists(root, "/definitely/not/a/command"), false);
		assert.equal(commandExists(root, "definitely-not-a-command-xyz"), false);
		assert.equal(commandExists(root, ""), false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("output is capped to the tail constant", async () => {
	const root = tmp();
	try {
		const r = await runVerify(root, `node -e "process.stdout.write('x'.repeat(${VERIFY_OUTPUT_TAIL * 2}))"`, 1);
		assert.equal(r.output.length, VERIFY_OUTPUT_TAIL);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
