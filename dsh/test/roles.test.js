import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../plugins/harness-dispatch/config.js";
import {
	DEFAULT_ROLES,
	agentProblem,
	applyPairDefault,
	mergeRoles,
	pairDefaultProblem,
	resolveAgent,
	resolveModel,
	resolveRole,
} from "../plugins/harness-dispatch/roles.js";
import { parsePlan } from "../plugins/harness-dispatch/plan.js";

const plan = parsePlan("---\nid: x\nmodel: plan/model\nthinking: high\n---\n## task: a\nfiles: a.ts\nbody\n## task: b\nfiles: b.ts\nrole: review\nbody\n", "x");

function cfg(over = {}) {
	return { ...DEFAULT_CONFIG, roles: mergeRoles(over.roles), ...over, roles: mergeRoles(over.roles) };
}

test("default roles carry their model, thinking and readonly flag", () => {
	assert.equal(DEFAULT_ROLES.review.readonly, true);
	assert.equal(DEFAULT_ROLES.security.readonly, true);
	assert.equal(DEFAULT_ROLES.qa.thinking, "");
	assert.equal(DEFAULT_ROLES.implement.model, undefined);
});

test("a user role entry overrides only the fields it sets", () => {
	const c = cfg({ roles: { review: { model: "custom/review" } } });
	assert.equal(resolveRole(c, "review").model, "custom/review");
	assert.equal(resolveRole(c, "review").thinking, "low");
	assert.equal(resolveRole(c, "review").readonly, true);
});

test("model resolution: task, role, plan, config", () => {
	const c = cfg();
	const a = plan.tasks[0];
	assert.equal(resolveModel(c, plan, a).model, "plan/model");
	assert.equal(resolveModel(c, plan, { ...a, model: "task/model" }).model, "task/model");
	assert.equal(resolveModel(c, plan, { ...a, role: "qa" }).model, "opencode-go/mimo-v2.6-flash");
	const noPlanModel = { ...plan, model: undefined };
	assert.equal(resolveModel(c, noPlanModel, { ...a, role: "implement" }).model, c.model);
});

test("an empty thinking level passes no thinking", () => {
	const c = cfg();
	assert.equal(resolveModel(c, plan, { ...plan.tasks[0], thinking: "" }).thinking, "");
	assert.equal(resolveModel(c, { ...plan, thinking: undefined }, { ...plan.tasks[0], role: "qa" }).thinking, "");
});

test("pairDefault only fills tasks without a pair line", () => {
	const c = cfg({ pairDefault: "review" });
	applyPairDefault(plan, c);
	assert.equal(plan.tasks[0].pair, "review");
	assert.equal(plan.tasks[0].pairSource, "default");
	assert.equal(plan.tasks[0].pairRounds, 2);
	// A read-only task is skipped.
	const ro = parsePlan("---\nid: x\n---\n## task: a\nfiles: a.ts\nrole: security\nbody\n", "x");
	applyPairDefault(ro, c);
	assert.equal(ro.tasks[0].pair, undefined);
	// Idempotent.
	applyPairDefault(plan, c);
	assert.equal(plan.tasks[0].pairSource, "default");
});

test("pairDefault rejects none, unknown and non-readonly roles", () => {
	assert.match(pairDefaultProblem(cfg({ pairDefault: "none" })), /cannot be "none"/);
	assert.match(pairDefaultProblem(cfg({ pairDefault: "x" })), /unknown role/);
	assert.match(pairDefaultProblem(cfg({ pairDefault: "implement" })), /not read-only/);
	assert.equal(pairDefaultProblem(cfg({ pairDefault: "" })), undefined);
});

test("agent resolution defaults to omp for implement and rejects unknown names", () => {
	const c = cfg();
	// The default implementer runs on oh-my-pi; a role with no `agent` runs on dsh.
	assert.equal(resolveAgent(c, "implement"), "omp");
	assert.equal(resolveAgent(c, "review"), "dsh");
	assert.equal(agentProblem(c, "implement"), undefined);
	assert.equal(agentProblem(cfg({ roles: { implement: { agent: "dsh" } } }), "implement"), undefined);
	assert.match(agentProblem(cfg({ roles: { implement: { agent: "claude-code" } } }), "implement"), /not available/);
});
