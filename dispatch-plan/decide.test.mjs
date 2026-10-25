/** Run with: node --test dispatch-plan/decide.test.mjs (Node 24+) */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { MAX_REQUESTS } from "./decide-core.mjs";

const cli = path.join(import.meta.dirname, "decide.mjs");
const dispatcher = path.resolve(import.meta.dirname, "..", "pi-plan-dispatch");
const KEY = `sk-or-v1-${"a".repeat(64)}`;
const MODEL = "perplexity/pplx-decider-flash-v1.2-20261016";
const FULL_REMOTE = "git@github.com:o/n.git";
const NONE_REMOTE = "git@github.com:o/x.git";

/** Git stays away from the real global config, so a test never inherits an identity. */
const GIT_ENV = {
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
	GIT_AUTHOR_NAME: "decider test",
	GIT_AUTHOR_EMAIL: "decider@example.test",
	GIT_COMMITTER_NAME: "decider test",
	GIT_COMMITTER_EMAIL: "decider@example.test",
};

const PLAN = `---
id: cli-effort-r1
trace: cli-effort
round: 1
status: draft
---
Shared plan context for the fixture.

## task: alpha
files: alpha.txt
Implement alpha, a mechanical edit.

## task: beta
role: qa
files: beta.txt
Check beta against its acceptance criteria.

## task: gamma
role: review
files: gamma.txt
Review gamma.
`;

const AUDIT_PLAN = `---
id: cli-audit-r2
trace: cli-audit
round: 2
status: draft
---
Shared plan context for the audit fixture.

## task: alpha
files: alpha.txt
Implement alpha, a mechanical edit.
`;

const SPEC = `# Spec: fixture

## Requirements
- R5. The config key decider holds the modes and the thresholds.
- R6. The effort command suggests one thinking level per task.
- R7. The audit command scores one finding per request.
`;

