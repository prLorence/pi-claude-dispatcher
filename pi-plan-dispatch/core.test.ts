/** Run with: cd pi-plan-dispatch && node --test core.test.ts trace.test.ts (Node 24+) */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	DEFAULT_CONFIG,
	DEFAULT_PAIR_ROUNDS,
	DEFAULT_ROLES,
	buildWorkerPrompt,
	ensureDirs,
	findVaultPath,
	getDirs,
	knownRoles,
	loadConfig,
	parsePlan,
	preflightPlan,
	resolveModel,
	resolveRole,
	resumeCommand,
	runWorker,
	sessionFor,
	smokeTestModel,
	workerEnv,
	type DispatchConfig,
	type Plan,
	type PlanTask,
} from "./core.ts";
import { BLOCKED_MARKER, GUARD_ENV, VAULT_ENV } from "./guard.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pi-core-"));

/** Minimal plan, so a preflight test states only what it is about. */
function planOf(tasks: Partial<PlanTask>[] = [], extra: Partial<Plan> = {}): Plan {
	return {
		id: "p",
		trace: "p",
		status: "ready",
		context: "",
		tasks: tasks.map((t, i) => ({
			id: t.id ?? `t${i + 1}`,
			files: [],
			dependsOn: [],
			body: "Do the thing.",
			state: "pending",
			attempts: 0,
			pairRound: 0,
			...t,
		})),
		...extra,
	};
}

const PREFLIGHT = (tasks: Partial<PlanTask>[], cfg: Partial<DispatchConfig> = {}) =>
	preflightPlan(planOf(tasks), { ...DEFAULT_CONFIG, ...cfg });

test("parsePlan keeps verify commands raw at plan and task level", () => {
	const text = `---
id: guards-r1
status: ready
verify: npm test -- --grep "#tag" && node --test core.test.ts
---
Context here.

## task: core
files: src/core.ts
model: opencode-go/x   # a comment, still stripped
verify: npm test && node --test core.test.ts # keep this hash
Edit core.

## task: docs
files: docs/a.md
Update docs.
`;
	const plan = parsePlan(text, "x");
	assert.equal(plan.verify, 'npm test -- --grep "#tag" && node --test core.test.ts');
	assert.equal(plan.tasks[0].verify, "npm test && node --test core.test.ts # keep this hash");
	assert.equal(plan.tasks[1].verify, undefined, "no verify line, no command");
	// the other keys keep their comment-stripping behaviour
	assert.equal(plan.tasks[0].model, "opencode-go/x");
});

test("config: guard defaults are present and loadConfig merges over them", () => {
	assert.equal(DEFAULT_CONFIG.verifyTimeoutMinutes, 10);
	assert.equal(DEFAULT_CONFIG.workerGuards, true);
	assert.equal(DEFAULT_CONFIG.maxFilesPerTask, 10);
	assert.equal(DEFAULT_CONFIG.maxTaskChars, 8000);

	const dirs = getDirs(tmp());
	ensureDirs(dirs);
	assert.equal(loadConfig(dirs).workerGuards, true, "no config file means defaults");
	fs.writeFileSync(path.join(dirs.root, "config.json"), JSON.stringify({ workerGuards: false, maxFilesPerTask: 3 }));
	const cfg = loadConfig(dirs);
	assert.equal(cfg.workerGuards, false);
	assert.equal(cfg.maxFilesPerTask, 3);
	assert.equal(cfg.maxTaskChars, 8000, "untouched keys fall back to the defaults");
});

test("preflightPlan rejects absolute, escaping and reserved file entries", () => {
	const absolute = PREFLIGHT([{ id: "api", files: ["/etc/passwd"] }]);
	assert.equal(absolute.length, 1);
	assert.match(absolute[0], /api/);
	assert.match(absolute[0], /\/etc\/passwd/);
	assert.match(absolute[0], /absolute/);

	const escape = PREFLIGHT([{ id: "api", files: ["src/../../secrets.ts"] }]);
	assert.equal(escape.length, 1);
	assert.match(escape[0], /api/);
	assert.match(escape[0], /\.\./);

	for (const [entry, where] of [
		[".git/hooks/pre-commit", /\.git/],
		[".plans/inbox/x.md", /\.plans/],
	] as const) {
		const errors = PREFLIGHT([{ id: "cfg", files: [entry] }]);
		assert.equal(errors.length, 1, entry);
		assert.match(errors[0], /cfg/);
		assert.match(errors[0], where);
	}
});

test("preflightPlan enforces the size limits", () => {
	const files = Array.from({ length: DEFAULT_CONFIG.maxFilesPerTask + 1 }, (_, i) => `src/f${i}.ts`);
	const tooMany = PREFLIGHT([{ id: "wide", files }]);
	assert.equal(tooMany.length, 1);
	assert.match(tooMany[0], /wide/);
	assert.match(tooMany[0], new RegExp(`max ${DEFAULT_CONFIG.maxFilesPerTask}`));

	const long = PREFLIGHT([{ id: "long", body: "x".repeat(DEFAULT_CONFIG.maxTaskChars + 1) }]);
	assert.equal(long.length, 1);
	assert.match(long[0], /long/);
	assert.match(long[0], new RegExp(`max ${DEFAULT_CONFIG.maxTaskChars}`));

	// the limits come from config, not from a hard-coded number
	assert.equal(PREFLIGHT([{ id: "ok", files: ["a.ts", "b.ts", "c.ts"] }], { maxFilesPerTask: 2 }).length, 1);
	assert.equal(PREFLIGHT([{ id: "ok", body: "x".repeat(20) }], { maxTaskChars: 10 }).length, 1);
});

test("preflightPlan passes a clean plan", () => {
	assert.deepEqual(
		PREFLIGHT([
			{ id: "a", files: ["pi-plan-dispatch/core.ts", "pi-plan-dispatch/"] },
			{ id: "b", files: [], body: "Small change, nothing listed." },
		]),
		[],
	);
});

