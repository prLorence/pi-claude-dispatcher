/** Run with: cd pi-plan-dispatch && node --test --test-force-exit agent-role.test.ts (Node 24+) */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	DEFAULT_CONFIG,
	DEFAULT_ROLES,
	agentProblem,
	buildWorkerPrompt,
	ensureDirs,
	getDirs,
	loadConfig,
	parsePlan,
	preflightPlan,
	resolveAgent,
	resumeCommand,
	runWorker,
	sessionFor,
	smokeTestModel,
	type DispatchConfig,
	type RoleConfig,
} from "./core.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-role-"));

/** A config whose roles are the built-ins with these fields overridden. */
function cfgWithRoles(over: Record<string, Partial<RoleConfig>>): DispatchConfig {
	const roles: Record<string, RoleConfig> = Object.fromEntries(
		Object.entries(DEFAULT_ROLES).map(([name, role]) => [name, { ...role }]),
	);
	for (const [name, fields] of Object.entries(over)) roles[name] = { ...(roles[name] ?? {}), ...fields };
	return { ...DEFAULT_CONFIG, roles };
}

/** Write a `.plans/config.json` under a fresh repo, load it back. */
function loadFrom(config: unknown, dir = tmp()): DispatchConfig {
	const dirs = getDirs(dir);
	ensureDirs(dirs);
	fs.writeFileSync(path.join(dirs.root, "config.json"), JSON.stringify(config));
	return loadConfig(dirs);
}

/** Fake pi: records its argv, then replies once. `marker` proves it was started. */
function fakePi(dir: string, marker: string, reply: string): string {
	const file = path.join(dir, "fake-pi.mjs");
	const argvFile = path.join(dir, "argv.json");
	const message = {
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: reply }],
			stopReason: "stop",
			usage: { cost: { total: 0 }, input: 10, output: 2, totalTokens: 12 },
		},
	};
	const lines = [
		"#!/usr/bin/env node",
		'import fs from "node:fs";',
		`fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));`,
		`fs.writeFileSync(${JSON.stringify(marker)}, "started");`,
		`console.log(${JSON.stringify(JSON.stringify(message))});`,
	];
	fs.writeFileSync(file, lines.join("\n"));
	fs.chmodSync(file, 0o755);
	return file;
}

const readArgv = (dir: string): string[] => JSON.parse(fs.readFileSync(path.join(dir, "argv.json"), "utf8"));

const REPLY = "STATUS: done\nCHANGED: none\nTESTS: none\nNOTES: ok\nNEEDS: none";

test("loadConfig keeps a padded agent as the trimmed name", () => {
	const cfg = loadFrom({ roles: { review: { agent: " omp " } } });
	assert.equal(cfg.roles.review.agent, "omp");
	assert.equal(resolveAgent(cfg, "review"), "omp");
});

test("loadConfig drops an empty or a non-string agent", () => {
	const cfg = loadFrom({ roles: { implement: { agent: "   " }, qa: { agent: 42 }, review: { agent: null } } });
	assert.equal(cfg.roles.implement.agent, undefined, "an empty string is dropped");
	assert.equal(cfg.roles.qa.agent, undefined, "a number is not an agent");
	assert.equal(cfg.roles.review.agent, undefined, "null is not an agent");
	assert.equal(resolveAgent(cfg, "implement"), "pi");
	assert.equal(resolveAgent(cfg, "qa"), "pi");
});

test("a config with no agent resolves every built-in role to pi", () => {
	const cfg = loadFrom({ roles: {} });
	for (const name of Object.keys(DEFAULT_ROLES)) {
		assert.equal(resolveAgent(cfg, name), "pi", `${name} uses the default agent`);
		assert.equal(resolveAgent(DEFAULT_CONFIG, name), "pi", `${name} has no agent in the built-in defaults`);
	}
	assert.equal(DEFAULT_CONFIG.roles.review.agent, undefined, "DEFAULT_ROLES sets no agent");
});

test("a user role entry that sets only model keeps pi as its agent", () => {
	const cfg = loadFrom({ roles: { review: { model: "other/model" } } });
	assert.equal(resolveAgent(cfg, "review"), "pi");
	assert.equal(cfg.roles.review.model, "other/model");
	assert.equal(cfg.roles.review.readonly, true, "the other default fields still apply");
});

