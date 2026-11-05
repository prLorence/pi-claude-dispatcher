/**
 * The worker runner used to hardcode `provider: "spawn"` for dsh and shell out
 * to the `omp` binary for omp, so the managed seam only ever saw one backend.
 * These pin the routing that replaced it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorkerRunner } from "../plugins/harness-dispatch/worker.js";

const PLAN = { id: "p1", tasks: [] };
const TASK = { id: "t1", role: "implement", files: ["a.js"], attempts: 0 };

function cfgWith(roleAgent, extra = {}) {
	return {
		roles: { implement: { agent: roleAgent, model: "opencode-go/deepseek-v4.1-flash" } },
		model: "opencode-go/deepseek-v4.1-flash",
		thinking: "low",
		stallMinutes: 10,
		timeoutMinutes: 30,
		tools: ["read", "write"],
		workerGuards: true,
		dryRun: true,
		...extra,
	};
}

/** A subagents service that records the provider each activation names. */
function fakeSubagents({ providers = [], result = { output: [{ type: "text", text: "done" }], stopReason: "completed" } } = {}) {
	const seen = [];
	return {
		seen,
		getProvider: (name) => (providers.includes(name) ? { name, capabilities: { depthLimit: name === "spawn" } } : undefined),
		startActivation: async (spec) => {
			seen.push({ provider: spec.provider, request: spec.request });
			return {
				childId: "child-1",
				result: Promise.resolve(result),
				dispose: async () => {},
			};
		},
	};
}

function runnerWith(subagents) {
	return createWorkerRunner({
		ctx: { subagents, agents: { roots: () => [{ id: "root" }], get: () => undefined }, on: () => () => {}, tools: { get: () => undefined } },
		root: "/repo",
		cfgOf: () => cfgWith("omp"),
		active: new Map(),
		log: () => {},
	});
}

test("an omp role uses the managed omp provider when it is registered", async () => {
	const subagents = fakeSubagents({ providers: ["omp", "spawn"] });
	const runner = runnerWith(subagents);
	await runner({ cfg: cfgWith("omp"), plan: PLAN, task: TASK, prompt: "do it", cwd: "/repo", parent: { id: "root" }, signal: new AbortController().signal });
	assert.equal(subagents.seen.length, 1);
	assert.equal(subagents.seen[0].provider, "omp", "omp must not be shelled out to directly when the provider exists");
});

test("a dsh role uses the spawn provider", async () => {
	const subagents = fakeSubagents({ providers: ["omp", "spawn"] });
	const runner = runnerWith(subagents);
	await runner({ cfg: cfgWith("dsh"), plan: PLAN, task: TASK, prompt: "do it", cwd: "/repo", parent: { id: "root" }, signal: new AbortController().signal });
	assert.equal(subagents.seen[0].provider, "spawn");
});

test("the managed request carries per-run tools, readonly and progress", async () => {
	const subagents = fakeSubagents({ providers: ["omp", "spawn"] });
	const runner = runnerWith(subagents);
	await runner({
		cfg: cfgWith("omp"),
		plan: PLAN,
		task: { ...TASK, role: "pair-omp-contributor" },
		prompt: "review",
		cwd: "/repo",
		parent: { id: "root" },
		signal: new AbortController().signal,
	});
	const req = subagents.seen[0].request;
	assert.deepEqual(req.tools, ["read", "write"], "the role's tool set must reach the provider");
	assert.equal(typeof req.onProgress, "function", "the provider needs a liveness hook for the stall detector");
	assert.equal(req.readonly, false, "this role is not readonly");
});

test("an external result's usage is reported even with no session events", async () => {
	const subagents = fakeSubagents({
		providers: ["omp"],
		result: { output: [{ type: "text", text: "ok" }], stopReason: "completed", usage: { input: 10, output: 5, total: 15, cost: 0.25 } },
	});
	const runner = runnerWith(subagents);
	const out = await runner({ cfg: cfgWith("omp"), plan: PLAN, task: TASK, prompt: "x", cwd: "/repo", parent: { id: "root" }, signal: new AbortController().signal });
	assert.deepEqual(out.tokens, { input: 10, output: 5, total: 15 }, "token accounting must survive the process boundary");
	assert.equal(out.ok, true);
	assert.equal(out.output, "ok");
});

test("maxDepth is omitted for a provider without the depthLimit capability", async () => {
	// The seam throws UNSUPPORTED_CAPABILITY for maxDepth on a provider that
	// does not advertise depthLimit, and omp does not. Sending it would fail
	// every omp task at admission.
	const subagents = fakeSubagents({ providers: ["omp", "spawn"] });
	const runner = runnerWith(subagents);
	await runner({ cfg: cfgWith("omp"), plan: PLAN, task: TASK, prompt: "x", cwd: "/repo", parent: { id: "root" }, signal: new AbortController().signal });
	assert.equal("maxDepth" in subagents.seen[0].request, false, "an omp request must not carry maxDepth");
});

test("maxDepth is still requested for an in-process provider", async () => {
	const subagents = fakeSubagents({ providers: ["omp", "spawn"] });
	const runner = runnerWith(subagents);
	await runner({ cfg: cfgWith("dsh"), plan: PLAN, task: TASK, prompt: "x", cwd: "/repo", parent: { id: "root" }, signal: new AbortController().signal });
	assert.equal(subagents.seen[0].request.maxDepth, 1, "spawn keeps the recursion guard");
});
