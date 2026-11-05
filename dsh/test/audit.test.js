import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { auditReport, buildAuditPrompt, parseAuditJson, runClaudeAudit } from "../plugins/harness-dispatch/audit.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, "..", "fixtures", "fake-claude");

function fakeClaude() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-audit-"));
	const command = path.join(dir, "claude");
	fs.copyFileSync(FIXTURE, command);
	fs.chmodSync(command, 0o755);
	return { dir, command, log: path.join(dir, "calls.jsonl") };
}

test("the audit prompt carries the plan, spec, trace and rounds", () => {
	const prompt = buildAuditPrompt({ planPath: "/repo/.plans/inbox/p.md.draft", specPath: "/repo/.plans/specs/t.md", trace: "t", planId: "p", round: 2, auditRound: 1, root: "/repo" });
	assert.match(prompt, /plan "p" \(round 2\)/);
	assert.match(prompt, /Plan file: \/repo\/\.plans\/inbox\/p\.md\.draft/);
	assert.match(prompt, /Audit round: 1/);
	assert.match(prompt, /plan\.audit/);
	assert.match(prompt, /do not edit files/i);
});

test("parses a whole JSON envelope or the last JSON line", () => {
	assert.equal(parseAuditJson('{"result":"x","is_error":false}').result, "x");
	assert.equal(parseAuditJson('noise\n{"result":"y"}\n').result, "y");
	assert.equal(parseAuditJson("not json"), null);
});

test("auditReport extracts the verdict and usage", () => {
	const report = auditReport({ is_error: false, result: "VERDICT: pass", num_turns: 2, duration_ms: 10, total_cost_usd: 0.1 });
	assert.equal(report.ok, true);
	assert.equal(report.verdict, "pass");
	assert.equal(report.numTurns, 2);
	assert.equal(report.costUsd, 0.1);
	assert.equal(auditReport({ is_error: true, result: "VERDICT: fail" }).verdict, "fail");
});

test("runClaudeAudit invokes the agent with the probe's flags", async () => {
	const f = fakeClaude();
	try {
		const result = await runClaudeAudit({ command: f.command, prompt: "AUDIT THIS", cwd: f.dir, env: { ...process.env, FAKE_CLAUDE_LOG: f.log }, timeoutMinutes: 1 });
		assert.equal(result.ok, true);
		assert.equal(result.verdict, "pass");
		const args = JSON.parse(fs.readFileSync(f.log, "utf8").trim());
		assert.deepEqual(args, ["--print", "--agent", "plan-auditor", "--output-format", "json", "--no-session-persistence", "--allowedTools=Read,Grep,Glob,Bash", "AUDIT THIS"]);
	} finally {
		fs.rmSync(f.dir, { recursive: true, force: true });
	}
});

test("runClaudeAudit reports an error envelope", async () => {
	const f = fakeClaude();
	try {
		const result = await runClaudeAudit({ command: f.command, prompt: "x", cwd: f.dir, env: { ...process.env, FAKE_CLAUDE_MODE: "error" }, timeoutMinutes: 1 });
		assert.equal(result.ok, false);
		assert.equal(result.isError, true);
	} finally {
		fs.rmSync(f.dir, { recursive: true, force: true });
	}
});