test("agentProblem names the role and the agent, and is undefined for pi", () => {
	const cfg = cfgWithRoles({ review: { agent: "omp" } });
	assert.equal(
		agentProblem(cfg, "review"),
		'role "review" names agent "omp", which is not available (known agents: pi)',
	);
	assert.equal(agentProblem(cfg, "implement"), undefined, "no agent means the default, which is known");
	assert.equal(agentProblem(cfgWithRoles({ review: { agent: "pi" } }), "review"), undefined);
});

test("preflight rejects a task role whose agent is not available", () => {
	const cfg = cfgWithRoles({ qa: { agent: "omp" } });
	const plan = parsePlan(`---\nid: p\n---\nctx\n\n## task: t\nrole: qa\nfiles: a.ts\nDo.\n`, "x");
	const errors = preflightPlan(plan, cfg);
	const agentErrors = errors.filter((e) => e.includes("names agent"));
	assert.equal(agentErrors.length, 1);
	assert.equal(agentErrors[0], 'role "qa" names agent "omp", which is not available (known agents: pi)');
});

test("preflight rejects a pair role whose agent is not available", () => {
	const cfg = cfgWithRoles({ review: { agent: "omp" } });
	const plan = parsePlan(`---\nid: p\n---\nctx\n\n## task: t\npair: review\nfiles: a.ts\nDo.\n`, "x");
	const errors = preflightPlan(plan, cfg);
	const agentErrors = errors.filter((e) => e.includes("names agent"));
	assert.equal(agentErrors.length, 1);
	assert.equal(agentErrors[0], 'role "review" names agent "omp", which is not available (known agents: pi)');
});

test("preflight rejects a pairDefault whose agent is not available", () => {
	const cfg = { ...cfgWithRoles({ review: { agent: "omp" } }), pairDefault: "review" };
	const plan = parsePlan(`---\nid: p\n---\nctx\n\n## task: t\nfiles: a.ts\nDo.\n`, "x");
	const errors = preflightPlan(plan, cfg);
	const agentErrors = errors.filter((e) => e.includes("names agent"));
	assert.equal(agentErrors.length, 1);
	assert.equal(agentErrors[0], 'role "review" names agent "omp", which is not available (known agents: pi)');
});

test("preflight reports one agent error when two tasks use the same role", () => {
	const cfg = cfgWithRoles({ qa: { agent: "omp" } });
	const plan = parsePlan(`---\nid: p\n---\nctx\n\n## task: a\nrole: qa\nfiles: a.ts\nDo.\n\n## task: b\nrole: qa\nfiles: b.ts\nDo.\n`, "x");
	const errors = preflightPlan(plan, cfg);
	const agentErrors = errors.filter((e) => e.includes("names agent"));
	assert.equal(agentErrors.length, 1, "the role is named once, not once per task");
	assert.equal(agentErrors[0], 'role "qa" names agent "omp", which is not available (known agents: pi)');
});

test("preflight adds no agent error for a pi or default-agent role", () => {
	const plan = parsePlan(`---\nid: p\n---\nctx\n\n## task: a\nrole: qa\npair: review\nfiles: a.ts\nDo.\n`, "x");
	const base = preflightPlan(plan, DEFAULT_CONFIG);
	const pinned = preflightPlan(plan, cfgWithRoles({ qa: { agent: "pi" } }));
	assert.equal(base.filter((e) => e.includes("names agent")).length, 0);
	assert.equal(pinned.filter((e) => e.includes("names agent")).length, 0);
	assert.deepEqual(pinned, base, "the same plan gives the same errors");

	// an unrelated error stays the same too, so the comparison is not empty vs empty
	const flawed = parsePlan(`---\nid: p\n---\nctx\n\n## task: a\nrole: qa\npair: qa\nfiles: a.ts\nDo.\n`, "x");
	assert.equal(flawed.tasks.length, 1);
	const flawedBase = preflightPlan(flawed, DEFAULT_CONFIG);
	const flawedPinned = preflightPlan(flawed, cfgWithRoles({ qa: { agent: "pi" } }));
	assert.ok(flawedBase.length > 0, "the plan has an unrelated error");
	assert.deepEqual(flawedPinned, flawedBase);
});