function git(cwd, args) {
	return execFileSync("git", ["-C", cwd, ...args], {
		env: { ...process.env, ...GIT_ENV },
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function write(dir, name, text) {
	const file = path.join(dir, name);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
	return file;
}

function read(file) {
	return fs.readFileSync(file, "utf8");
}

/** A git project with an origin remote, so the vault can read its slug. */
function makeProject(root, name, remote) {
	const project = path.join(root, name);
	fs.mkdirSync(project, { recursive: true });
	git(project, ["init", "-q", "-b", "main"]);
	if (remote !== undefined) git(project, ["remote", "add", "origin", remote]);
	return project;
}

/** The vault `repo check` reads: a repos.json with the modes of the test repos. */
function makeVault(root, repos) {
	const vault = path.join(root, "vault");
	fs.mkdirSync(vault, { recursive: true });
	fs.writeFileSync(path.join(vault, "repos.json"), `${JSON.stringify({ repos, aliases: {} }, null, 2)}\n`);
	return vault;
}

function writeConfig(project, decider) {
	return write(project, ".plans/config.json", `${JSON.stringify({ decider }, null, 2)}\n`);
}

/** The child environment: no worker flag, no inherited vault, key or fake switch. */
function cliEnv(root, vault) {
	const env = {
		...process.env,
		...GIT_ENV,
		HOME: path.join(root, "home"),
		PI_PLAN_DISPATCH_DIR: dispatcher,
	};
	delete env.PI_PLAN_DISPATCH_WORKER;
	delete env.AGENT_VAULT;
	delete env.AGENT_VAULT_LOCK_WAIT_MS;
	delete env.OPENROUTER_API_KEY;
	delete env.DECIDE_FAKE_BACKEND;
	delete env.DECIDE_ALLOW_FAKE;
	if (vault !== undefined) env.AGENT_VAULT = vault;
	return env;
}

function run(root, args, opts = {}) {
	const result = spawnSync(process.execPath, [cli, ...args], {
		env: { ...cliEnv(root, opts.vault), ...opts.env },
		cwd: opts.cwd ?? root,
		encoding: "utf8",
		timeout: 60_000,
	});
	return { code: result.status, out: result.stdout, err: result.stderr };
}

function withRoot(body) {
	return async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "decide-cli-"));
		try {
			await body({ root });
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	};
}

function events(root, trace) {
	const file = path.join(root, ".plans", "traces", `${trace}.jsonl`);
	if (!fs.existsSync(file)) return [];
	return read(file)
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

function writeTrace(dir, trace, lines) {
	write(
		dir,
		path.join(".plans", "traces", `${trace}.jsonl`),
		`${lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n")}\n`,
	);
}

function writeFake(root, name, results) {
	return write(root, `${name}.json`, `${JSON.stringify(results)}\n`);
}

function effortResult(probabilities, { cost = 0.000004, confidence = 0.8, score = 2 } = {}) {
	return {
		answers: {
			effort: { type: "choice", choice: "low", probabilities, confidence },
			complexity: {
				type: "score",
				score,
				legend: ["trivial", "simple", "moderate", "complex", "very complex"],
				probabilities: { 0: 0.1, 1: 0.2, 2: 0.5, 3: 0.15, 4: 0.05 },
				confidence: 0.7,
			},
		},
		usage: { input_tokens: 100, output_tokens: 5, cost },
		model: MODEL,
	};
}

function defectResult(p, cost = 0.000005) {
	return {
		answers: { real_defect: { type: "noul", noul: p } },
		usage: { input_tokens: 80, output_tokens: 2, cost },
		model: MODEL,
	};
}

/** A live switch is never inherited: these tests only ever use the fake replay. */
function fakeEnv(fake) {
	return { DECIDE_FAKE_BACKEND: fake, DECIDE_ALLOW_FAKE: "1" };
}

test(
	"both commands print disabled and exit 4 when the config leaves them off",
	withRoot(async ({ root }) => {
		const project = makeProject(root, "project", FULL_REMOTE);
		const planFile = write(project, ".plans/inbox/cli-effort-r1.md.draft", PLAN);
		const specFile = write(project, ".plans/specs/cli-audit.md", SPEC);
		const findingsFile = write(project, "findings.json", "[]\n");
		// An empty replay file: a command that reached the backend would exit 6.
		const fake = writeFake(root, "fake", []);
		const runs = [
			["effort", "--plan", planFile, "--trace", "cli-effort"],
			[
				"audit",
				"--plan",
				planFile,
				"--spec",
				specFile,
				"--findings",
				findingsFile,
				"--audit-round",
				"1",
				"--verdict",
				"pass",
				"--trace",
				"cli-audit",
			],
		];
		for (const args of runs) {
			// No vault and no key: the gate would exit 5, so exit 4 means the config came first.
			const result = run(project, args, { env: fakeEnv(fake) });
			assert.equal(result.code, 4, `${args[0]}: ${result.err}`);
			assert.equal(result.out.trim(), "disabled");
		}
		assert.deepEqual(events(project, "cli-effort"), []);
		assert.deepEqual(events(project, "cli-audit"), []);
	}),
);

test(
	"the privacy gate refuses a none repo and allows a full one",
	withRoot(async ({ root }) => {
		const vault = makeVault(root, {
			"github.com/o/n": { mode: "full" },
			"github.com/o/x": { mode: "none" },
		});
		const full = makeProject(root, "full", FULL_REMOTE);
		const none = makeProject(root, "none", NONE_REMOTE);
		writeConfig(full, { effort: "apply" });
		writeConfig(none, { effort: "apply" });
		const planFile = write(full, ".plans/inbox/cli-effort-r1.md.draft", PLAN);
		const fake = writeFake(root, "fake", [
			effortResult({ low: 0.9, high: 0.05, max: 0.05 }),
			effortResult({ low: 0.9, high: 0.05, max: 0.05 }),
		]);
		const env = { OPENROUTER_API_KEY: KEY, ...fakeEnv(fake) };
		const allowed = run(full, ["effort", "--plan", planFile, "--trace", "cli-allowed"], { vault, env });
		assert.equal(allowed.code, 0, allowed.err);
		assert.equal(events(full, "cli-allowed").length, 2);
		const refused = run(none, ["effort", "--plan", planFile, "--trace", "cli-none"], {
			vault,
			env,
			cwd: none,
		});
		assert.equal(refused.code, 5, refused.err);
		assert.equal(refused.out, "");
		assert.equal(refused.err.includes("not allowed: the vault does not allow this repo"), true);
		assert.equal(refused.err.includes("o/x"), false);
		assert.deepEqual(events(none, "cli-none"), []);
		// The gate reads the repository from its working directory, so --root alone opens nothing.
		const elsewhere = run(full, ["effort", "--plan", planFile, "--trace", "cli-none", "--root", none], {
			vault,
			env,
		});
		assert.equal(elsewhere.code, 5, elsewhere.err);
		assert.deepEqual(events(none, "cli-none"), []);
	}),
);

test(
	"a missing key exits 3 before any request",
	withRoot(async ({ root }) => {
		const vault = makeVault(root, { "github.com/o/n": { mode: "full" } });
		const project = makeProject(root, "project", FULL_REMOTE);
		writeConfig(project, { effort: "apply" });
		const planFile = write(project, ".plans/inbox/cli-effort-r1.md.draft", PLAN);
		const fake = writeFake(root, "fake", [effortResult({ low: 0.9, high: 0.05, max: 0.05 })]);
		const result = run(project, ["effort", "--plan", planFile, "--trace", "cli-effort"], {
			vault,
			env: fakeEnv(fake),
		});
		assert.equal(result.code, 3, result.err);
		assert.match(
			result.err,
			/^no key: set OPENROUTER_API_KEY or create ~\/\.config\/pi-plan-dispatch\/openrouter\.key$/m,
		);
		assert.equal(result.out, "");
		assert.deepEqual(events(project, "cli-effort"), []);
	}),
);

test(
	"effort sends the implement and qa tasks, skips the review role and writes one event per task",
	withRoot(async ({ root }) => {
		const vault = makeVault(root, { "github.com/o/n": { mode: "full" } });
		const project = makeProject(root, "project", FULL_REMOTE);
		writeConfig(project, { effort: "apply" });
		const planFile = write(project, ".plans/inbox/cli-effort-r1.md.draft", PLAN);
		const fake = writeFake(root, "fake", [
			effortResult({ low: 0.2, high: 0.3, max: 0.5 }, { cost: 0.000004, score: 3.2 }),
			effortResult({ low: 0.3, high: 0.6, max: 0.1 }, { cost: 0.000006, score: 1.4 }),
		]);
		const result = run(project, ["effort", "--plan", planFile, "--trace", "cli-effort"], {
			vault,
			env: { OPENROUTER_API_KEY: KEY, ...fakeEnv(fake) },
		});
		assert.equal(result.code, 0, result.err);
		const out = JSON.parse(result.out);
		assert.deepEqual(Object.keys(out), ["model", "cost", "tasks"]);
		assert.equal(out.model, MODEL);
		assert.equal(Math.abs(out.cost - 0.00001) < 1e-12, true);
		assert.deepEqual(
			out.tasks.map((task) => task.task),
			["alpha", "beta"],
		);
		assert.deepEqual(out.tasks[0], {
			task: "alpha",
			suggested: "max",
			probabilities: { low: 0.2, high: 0.3, max: 0.5 },
			confidence: 0.8,
			complexity: 3.2,
		});
		// A score above complexityHigh would give high, but max wins; a score below gives low.
		assert.equal(out.tasks[1].suggested, "low");
		assert.equal(out.tasks[1].complexity, 1.4);
		const written = events(project, "cli-effort");
		assert.equal(written.length, 2);
		for (const event of written) {
			assert.equal(event.actor, "decider");
			assert.equal(event.kind, "decision.effort");
			assert.equal(event.plan, "cli-effort-r1");
			assert.equal(event.round, 1);
			assert.equal(event.data.mode, "apply");
			assert.equal(event.data.model, MODEL);
		}
		assert.equal(written[0].data.task, "alpha");
		assert.equal(written[0].data.suggested, "max");
		assert.equal(written[0].data.cost, 0.000004);
		assert.equal(written[1].data.task, "beta");
		assert.equal(written[1].data.cost, 0.000006);
		// The skipped review task never reaches a request, and the key never reaches a file.
		assert.equal(result.out.includes("gamma"), false);
		assert.equal(result.out.includes(KEY), false);
		assert.equal(read(path.join(project, ".plans", "traces", "cli-effort.jsonl")).includes(KEY), false);
	}),
);

test(
	"audit on a pass proposes approve",
	withRoot(async ({ root }) => {
		const vault = makeVault(root, { "github.com/o/n": { mode: "full" } });
		const project = makeProject(root, "project", FULL_REMOTE);
		writeConfig(project, { audit: "shadow" });
		const planFile = write(project, ".plans/inbox/cli-audit-r2.md.draft", AUDIT_PLAN);
		const specFile = write(project, ".plans/specs/cli-audit.md", SPEC);
		const findingsFile = write(
			project,
			"findings.json",
			`${JSON.stringify([
				{ id: "f1", severity: "minor", text: "The wording of R6 is loose.", reqs: ["R6"] },
			])}\n`,
		);
		const fake = writeFake(root, "fake", [defectResult(0.2)]);
		const result = run(
			project,
			[
				"audit",
				"--plan",
				planFile,
				"--spec",
				specFile,
				"--findings",
				findingsFile,
				"--audit-round",
				"3",
				"--verdict",
				"pass",
				"--trace",
				"cli-audit",
			],
			{ vault, env: { OPENROUTER_API_KEY: KEY, ...fakeEnv(fake) } },
		);
		assert.equal(result.code, 0, result.err);
		const out = JSON.parse(result.out);
		assert.deepEqual(Object.keys(out), [
			"model",
			"cost",
			"audit_round",
			"verdict",
			"proposal",
			"aggregate",
			"findings",
		]);
		assert.equal(out.model, MODEL);
		assert.equal(out.cost, 0.000005);
		assert.equal(out.audit_round, 3);
		assert.equal(out.verdict, "pass");
		assert.equal(out.proposal, "approve");
		assert.equal(Math.abs(out.aggregate - 0.04) < 1e-12, true);
		assert.deepEqual(out.findings, [{ id: "f1", severity: "minor", p: 0.2 }]);
		const written = events(project, "cli-audit");
		assert.equal(written.length, 1);
		assert.equal(written[0].kind, "decision.audit");
		assert.equal(written[0].actor, "decider");
		assert.equal(written[0].plan, "cli-audit-r2");
		assert.equal(written[0].round, 2);
		assert.deepEqual(written[0].data, out);
	}),
);

test(
	"audit on a fail dismisses only when every blocker and major is below the threshold",
	withRoot(async ({ root }) => {
		const vault = makeVault(root, { "github.com/o/n": { mode: "full" } });
		const project = makeProject(root, "project", FULL_REMOTE);
		writeConfig(project, { audit: "shadow" });
		const planFile = write(project, ".plans/inbox/cli-audit-r2.md.draft", AUDIT_PLAN);
		const specFile = write(project, ".plans/specs/cli-audit.md", SPEC);
		const args = (findingsFile, trace) => [
			"audit",
			"--plan",
			planFile,
			"--spec",
			specFile,
			"--findings",
			findingsFile,
			"--audit-round",
			"1",
			"--verdict",
			"fail",
			"--trace",
			trace,
		];
		const lowFile = write(
			project,
			"findings-low.json",
			`${JSON.stringify([
				{ id: "f1", severity: "blocker", text: "R5 is not implemented.", reqs: ["R5"] },
				{ id: "f2", severity: "major", text: "The JSON shape differs.", tasks: ["alpha"] },
			])}\n`,
		);
		const lowFake = writeFake(root, "fake-low", [
			defectResult(0.03, 0.000004),
			defectResult(0.07, 0.000006),
		]);
		const dismissed = run(project, args(lowFile, "cli-audit-dismiss"), {
			vault,
			env: { OPENROUTER_API_KEY: KEY, ...fakeEnv(lowFake) },
		});
		assert.equal(dismissed.code, 0, dismissed.err);
		const low = JSON.parse(dismissed.out);
		assert.equal(low.verdict, "fail");
		assert.equal(low.proposal, "dismiss");
		assert.equal(Math.abs(low.cost - 0.00001) < 1e-12, true);
		assert.deepEqual(
			low.findings.map((finding) => finding.id),
			["f1", "f2"],
		);
		const highFile = write(
			project,
			"findings-high.json",
			`${JSON.stringify([{ id: "f1", severity: "blocker", text: "A rule is broken." }])}\n`,
		);
		const highFake = writeFake(root, "fake-high", [defectResult(0.9)]);
		const fixed = run(project, args(highFile, "cli-audit-fix"), {
			vault,
			env: { OPENROUTER_API_KEY: KEY, ...fakeEnv(highFake) },
		});
		assert.equal(fixed.code, 0, fixed.err);
		assert.equal(JSON.parse(fixed.out).proposal, "fix");
		assert.equal(events(project, "cli-audit-dismiss")[0].data.proposal, "dismiss");
		assert.equal(events(project, "cli-audit-fix")[0].data.proposal, "fix");
	}),
);

test(
	"more than the request cap exits 64 before any call",
	withRoot(async ({ root }) => {
		const vault = makeVault(root, { "github.com/o/n": { mode: "full" } });
		const project = makeProject(root, "project", FULL_REMOTE);
		writeConfig(project, { audit: "shadow" });
		const planFile = write(project, ".plans/inbox/cli-audit-r2.md.draft", AUDIT_PLAN);
		const specFile = write(project, ".plans/specs/cli-audit.md", SPEC);
		const many = Array.from({ length: MAX_REQUESTS + 1 }, (_, index) => ({
			id: `f${index + 1}`,
			severity: "minor",
			text: `Finding ${index + 1}.`,
		}));
		const findingsFile = write(project, "findings.json", `${JSON.stringify(many)}\n`);
		const fake = writeFake(root, "fake", []);
		const result = run(
			project,
			[
				"audit",
				"--plan",
				planFile,
				"--spec",
				specFile,
				"--findings",
				findingsFile,
				"--audit-round",
				"1",
				"--verdict",
				"pass",
				"--trace",
				"cli-audit",
			],
			{ vault, env: { OPENROUTER_API_KEY: KEY, ...fakeEnv(fake) } },
		);
		// An empty replay file: a call would have ended in a backend error (6), not 64.
		assert.equal(result.code, 64, result.err);
		assert.match(result.err, /too many requests: 41 findings/);
		assert.deepEqual(events(project, "cli-audit"), []);
	}),
);

test(
	"a malformed backend answer exits 6 with one error event and no key or request text",
	withRoot(async ({ root }) => {
		const vault = makeVault(root, { "github.com/o/n": { mode: "full" } });
		const project = makeProject(root, "project", FULL_REMOTE);
		writeConfig(project, { effort: "apply" });
		const planFile = write(project, ".plans/inbox/cli-effort-r1.md.draft", PLAN);
		const noResult = writeFake(root, "fake", [null]);
		const result = run(project, ["effort", "--plan", planFile, "--trace", "cli-error"], {
			vault,
			env: { OPENROUTER_API_KEY: KEY, ...fakeEnv(noResult) },
		});
		assert.equal(result.code, 6, result.err);
		assert.equal(result.out, "");
		const lines = result.err.trim().split("\n");
		assert.equal(lines.length, 1);
		assert.equal(lines[0], "backend error: fake backend: no result left for this request");
		const written = events(project, "cli-error");
		assert.equal(written.length, 1);
		assert.equal(written[0].kind, "decision.error");
		assert.equal(written[0].actor, "decider");
		assert.equal(written[0].plan, "cli-effort-r1");
		assert.equal(written[0].data.command, "effort");
		assert.equal(written[0].data.status, 0);
		assert.equal(written[0].data.kind, "malformed");
		const traceFile = read(path.join(project, ".plans", "traces", "cli-error.jsonl"));
		for (const secret of [KEY, "Implement alpha"]) {
			assert.equal(result.out.includes(secret), false);
			assert.equal(result.err.includes(secret), false);
			assert.equal(traceFile.includes(secret), false);
		}
		const badAnswer = writeFake(root, "bad-answer", [{ answers: {} }, { answers: {} }]);
		const second = run(project, ["effort", "--plan", planFile, "--trace", "cli-error-answer"], {
			vault,
			env: { OPENROUTER_API_KEY: KEY, ...fakeEnv(badAnswer) },
		});
		assert.equal(second.code, 6, second.err);
		assert.match(second.err, /^backend error: malformed answer: /m);
		assert.equal(events(project, "cli-error-answer").length, 1);
		assert.equal(second.err.includes(KEY), false);
	}),
);

test(
	"stats joins the recorded decisions with what happened",
	withRoot(async ({ root }) => {
		const project = makeProject(root, "project", FULL_REMOTE);
		const ts = (second) => new Date(Date.UTC(2026, 9, 23, 12, 0, second)).toISOString();
		writeTrace(project, "cli-stats", [
			{
				v: 1,
				ts: ts(1),
				trace: "cli-stats",
				actor: "decider",
				kind: "decision.effort",
				plan: "p1",
				round: 1,
				data: {
					task: "alpha",
					suggested: "high",
					probabilities: { low: 0.1, high: 0.8, max: 0.1 },
					confidence: 0.9,
					complexity: 3,
					model: MODEL,
					cost: 0.000004,
					mode: "apply",
				},
			},
			{
				v: 1,
				ts: ts(2),
				trace: "cli-stats",
				actor: "pi-dispatch",
				kind: "task.start",
				plan: "p1",
				round: 1,
				task: "alpha",
				data: { thinking: "high" },
			},
			{
				v: 1,
				ts: ts(3),
				trace: "cli-stats",
				actor: "pi-dispatch",
				kind: "task.end",
				plan: "p1",
				round: 1,
				task: "alpha",
				data: { state: "done", ok: true },
			},
			{
				v: 1,
				ts: ts(4),
				trace: "cli-stats",
				actor: "decider",
				kind: "decision.audit",
				plan: "p1",
				round: 1,
				data: {
					model: MODEL,
					cost: 0.000006,
					audit_round: 1,
					verdict: "pass",
					proposal: "approve",
					aggregate: 0.04,
					findings: [],
				},
			},
			{
				v: 1,
				ts: ts(5),
				trace: "cli-stats",
				actor: "sonnet-orchestrator",
				kind: "plan.approved",
				plan: "p1",
				round: 1,
				data: { approved_by: "user" },
			},
			"not json at all",
		]);
		const result = run(project, ["stats", "--root", project]);
		assert.equal(result.code, 0, result.err);
		assert.match(result.out, /^decider stats$/m);
		assert.match(result.out, /^effort: suggested level vs the level the task ran with$/m);
		assert.match(result.out, /^high\s+high\s+1\s+1\s+0\s+0\s+0$/m);
		assert.match(result.out, /^audit: proposal vs the next event of the trace$/m);
		assert.match(result.out, /^approve\s+pass\s+approved by user\s+1\s+yes$/m);
		assert.match(result.out, /^total cost \$0\.000010$/m);
	}),
);
