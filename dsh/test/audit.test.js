import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { auditActor, auditArgsFor, auditReport, auditReportFromStream, buildAuditPrompt, dshAuditArgs, ompAuditArgs, parseAuditJson, providerKeyVar, resolveKeyFromLoginShell, runClaudeAudit } from "../plugins/harness-dispatch/audit.js";

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

// ---- harness-neutral auditor (omp / dsh backends) ----

test("each harness logs under its own actor", () => {
	assert.equal(auditActor("claude"), "opus-plan-auditor");
	assert.equal(auditActor("omp"), "omp-plan-auditor");
	assert.equal(auditActor("dsh"), "dsh-plan-auditor");
	assert.equal(auditActor("nonsense"), "opus-plan-auditor");
});

test("the omp and dsh prompts carry the runtime block and inline the checklist", () => {
	const base = { planPath: "/r/p.md", specPath: "/r/s.md", trace: "t", planId: "p", round: 1, auditRound: 9, root: "/r" };
	const ompPrompt = buildAuditPrompt({ ...base, agent: "omp", model: "mistral/codestral-latest", inlineChecklist: true });
	assert.match(ompPrompt, /## Runtime/);
	assert.match(ompPrompt, /Harness: omp/);
	assert.match(ompPrompt, /omp-plan-auditor/);
	assert.match(ompPrompt, /"harness":"omp"/);
	// the checklist is inlined because omp does not read agent definitions
	assert.match(ompPrompt, /Plan audit/);

	const claudePrompt = buildAuditPrompt({ ...base, agent: "claude" });
	assert.match(claudePrompt, /opus-plan-auditor/);
	assert.doesNotMatch(claudePrompt, /## Runtime[\s\S]*the full checklist follows/);
});

test("each backend builds its own argv", () => {
	assert.deepEqual(ompAuditArgs("P", "mistral/codestral-latest").slice(0, -1), ["-p", "--mode", "json", "--no-session", "--tools", "read,grep,glob,bash", "--model", "mistral/codestral-latest"]);
	assert.deepEqual(ompAuditArgs("P").slice(0, -1), ["-p", "--mode", "json", "--no-session", "--tools", "read,grep,glob,bash"]);
	assert.deepEqual(dshAuditArgs("P").slice(0, -2), ["--profile", "headless", "--json"]);
	assert.deepEqual(dshAuditArgs("P", "m").slice(0, -2), ["--profile", "headless", "--json", "--model", "m"]);
	assert.equal(auditArgsFor("claude", "P")[1], "--agent");
	assert.equal(auditArgsFor("omp", "P")[1], "--mode");
	assert.equal(auditArgsFor("dsh", "P")[1], "headless");
});

test("auditReportFromStream reads the verdict out of an event stream", () => {
	const line = (text) => JSON.stringify({ kind: "assistant_end", text, usage: { input: 3, output: 4, total: 7, cost: 0.02 } });
	const parse = (raw) => [JSON.parse(raw)];
	const pass = auditReportFromStream(line("VERDICT: pass\nFINDINGS: none"), parse);
	assert.equal(pass.ok, true);
	assert.equal(pass.verdict, "pass");
	assert.equal(pass.costUsd, 0.02);
	assert.equal(auditReportFromStream(line("VERDICT: fail"), parse).verdict, "fail");
	assert.equal(auditReportFromStream("", parse).verdict, "unknown");
	assert.equal(auditReportFromStream("", parse).ok, false);
});

test("runClaudeAudit drives the omp backend and reports its verdict", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-omp-audit-"));
	const command = path.join(dir, "omp");
	fs.writeFileSync(command, `#!/bin/sh\nprintf '%s\\n' '{"kind":"assistant_end","text":"VERDICT: pass","usage":{"cost":0.5}}'\n`);
	fs.chmodSync(command, 0o755);
	try {
		const result = await runClaudeAudit({
			command,
			agent: "omp",
			model: "mistral/codestral-latest",
			prompt: "AUDIT",
			cwd: dir,
			timeoutMinutes: 1,
			parseLine: (raw) => [JSON.parse(raw)],
		});
		assert.equal(result.agent, "omp");
		assert.equal(result.verdict, "pass");
		assert.equal(result.ok, true);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("providerKeyVar maps a model prefix to its key variable", () => {
	assert.equal(providerKeyVar("mistral/codestral-latest"), "MISTRAL_API_KEY");
	assert.equal(providerKeyVar("openrouter/some-model"), "OPENROUTER_API_KEY");
	assert.equal(providerKeyVar(""), "");
	assert.equal(providerKeyVar("unknown/x"), "");
});

test("resolveKeyFromLoginShell returns an env value untouched and never shells out for it", () => {
	const seen = resolveKeyFromLoginShell("MISTRAL_API_KEY", { env: { MISTRAL_API_KEY: "already-set-value" } });
	assert.equal(seen, "already-set-value");
});

test("resolveKeyFromLoginShell returns empty for an unset variable and a bad name", () => {
	assert.equal(resolveKeyFromLoginShell("DEFINITELY_NOT_SET_XYZ_123", { env: {} }), "");
	assert.equal(resolveKeyFromLoginShell("bad name; rm -rf /", { env: {} }), "");
});

test("a failed harness run never reads as ok and leaves no undefined fields", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-omp-fail-"));
	const command = path.join(dir, "omp");
	fs.writeFileSync(command, "#!/bin/sh\nexit 1\n");
	fs.chmodSync(command, 0o755);
	try {
		const result = await runClaudeAudit({ command, agent: "omp", model: "m/x", prompt: "x", cwd: dir, timeoutMinutes: 1, parseLine: () => [] });
		assert.equal(result.ok, false);
		assert.equal(result.isError, true);
		// The tool output validator requires lossless JSON.
		assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
		assert.equal(Object.values(result).includes(undefined), false);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