test("preflight leaves an unknown role with only its existing error", () => {
	const cfg = cfgWithRoles({ qa: { agent: "omp" } });
	const plan = parsePlan(`---\nid: p\n---\nctx\n\n## task: t\nrole: ghost\nfiles: a.ts\nDo.\n`, "x");
	const errors = preflightPlan(plan, cfg);
	assert.equal(errors.length, 1);
	assert.match(errors[0], /unknown role "ghost"/);
	assert.equal(errors.filter((e) => e.includes("names agent")).length, 0, "an unknown role has no agent error");
});

test("runWorker refuses an agent that became unknown after preflight and spawns nothing", async () => {
	const dir = tmp();
	const marker = path.join(dir, "marker.txt");
	const fake = fakePi(dir, marker, REPLY);
	const cfg = { ...cfgWithRoles({ qa: { agent: "omp" } }), piCommand: fake };
	const plan = parsePlan(`---\nid: p\n---\nctx\n\n## task: t\nrole: qa\nfiles: a.ts\nDo.\n`, "x");
	assert.equal(preflightPlan(plan, cfg).filter((e) => e.includes("names agent")).length, 1, "preflight would catch it");
	const r = await runWorker(dir, cfg, plan, plan.tasks[0], new AbortController().signal);
	assert.equal(r.ok, false);
	assert.equal(r.error, 'unknown agent "omp" for role "qa"');
	assert.equal(fs.existsSync(marker), false, "the fake pi never started");
});

test("smokeTestModel fails for an agent that is not registered", async () => {
	const dir = tmp();
	const r = await smokeTestModel(dir, DEFAULT_CONFIG, "some/model", "low", "omp");
	assert.equal(r.ok, false);
	assert.equal(r.error, 'unknown agent "omp"');
	assert.equal(r.cost, 0);
	assert.equal(r.seconds, 0);
});

test("sessionFor and resumeCommand keep their Pi values, and an unknown agent has no resume command", () => {
	const plan = parsePlan(`---\nid: feat-r2\n---\nctx\n\n## task: api\nfiles: a.ts\nDo.\n`, "x");
	const task = { ...plan.tasks[0], attempts: 1 };
	const session = sessionFor("/repo", DEFAULT_CONFIG, plan, task)!;
	assert.equal(session.id, "feat-r2.api.a1");
	assert.equal(session.dir, path.join("/repo", ".plans/sessions/feat-r2"));
	assert.equal(resumeCommand("/repo", session), "pi --session feat-r2.api.a1 --session-dir .plans/sessions/feat-r2");
	assert.equal(resumeCommand("/repo", session, "pi"), "pi --session feat-r2.api.a1 --session-dir .plans/sessions/feat-r2");
	assert.equal(resumeCommand("/repo", session, "omp"), "");
});

test("runWorker for a role with no agent passes the same argument vector as before", async () => {
	const dir = tmp();
	const marker = path.join(dir, "marker.txt");
	const fake = fakePi(dir, marker, REPLY);
	const cfg = loadFrom({ roles: { qa: { model: "other/qa-model" } } }, dir);
	const full = { ...cfg, piCommand: fake };
	const plan = parsePlan(`---\nid: feat-r2\n---\nctx\n\n## task: api\nrole: qa\nfiles: a.ts\nDo.\n`, "x");
	const task = plan.tasks[0];
	const session = sessionFor(dir, full, plan, task)!;
	const r = await runWorker(dir, full, plan, task, new AbortController().signal);
	assert.equal(r.ok, true);
	assert.equal(fs.existsSync(marker), true, "the fake pi started");
	const argv = readArgv(dir);
	assert.deepEqual(argv.slice(0, 3), ["--mode", "json", "-p"]);
	assert.equal(argv[argv.indexOf("--session-id") + 1], session.id, "the Pi session id is unchanged");
	assert.equal(argv[argv.indexOf("--session-dir") + 1], session.dir);
	assert.equal(argv[argv.indexOf("--name") + 1], "feat-r2/api");
	assert.equal(argv[argv.indexOf("--model") + 1], "other/qa-model");
	assert.ok(!argv.includes("--thinking"), "qa has an empty thinking level, so no flag");
	assert.ok(!argv.includes("--tools"), "no tools list is configured");
	assert.equal(argv[argv.length - 1], buildWorkerPrompt(plan, task, full), "the prompt is the last argument");
	assert.equal(r.session?.id, session.id);
});