test("preflightPlan with a cwd rejects files entries that leave the repo through a symlink", () => {
	const repo = tmp();
	const outside = tmp();
	try {
		fs.mkdirSync(path.join(repo, "src"), { recursive: true });
		fs.mkdirSync(path.join(repo, "inner"), { recursive: true });
		fs.writeFileSync(path.join(repo, "src", "real.ts"), "x\n");
		fs.writeFileSync(path.join(outside, "existing.md"), "x\n");
		fs.symlinkSync(outside, path.join(repo, "escape"), "dir");
		fs.symlinkSync(path.join(repo, "inner"), path.join(repo, "alias"), "dir");
		fs.symlinkSync(path.join(outside, "existing.md"), path.join(repo, "linked.md"));
		const check = (entry: string) => preflightPlan(planOf([{ id: "a", files: [entry] }]), DEFAULT_CONFIG, repo);

		// a new file below the escaping link, an existing one, and a file link
		for (const entry of ["escape/new/deep.md", "escape/existing.md", "linked.md"]) {
			assert.deepEqual(check(entry), [`Task a: files entry "${entry}" leaves the repo through a symlink`], entry);
		}

		// a normal new file in a new directory, a link that points inside, a real file
		assert.deepEqual(check("src/new/deep.ts"), []);
		assert.deepEqual(check("alias/x.ts"), []);
		assert.deepEqual(check("src/real.ts"), []);

		// no cwd keeps the old behaviour: the symlink is not followed
		assert.deepEqual(PREFLIGHT([{ id: "a", files: ["escape/new/deep.md"] }]), []);
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
		fs.rmSync(outside, { recursive: true, force: true });
	}
});

