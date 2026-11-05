import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeSummary, writeTaskResult, writeVerifyReport } from "../plugins/harness-dispatch/output.js";

test("writeTaskResult writes the per-task report", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-output-"));
	try {
		const task = { id: "a", state: "done", attempts: 2, files: ["a.ts"], cost: 0.5, startedAt: 0, endedAt: 1000 };
		writeTaskResult(dir, task, { ok: true, output: "STATUS: done", cost: 0.5, session: { id: "s", file: "f" } });
		const text = fs.readFileSync(path.join(dir, "a.md"), "utf8");
		assert.match(text, /# a: done/);
		assert.match(text, /attempts: 2/);
		assert.match(text, /STATUS: done/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("writeSummary writes the table and short reports", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-summary-"));
	try {
		const plan = { id: "p", tasks: [{ id: "a", state: "done", attempts: 1, cost: 0.2, summary: "ok" }] };
		writeSummary(dir, plan, ["gate: **PASS**"]);
		const text = fs.readFileSync(path.join(dir, "_summary.md"), "utf8");
		assert.match(text, /# Plan p: results/);
		assert.match(text, /gate: \*\*PASS\*\*/);
		assert.match(text, /\| a \| done \| 1 \|/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("writeVerifyReport records command, outcome and the output tail", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-verify-report-"));
	try {
		writeVerifyReport(dir, "plan.verify.md", "node --test", { ok: false, code: 1, timedOut: false, durationMs: 1250, output: "boom" }, 10);
		const text = fs.readFileSync(path.join(dir, "plan.verify.md"), "utf8");
		assert.match(text, /# verification: FAIL/);
		assert.match(text, /node --test/);
		assert.match(text, /exit code: 1/);
		assert.match(text, /boom/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