test("buildWorkerPrompt adds grounding rules and the retry feedback section", () => {
	const plan = parsePlan(`---
id: p
---
ctx

## task: api
files: src/api.ts
Edit api.
`, "x");
	const task = plan.tasks[0];

	const first = buildWorkerPrompt(plan, task);
	assert.match(first, /## Grounding rules/);
	assert.match(first, /Read every file before you edit it/);
	assert.match(first, /Never invent function names, APIs, file paths or package names/);
	assert.match(first, /put it under NEEDS instead of guessing/);
	assert.match(first, /Only report test results from commands you actually ran/);
	assert.match(first, /Do not claim a change you did not make/);
	assert.ok(first.indexOf("## Grounding rules") < first.indexOf("## Final message format"));
	assert.doesNotMatch(first, /previous attempt failed verification/);

	task.feedback = "'npm test' exited 1:\n1 failing test";
	const retry = buildWorkerPrompt(plan, task);
	assert.match(retry, /## Your previous attempt failed verification/);
	assert.match(retry, /1 failing test/);
	assert.match(retry, /Fix the cause of the failure/);
	assert.match(retry, /Do not re-run the same thing blindly/);
});

test("buildWorkerPrompt picks the retry heading from feedbackKind", () => {
	const plan = parsePlan(`---
id: p
---
ctx

## task: api
files: src/api.ts
Edit api.
`, "x");
	const task = plan.tasks[0];
	assert.equal(task.feedbackKind, undefined, "parsePlan leaves it unset");
	task.feedback = "- src/api.ts:12: the null check is missing.";

	// unset keeps the verify heading, for plans and callers written before the field
	const unset = buildWorkerPrompt(plan, task);
	assert.match(unset, /## Your previous attempt failed verification/);
	assert.match(unset, /Fix the cause of the failure/);
	assert.doesNotMatch(unset, /A reviewer found problems/);
	assert.deepEqual(buildWorkerPrompt(plan, { ...task, feedbackKind: "verify" }), unset, "an explicit verify matches unset");

	const review = buildWorkerPrompt(plan, { ...task, feedbackKind: "review" });
	assert.match(review, /## A reviewer found problems with your change/);
	assert.match(review, /the null check is missing/);
	assert.match(review, /explain under NOTES why a finding is wrong/);
	assert.match(review, /Do not re-run the same thing blindly/);
	assert.doesNotMatch(review, /previous attempt failed verification/);
	assert.doesNotMatch(review, /Fix the cause of the failure/);
	assert.ok(review.indexOf("## A reviewer") < review.indexOf("## Your role"), "the findings come before the role");
	assert.ok(review.indexOf("## A reviewer") < review.indexOf("## Rules"));

	// no feedback means no retry section at all, whatever the kind
	assert.doesNotMatch(buildWorkerPrompt(plan, { ...task, feedback: undefined, feedbackKind: "review" }), /A reviewer found problems/);
});

test("runWorker passes the guard policy to the child and records blocked results", async () => {
	const dir = tmp();
	const fake = path.join(dir, "fake-pi.mjs");
	const ev = (o: unknown) => `console.log(${JSON.stringify(JSON.stringify(o))});`;
	// The fake records its own environment, so the test can inspect what runWorker passed on.
	const script = [
		"#!/usr/bin/env node",
		`import fs from "node:fs";`,
		`fs.writeFileSync(process.env.FAKE_ENV_FILE, JSON.stringify({ guard: process.env.${GUARD_ENV} ?? null, worker: process.env.PI_PLAN_DISPATCH_WORKER ?? null }));`,
		ev({ type: "tool_execution_start", toolCallId: "1", toolName: "edit", args: { path: "src/api.ts" } }),
		ev({
			type: "tool_execution_end",
			toolCallId: "1",
			toolName: "edit",
			isError: true,
			result: { content: [{ type: "text", text: `${BLOCKED_MARKER} src/api.ts is outside this task's files` }] },
		}),
		ev({ type: "tool_execution_start", toolCallId: "2", toolName: "bash", args: { command: "npm test" } }),
		ev({ type: "tool_execution_end", toolCallId: "2", toolName: "bash", isError: false, result: "fine\nsecond line" }),
		ev({ type: "tool_execution_start", toolCallId: "3", toolName: "read", args: { path: "src/api.ts" } }),
		ev({ type: "tool_execution_end", toolCallId: "3", toolName: "read", isError: false, result: { output: "y".repeat(500) } }),
		ev({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "STATUS: done\nCHANGED: src/api.ts\nTESTS: none\nNOTES: ok\nNEEDS: none" }],
				stopReason: "stop",
			},
		}),
	].join("\n");
	fs.writeFileSync(fake, script);
	fs.chmodSync(fake, 0o755);

	const plan = parsePlan(`---
id: p
---
ctx

## task: api
files: src/api.ts
Edit api.
`, "x");
	const envFile = path.join(dir, "env.json");
	const previous = process.env.FAKE_ENV_FILE;
	process.env.FAKE_ENV_FILE = envFile;
	try {
		const r = await runWorker(dir, { ...DEFAULT_CONFIG, piCommand: fake }, plan, plan.tasks[0], new AbortController().signal);
		assert.equal(r.ok, true);
		assert.deepEqual(
			r.tools?.map((t) => [t.name, t.path ?? t.detail, !!t.blocked]),
			[
				["edit", "src/api.ts", true],
				["bash", "npm test", false],
				["read", "src/api.ts", false],
			],
		);
		assert.ok(r.tools?.[0].result?.startsWith(BLOCKED_MARKER), "a blocked result is kept on the record");
		assert.equal(r.tools?.[1].result, "fine\nsecond line", "string results are accepted too");
		assert.equal(r.tools?.[2].result?.length, 300, "results are capped at 300 chars");

		const child = JSON.parse(fs.readFileSync(envFile, "utf8"));
		assert.equal(child.worker, "1");
		assert.deepEqual(JSON.parse(child.guard), { files: ["src/api.ts"], bash: true, readonly: false });

		// workerGuards: false turns the policy off
		await runWorker(dir, { ...DEFAULT_CONFIG, piCommand: fake, workerGuards: false }, plan, plan.tasks[0], new AbortController().signal);
		const off = JSON.parse(fs.readFileSync(envFile, "utf8"));
		assert.equal(off.guard, null);
		assert.equal(off.worker, "1", "the no-watcher flag stays on");
	} finally {
		if (previous === undefined) delete process.env.FAKE_ENV_FILE;
		else process.env.FAKE_ENV_FILE = previous;
	}
});

test("findVaultPath: the env var first, then the config, and no vault is undefined", () => {
	const dir = tmp();
	const home = path.join(dir, "home");
	const envVault = path.join(dir, "env-vault");
	const configVault = path.join(dir, "config-vault");
	const configFile = path.join(home, ".config", "agent-vault", "config.json");
	fs.mkdirSync(envVault, { recursive: true });
	fs.mkdirSync(configVault, { recursive: true });
	fs.mkdirSync(path.dirname(configFile), { recursive: true });
	try {
		// $AGENT_VAULT wins when it names an existing directory, and comes back as a realpath
		assert.equal(findVaultPath({ AGENT_VAULT: envVault }, home), fs.realpathSync(envVault));

		// no env var: the `path` of the config file under a temp home
		fs.writeFileSync(configFile, JSON.stringify({ path: configVault }));
		assert.equal(findVaultPath({}, home), fs.realpathSync(configVault));

		// an env value that is not an existing directory falls through to the config
		assert.equal(findVaultPath({ AGENT_VAULT: path.join(dir, "missing") }, home), fs.realpathSync(configVault));

		// a config path that is a file, not a directory, is no vault
		fs.writeFileSync(configFile, JSON.stringify({ path: path.join(dir, "afile") }));
		fs.writeFileSync(path.join(dir, "afile"), "x");
		assert.equal(findVaultPath({}, home), undefined);

		// a garbled config is no vault rather than an error
		fs.writeFileSync(configFile, "{not json");
		assert.equal(findVaultPath({}, home), undefined);
		assert.equal(findVaultPath({ AGENT_VAULT: path.join(dir, "missing") }, home), undefined);

		// nothing configured at all
		assert.equal(findVaultPath({}, path.join(dir, "empty-home")), undefined);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("workerEnv drops AGENT_VAULT, sets or clears the vault variable and keeps the guard rule", () => {
	const dir = tmp();
	const home = path.join(dir, "home");
	const vault = path.join(dir, "vault");
	const configFile = path.join(home, ".config", "agent-vault", "config.json");
	fs.mkdirSync(vault, { recursive: true });
	fs.mkdirSync(path.dirname(configFile), { recursive: true });
	fs.writeFileSync(configFile, JSON.stringify({ path: vault }));
	const plan = parsePlan(`---
id: p
---
ctx

## task: api
files: src/api.ts
Edit api.
`, "x");
	const task = plan.tasks[0];
	const parent = { AGENT_VAULT: path.join(dir, "stale-vault"), KEEP: "yes" };
	try {
		const env = workerEnv(DEFAULT_CONFIG, task, parent, home);
		assert.equal(env.PI_PLAN_DISPATCH_WORKER, "1");
		assert.equal("AGENT_VAULT" in env, false, "the variable is removed, not set to empty");
		assert.equal(env[VAULT_ENV], fs.realpathSync(vault), "the config's vault replaces the parent's AGENT_VAULT");
		assert.equal(env.KEEP, "yes", "the rest of the parent env is copied");
		assert.deepEqual(JSON.parse(env[GUARD_ENV] ?? "null"), { files: ["src/api.ts"], bash: true, readonly: false });
		assert.equal(parent.AGENT_VAULT, path.join(dir, "stale-vault"), "the parent env is not mutated");

		// guards off: the policy goes, the vault variable stays
		const off = workerEnv({ ...DEFAULT_CONFIG, workerGuards: false }, task, parent, home);
		assert.equal("PI_PLAN_DISPATCH_GUARD" in off, false);
		assert.equal(off[VAULT_ENV], fs.realpathSync(vault));
		assert.equal(off.PI_PLAN_DISPATCH_WORKER, "1");

		// a parent's own VAULT_ENV is replaced by what the config says now
		assert.equal(workerEnv(DEFAULT_CONFIG, task, { [VAULT_ENV]: "/stale/vault" }, home)[VAULT_ENV], fs.realpathSync(vault));

		// no vault anywhere: both variables are absent, whatever the parent had
		const none = workerEnv(DEFAULT_CONFIG, task, { AGENT_VAULT: path.join(dir, "stale-vault"), [VAULT_ENV]: vault }, path.join(dir, "empty-home"));
		assert.equal("AGENT_VAULT" in none, false);
		assert.equal("PI_PLAN_DISPATCH_VAULT" in none, false);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("workerEnv drops OPENROUTER_API_KEY, with the guards on and off", () => {
	const dir = tmp();
	const home = path.join(dir, "home");
	fs.mkdirSync(home, { recursive: true });
	const plan = parsePlan(`---
id: p
---
ctx

## task: api
files: src/api.ts
Edit api.
`, "x");
	const task = plan.tasks[0];
	const parent = { OPENROUTER_API_KEY: "sk-or-parent-key", KEEP: "yes" };
	try {
		const env = workerEnv(DEFAULT_CONFIG, task, parent, home);
		assert.equal("OPENROUTER_API_KEY" in env, false, "the key is removed, not set to empty");
		assert.equal(env.KEEP, "yes", "the rest of the parent env is copied");
		assert.equal(parent.OPENROUTER_API_KEY, "sk-or-parent-key", "the parent env is not mutated");

		// guards off: the key still goes
		const off = workerEnv({ ...DEFAULT_CONFIG, workerGuards: false }, task, parent, home);
		assert.equal("OPENROUTER_API_KEY" in off, false);
		assert.equal(off.KEEP, "yes");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("runWorker: the child gets no AGENT_VAULT", async () => {
	const dir = tmp();
	const home = path.join(dir, "home");
	fs.mkdirSync(home, { recursive: true });
	const envFile = path.join(dir, "env.json");
	const fake = path.join(dir, "fake-pi.mjs");
	const reply = {
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "STATUS: done\nCHANGED: none\nTESTS: none\nNOTES: ok\nNEEDS: none" }],
			stopReason: "stop",
		},
	};
	const script = [
		"#!/usr/bin/env node",
		'import fs from "node:fs";',
		`fs.writeFileSync(${JSON.stringify(envFile)}, JSON.stringify({ agentVault: process.env.AGENT_VAULT ?? null, hasAgentVault: "AGENT_VAULT" in process.env }));`,
		`console.log(${JSON.stringify(JSON.stringify(reply))});`,
	].join("\n");
	fs.writeFileSync(fake, script);
	fs.chmodSync(fake, 0o755);

	const plan = parsePlan(`---
id: p
---
ctx

## task: api
files: src/api.ts
Edit api.
`, "x");
	const savedHome = process.env.HOME;
	const savedVault = process.env.AGENT_VAULT;
	process.env.HOME = home;
	process.env.AGENT_VAULT = path.join(dir, "parent-vault");
	try {
		const r = await runWorker(dir, { ...DEFAULT_CONFIG, piCommand: fake }, plan, plan.tasks[0], new AbortController().signal);
		assert.equal(r.ok, true);
		// The default home is the real one here, so only AGENT_VAULT is asserted.
		const child = JSON.parse(fs.readFileSync(envFile, "utf8"));
		assert.equal(child.agentVault, null);
		assert.equal(child.hasAgentVault, false, "the variable is removed from the child environment");
	} finally {
		if (savedHome === undefined) delete process.env.HOME;
		else process.env.HOME = savedHome;
		if (savedVault === undefined) delete process.env.AGENT_VAULT;
		else process.env.AGENT_VAULT = savedVault;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

/** Fake pi: records its argv (and env, when asked), then replies once. */
function fakePi(
	dir: string,
	name: string,
	reply: string,
	opts: { envFile?: string; cost?: number; code?: number; stderr?: string } = {},
): string {
	const file = path.join(dir, name);
	const argvFile = path.join(dir, "argv.json");
	const lines = [
		"#!/usr/bin/env node",
		'import fs from "node:fs";',
		`fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));`,
	];
	if (opts.envFile) {
		lines.push(
			`fs.writeFileSync(${JSON.stringify(opts.envFile)}, JSON.stringify({ guard: process.env.${GUARD_ENV} ?? null, worker: process.env.PI_PLAN_DISPATCH_WORKER ?? null }));`,
		);
	}
	if (opts.stderr) lines.push(`console.error(${JSON.stringify(opts.stderr)});`);
	if (reply) {
		const message = {
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: reply }],
				stopReason: "stop",
				usage: { cost: { total: opts.cost ?? 0 }, input: 10, output: 2, totalTokens: 12 },
			},
		};
		lines.push(`console.log(${JSON.stringify(JSON.stringify(message))});`);
	}
	if (opts.code) lines.push(`process.exitCode = ${opts.code};`);
	fs.writeFileSync(file, lines.join("\n"));
	fs.chmodSync(file, 0o755);
	return file;
}

const readArgv = (dir: string): string[] => JSON.parse(fs.readFileSync(path.join(dir, "argv.json"), "utf8"));

test("roles: defaults, the loadConfig deep merge and unknown names", () => {
	assert.equal(DEFAULT_ROLES.implement.model, undefined, "implement falls back to the config defaults");
	assert.equal(DEFAULT_ROLES.review.model, "opencode-go/minimax-m3.1-flash-free");
	assert.equal(DEFAULT_ROLES.review.thinking, "low");
	assert.equal(DEFAULT_ROLES.review.readonly, true);
	assert.equal(DEFAULT_ROLES.security.model, "opencode-go/glm-5.3-flash");
	assert.equal(DEFAULT_ROLES.security.thinking, "high");
	assert.equal(DEFAULT_ROLES.security.readonly, true);
	assert.equal(DEFAULT_ROLES.qa.model, "opencode-go/mimo-v2.6-flash");
	assert.equal(DEFAULT_ROLES.qa.thinking, "", "qa declares no thinking level");
	assert.equal(DEFAULT_ROLES.qa.readonly, undefined, "qa is a normal implementer task");
	assert.equal(DEFAULT_CONFIG.maxRunsPerTask, 8);

	const dirs = getDirs(tmp());
	ensureDirs(dirs);
	const reviewPrompt = DEFAULT_ROLES.review.prompt;
	fs.writeFileSync(
		path.join(dirs.root, "config.json"),
		JSON.stringify({ roles: { review: { model: "other/model" }, e2e: { model: "e2e/model", prompt: "write end-to-end tests" } } }),
	);
	const cfg = loadConfig(dirs);
	assert.equal(cfg.roles.review.model, "other/model", "a field the user sets wins");
	assert.equal(cfg.roles.review.readonly, true, "fields the user did not set keep their defaults");
	assert.equal(cfg.roles.review.prompt, reviewPrompt);
	assert.equal(cfg.roles.implement.model, undefined);
	assert.equal(cfg.roles.security.model, "opencode-go/glm-5.3-flash");
	assert.deepEqual(cfg.roles.e2e, { model: "e2e/model", prompt: "write end-to-end tests" }, "a new role is added");
	assert.equal(DEFAULT_ROLES.review.model, "opencode-go/minimax-m3.1-flash-free", "the defaults are never mutated");
	assert.deepEqual(knownRoles(cfg).sort(), ["e2e", "implement", "qa", "review", "security"]);
	assert.equal(resolveRole(cfg, "nope").prompt, undefined, "an unknown role resolves to nothing");
	assert.equal(resolveRole(cfg, "qa").readonly, undefined);

	// a config can turn a default role's flag off; preflight reads the merged value
	fs.writeFileSync(path.join(dirs.root, "config.json"), JSON.stringify({ roles: { review: { readonly: false } } }));
	assert.equal(loadConfig(dirs).roles.review.readonly, false);
});

test("parsePlan reads role, pair and pair_rounds from the leading lines", () => {
	const plan = parsePlan(
		`---
id: p
---
ctx

## task: tests
role: qa
pair: review
pair_rounds: 3
files: a.test.ts
Write tests.

## task: plain
files: b.ts
Do.
`,
		"x",
	);
	assert.equal(plan.tasks[0].role, "qa");
	assert.equal(plan.tasks[0].pair, "review");
	assert.equal(plan.tasks[0].pairRounds, 3);
	assert.equal(plan.tasks[0].pairRound, 0, "the pair counter starts at zero");
	assert.equal(plan.tasks[1].role, undefined);
	assert.equal(plan.tasks[1].pair, undefined);
	assert.equal(plan.tasks[1].pairRounds, undefined);

	const defaulted = parsePlan(`---\nid: p\n---\nctx\n\n## task: a\npair: review\nfiles: a.ts\nDo.\n`, "x");
	assert.equal(defaulted.tasks[0].pairRounds, DEFAULT_PAIR_ROUNDS, "pair without pair_rounds gets the default");
});

test("resolveModel: task, role, plan and config order, and empty thinking means no flag", async () => {
	const dir = tmp();
	const fake = fakePi(dir, "fake-pi.mjs", "STATUS: done\nCHANGED: none\nTESTS: none\nNOTES: ok\nNEEDS: none");
	const cfg: DispatchConfig = { ...DEFAULT_CONFIG, piCommand: fake, persistSessions: false, model: "cfg/model", thinking: "cfg-thinking" };
	const plan = parsePlan(
		`---
id: p
model: plan/model
thinking: plan-thinking
---
ctx

## task: plain
files: a.ts
Do it.

## task: byrole
role: review
files: b.ts
Review it.

## task: bytask
role: review
model: task/model
thinking: task-thinking
files: c.ts
Review with overrides.

## task: nothink
thinking:
files: d.ts
No thinking flag.
`,
		"x",
	);
	const task = (id: string): PlanTask => {
		const found = plan.tasks.find((t) => t.id === id);
		assert.ok(found, id);
		return found;
	};
	const run = async (id: string) => {
		const r = await runWorker(dir, cfg, plan, task(id), new AbortController().signal);
		assert.equal(r.ok, true, id);
		return { r, argv: readArgv(dir) };
	};

	// the plan frontmatter beats the config defaults
	const plain = await run("plain");
	assert.equal(plain.r.model, "plan/model");
	assert.equal(plain.r.thinking, "plan-thinking");

	// the role beats the plan frontmatter
	const byrole = await run("byrole");
	assert.equal(byrole.r.model, "opencode-go/minimax-m3.1-flash-free");
	assert.equal(byrole.r.thinking, "low");
	assert.ok(byrole.argv.includes("--thinking"));

	// the task's own lines beat the role
	const bytask = await run("bytask");
	assert.equal(bytask.r.model, "task/model");
	assert.equal(bytask.r.thinking, "task-thinking");
	assert.deepEqual(bytask.argv.slice(bytask.argv.indexOf("--model"), bytask.argv.indexOf("--model") + 4), [
		"--model",
		"task/model",
		"--thinking",
		"task-thinking",
	]);

	// an empty thinking line means: no --thinking argument at all
	const nothink = await run("nothink");
	assert.equal(nothink.r.thinking, "");
	assert.ok(!nothink.argv.includes("--thinking"));

	// the same four levels without a worker, plus qa's empty default
	assert.deepEqual(resolveModel(cfg, plan, { ...task("plain"), model: undefined }), {
		model: "plan/model",
		thinking: "plan-thinking",
		role: "implement",
	});
	assert.deepEqual(resolveModel({ ...cfg, thinking: "" }, { ...plan, model: undefined, thinking: undefined }, { ...task("plain"), model: undefined, thinking: undefined }), {
		model: "cfg/model",
		thinking: "",
		role: "implement",
	});
	assert.deepEqual(resolveModel(cfg, plan, { ...task("plain"), role: "qa" }), {
		model: "opencode-go/mimo-v2.6-flash",
		thinking: "",
		role: "qa",
	});
});

test("buildWorkerPrompt appends the role prompt, and readonly roles reach the guard", async () => {
	const dir = tmp();
	const envFile = path.join(dir, "env.json");
	const fake = fakePi(dir, "fake-pi.mjs", "STATUS: done\nCHANGED: none\nTESTS: none\nNOTES: ok\nNEEDS: none", { envFile });
	const cfg: DispatchConfig = { ...DEFAULT_CONFIG, piCommand: fake, persistSessions: false };
	const plan = parsePlan(
		`---
id: p
---
ctx

## task: impl
files: src/a.ts
Do it.

## task: rev
role: review
files: src/b.ts
Review it.
`,
		"x",
	);

	const impl = buildWorkerPrompt(plan, plan.tasks[0], cfg);
	assert.match(impl, /## Your role\nYou implement exactly one task/);
	assert.equal((impl.match(/## Your role/g) ?? []).length, 1);
	assert.ok(impl.indexOf("## Your role") < impl.indexOf("## Rules"));
	assert.ok(impl.indexOf("## Your role") < impl.indexOf("## Final message format"));

	const rev = buildWorkerPrompt(plan, plan.tasks[1], cfg);
	assert.match(rev, /## Your role\nYou review another engineer's change/);
	assert.doesNotMatch(buildWorkerPrompt(plan, { ...plan.tasks[0], role: "nope" }, cfg), /## Your role/);

	const prev = process.env.FAKE_ENV_FILE;
	process.env.FAKE_ENV_FILE = envFile;
	try {
		await runWorker(dir, cfg, plan, plan.tasks[0], new AbortController().signal);
		assert.equal(JSON.parse(JSON.parse(fs.readFileSync(envFile, "utf8")).guard).readonly, false, "an implementer may edit");

		await runWorker(dir, cfg, plan, plan.tasks[1], new AbortController().signal);
		assert.equal(JSON.parse(JSON.parse(fs.readFileSync(envFile, "utf8")).guard).readonly, true, "a reviewer may not");
	} finally {
		if (prev === undefined) delete process.env.FAKE_ENV_FILE;
		else process.env.FAKE_ENV_FILE = prev;
	}
});

test("runWorker's opts.prompt replaces the built prompt", async () => {
	const dir = tmp();
	const fake = fakePi(dir, "fake-pi.mjs", "VERDICT: approve\nFINDINGS: none");
	const cfg: DispatchConfig = { ...DEFAULT_CONFIG, piCommand: fake, persistSessions: false };
	const plan = parsePlan(`---\nid: p\n---\nctx\n\n## task: a\nfiles: x.ts\nDo.\n`, "x");
	const reviewPrompt = "You are reviewing task a.\nVERDICT: approve | changes\nFINDINGS:";
	const r = await runWorker(dir, cfg, plan, plan.tasks[0], new AbortController().signal, undefined, { prompt: reviewPrompt });
	assert.equal(r.ok, true);
	assert.equal(r.output, "VERDICT: approve\nFINDINGS: none");
	const argv = readArgv(dir);
	assert.equal(argv[argv.length - 1], reviewPrompt, "the reviewer prompt is the last argument");
	assert.ok(!argv.includes(buildWorkerPrompt(plan, plan.tasks[0], cfg)), "the implementer prompt is not sent");
});

test("preflightPlan rejects bad roles and pair settings", () => {
	const unknownRole = PREFLIGHT([{ id: "a", role: "architect" }]);
	assert.equal(unknownRole.length, 1);
	assert.match(unknownRole[0], /a/);
	assert.match(unknownRole[0], /unknown role "architect"/);
	assert.match(unknownRole[0], /known roles: .*implement/);

	const unknownPair = PREFLIGHT([{ id: "b", pair: "architect" }]);
	assert.equal(unknownPair.length, 1);
	assert.match(unknownPair[0], /unknown pair role "architect"/);

	const notReadonly = PREFLIGHT([{ id: "c", pair: "qa" }]);
	assert.equal(notReadonly.length, 1);
	assert.match(notReadonly[0], /pair role "qa" is not read-only/);

	const readonlyOwner = PREFLIGHT([{ id: "d", role: "security", pair: "review" }]);
	assert.equal(readonlyOwner.length, 1);
	assert.match(readonlyOwner[0], /is read-only, so it cannot be paired/);

	for (const rounds of [0, 4, 10, Number.NaN]) {
		const bad = PREFLIGHT([{ id: "e", pair: "review", pairRounds: rounds }]);
		assert.equal(bad.length, 1, `pair_rounds ${rounds}`);
		assert.match(bad[0], /pair_rounds must be 1 to 3/);
	}

	assert.deepEqual(PREFLIGHT([{ id: "g", role: "qa", pair: "review", pairRounds: 3, files: ["t.test.ts"] }]), []);
	assert.deepEqual(PREFLIGHT([{ id: "h", role: "security", files: ["src/auth.ts"] }]), [], "a read-only role needs no pair");
});

test("preflightPlan rejects read-only task roles other than security", () => {
	const reviewTask = PREFLIGHT([{ id: "rev", role: "review", files: ["src/a.ts"] }]);
	assert.equal(reviewTask.length, 1);
	assert.match(reviewTask[0], /rev/);
	assert.match(reviewTask[0], /role "review" is read-only/);
	assert.match(reviewTask[0], /read-only roles other than "security"/);
	assert.match(reviewTask[0], /pair: reviewers/);

	// the same role is still fine as the reviewer of an implementer task
	assert.deepEqual(PREFLIGHT([{ id: "impl", role: "implement", pair: "review", files: ["src/a.ts"] }]), []);
	assert.deepEqual(PREFLIGHT([{ id: "plain", pair: "review", files: ["src/a.ts"] }]), [], "implement is the default role");

	// security is the one read-only role a task may use, with no pair
	assert.deepEqual(PREFLIGHT([{ id: "sec", role: "security", files: ["src/auth.ts"] }]), []);

	// the merged role config decides: a user can turn the flag off
	const editable = PREFLIGHT([{ id: "rev", role: "review", files: ["src/a.ts"] }], {
		roles: { ...DEFAULT_CONFIG.roles, review: { ...resolveRole(DEFAULT_CONFIG, "review"), readonly: false } },
	});
	assert.deepEqual(editable, []);

	// and a user can add a read-only role, which is rejected as a task role too
	const custom = PREFLIGHT([{ id: "x", role: "audit", files: ["src/a.ts"] }], {
		roles: { ...DEFAULT_CONFIG.roles, audit: { readonly: true } },
	});
	assert.equal(custom.length, 1);
	assert.match(custom[0], /role "audit" is read-only/);
});

test("smokeTestModel reports pass with cost and fail with the Pi error", async () => {
	const dir = tmp();
	const envFile = path.join(dir, "env.json");
	const cfg: DispatchConfig = { ...DEFAULT_CONFIG, piCommand: fakePi(dir, "fake-pi.mjs", "OK", { envFile, cost: 0.002 }) };

	const ok = await smokeTestModel(dir, cfg, "opencode-go/glm-5.3-flash", "high");
	assert.equal(ok.ok, true);
	assert.equal(ok.error, undefined);
	assert.equal(ok.cost, 0.002);
	assert.equal(typeof ok.seconds, "number");
	assert.deepEqual(readArgv(dir), [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--model",
		"opencode-go/glm-5.3-flash",
		"--thinking",
		"high",
		"Reply with the single word OK",
	]);
	assert.equal(JSON.parse(fs.readFileSync(envFile, "utf8")).worker, "1", "a smoke test is a worker too");

	// an empty thinking level means no --thinking flag
	await smokeTestModel(dir, cfg, "opencode-go/mimo-v2.6-flash", "");
	assert.ok(!readArgv(dir).includes("--thinking"));

	const broken = fakePi(dir, "broken-pi.mjs", "", { code: 1, stderr: "Error: unknown model opencode-go/nope" });
	const bad = await smokeTestModel(dir, { ...cfg, piCommand: broken }, "opencode-go/nope", "low");
	assert.equal(bad.ok, false);
	assert.match(bad.error ?? "", /unknown model opencode-go\/nope/);

	const silent = fakePi(dir, "silent-pi.mjs", "");
	const none = await smokeTestModel(dir, { ...cfg, piCommand: silent }, "opencode-go/mimo-v2.6-flash", "");
	assert.equal(none.ok, false);
	assert.match(none.error ?? "", /no reply/);
});

test("a tool result is blocked only when it is an error that starts with the guard marker", async () => {
	const dir = tmp();
	const fake = path.join(dir, "fake-pi.mjs");
	const ev = (o: unknown) => `console.log(${JSON.stringify(JSON.stringify(o))});`;
	const done = "STATUS: done\nCHANGED: none\nTESTS: none\nNOTES: ok\nNEEDS: none";
	const script = [
		"#!/usr/bin/env node",
		// a real block: an error result that the guard wrote
		ev({ type: "tool_execution_start", toolCallId: "1", toolName: "edit", args: { path: "src/api.ts" } }),
		ev({
			type: "tool_execution_end",
			toolCallId: "1",
			toolName: "edit",
			isError: true,
			result: { content: [{ type: "text", text: `${BLOCKED_MARKER} src/api.ts is outside this task's files` }] },
		}),
		// a read of guard.ts quotes the marker in a normal result: not a block
		ev({ type: "tool_execution_start", toolCallId: "2", toolName: "read", args: { path: "guard.ts" } }),
		ev({
			type: "tool_execution_end",
			toolCallId: "2",
			toolName: "read",
			isError: false,
			result: { content: [{ type: "text", text: `export const BLOCKED_MARKER = "${BLOCKED_MARKER}";` }] },
		}),
		// an error that merely mentions the marker later in its text is not a block either
		ev({ type: "tool_execution_start", toolCallId: "3", toolName: "bash", args: { command: "grep BLOCKED_MARKER guard.ts" } }),
		ev({
			type: "tool_execution_end",
			toolCallId: "3",
			toolName: "bash",
			isError: true,
			result: { content: [{ type: "text", text: `grep: no match in guard.ts\n${BLOCKED_MARKER}` }] },
		}),
		ev({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: done }], stopReason: "stop" },
		}),
	].join("\n");
	fs.writeFileSync(fake, script);
	fs.chmodSync(fake, 0o755);

	const plan = parsePlan(`---\nid: p\n---\nctx\n\n## task: api\nfiles: src/api.ts\nEdit api.\n`, "x");
	const r = await runWorker(dir, { ...DEFAULT_CONFIG, piCommand: fake, persistSessions: false }, plan, plan.tasks[0], new AbortController().signal);
	assert.equal(r.ok, true);
	assert.deepEqual(
		r.tools?.map((t) => [t.name, !!t.blocked]),
		[
			["edit", true],
			["read", false],
			["bash", false],
		],
	);
});

test("preflightPlan rejects ~, @ and URL entries and case-variant .git/.plans", () => {
	for (const [entry, why] of [
		["~/.zshrc", /~/],
		["@.git/config", /@/],
		["file:///etc/hosts", /URL/],
		[".GIT/config", /\.git/],
		[".Plans/inbox/x.md", /\.plans/],
	] as const) {
		const errors = PREFLIGHT([{ id: "cfg", files: [entry] }]);
		assert.equal(errors.length, 1, entry);
		assert.match(errors[0], /cfg/);
		assert.ok(errors[0].includes(`"${entry}"`), `the entry is quoted back: ${errors[0]}`);
		assert.match(errors[0], why);
	}

	// only a leading ~ or @ is a problem: they are fine inside a relative path
	assert.deepEqual(PREFLIGHT([{ id: "ok", files: ["src/email@2x.ts", "docs/~notes.md"] }]), []);
});

test("sessionFor builds a Pi-valid id and keeps a clean task id as it is", () => {
	const plan = parsePlan(`---\nid: feat-r2\n---\nctx\n\n## task: api\nfiles: a.ts\nDo.\n`, "x");
	const task = { ...plan.tasks[0], attempts: 1 };
	const pattern = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

	const clean = sessionFor("/repo", DEFAULT_CONFIG, plan, task)!;
	assert.equal(clean.id, "feat-r2.api.a1");
	assert.equal(clean.dir, path.join("/repo", ".plans/sessions/feat-r2"));
	assert.equal(resumeCommand("/repo", clean), "pi --session feat-r2.api.a1 --session-dir .plans/sessions/feat-r2");

	// task ids that sanitise to the same part still get different sessions
	const bang = sessionFor("/repo", DEFAULT_CONFIG, plan, { ...task, id: "a!" })!;
	const query = sessionFor("/repo", DEFAULT_CONFIG, plan, { ...task, id: "a?" })!;
	assert.match(bang.id, pattern);
	assert.match(query.id, pattern);
	assert.notEqual(bang.id, query.id);
	assert.match(bang.id, /^feat-r2\.a-[0-9a-f]{8}\.a1$/);
	assert.match(query.id, /^feat-r2\.a-[0-9a-f]{8}\.a1$/);

	// a plan id with a bad character is trimmed for the id and for the directory
	const odd = sessionFor("/repo", DEFAULT_CONFIG, { ...plan, id: "-odd." }, task)!;
	assert.match(odd.id, pattern);
	assert.equal(path.basename(odd.dir), "odd");

	// no session when they are switched off, or on a dry run
	assert.equal(sessionFor("/repo", { ...DEFAULT_CONFIG, persistSessions: false }, plan, task), undefined);
	assert.equal(sessionFor("/repo", { ...DEFAULT_CONFIG, dryRun: true }, plan, task), undefined);
});

test("runWorker moves an old session file out of the way before it starts", async () => {
	const dir = tmp();
	const plan = parsePlan(`---\nid: feat-r2\n---\nctx\n\n## task: api\nfiles: a.ts\nDo.\n`, "x");
	const task = plan.tasks[0];
	const reply = "STATUS: done\nCHANGED: none\nTESTS: none\nNOTES: ok\nNEEDS: none";
	const fake = fakePi(dir, "fake-pi.mjs", reply);
	const session = sessionFor(dir, DEFAULT_CONFIG, plan, task)!;
	const stale = path.join(session.dir, `1000_${session.id}.jsonl`);
	const other = path.join(session.dir, "1000_other.api.a0.jsonl");
	fs.mkdirSync(session.dir, { recursive: true });
	fs.writeFileSync(stale, "old conversation\n");
	fs.writeFileSync(other, "someone else\n");

	const r = await runWorker(dir, { ...DEFAULT_CONFIG, piCommand: fake }, plan, task, new AbortController().signal);
	assert.equal(r.ok, true);
	assert.equal(fs.existsSync(stale), false, "the stale file is no longer under its own name");
	const moved = fs.readdirSync(session.dir).filter((n) => n.startsWith(`1000_${session.id}.jsonl.prev-`));
	assert.equal(moved.length, 1);
	assert.match(moved[0], /\.prev-\d+$/);
	assert.equal(fs.readFileSync(path.join(session.dir, moved[0]), "utf8"), "old conversation\n", "the history is kept");
	assert.equal(fs.readFileSync(other, "utf8"), "someone else\n", "another id's session is left alone");

	// a first run has no session directory yet, and that is not an error
	const fresh = tmp();
	const first = await runWorker(fresh, { ...DEFAULT_CONFIG, piCommand: fakePi(fresh, "fake-pi.mjs", reply) }, plan, task, new AbortController().signal);
	assert.equal(first.ok, true);
	assert.equal(fs.existsSync(path.join(fresh, ".plans", "sessions")), false);
});

test("a worker failure drops Pi's \"No project session found\" warning", async () => {
	const dir = tmp();
	const plan = parsePlan(`---\nid: p\n---\nctx\n\n## task: api\nfiles: a.ts\nDo.\n`, "x");
	const warn = "Warning: No project session found with id 'p.api.a0'; creating a new session with that id.";
	const cfg: DispatchConfig = { ...DEFAULT_CONFIG };

	const silent = fakePi(dir, "silent-pi.mjs", "", { code: 1, stderr: `${warn}\n` });
	const noReply = await runWorker(dir, { ...cfg, piCommand: silent }, plan, plan.tasks[0], new AbortController().signal);
	assert.equal(noReply.ok, false);
	assert.equal(noReply.error, "worker produced no reply", "the warning alone is not the failure reason");

	const broken = fakePi(dir, "broken-pi.mjs", "", { code: 1, stderr: `${warn}\nError: No API key found\n` });
	const real = await runWorker(dir, { ...cfg, piCommand: broken }, plan, plan.tasks[0], new AbortController().signal);
	assert.equal(real.ok, false);
	assert.match(real.error ?? "", /No API key found/, "the real error is kept");
	assert.doesNotMatch(real.error ?? "", /No project session found/);
});
