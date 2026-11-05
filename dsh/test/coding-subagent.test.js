import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCodingAgentOptions, createCodingSubagentTool, selectCodingTools, splitModel } from "../plugins/harness-dispatch/coding-subagent.js";

test("splitModel separates the provider route", () => {
	assert.deepEqual(splitModel("opencode-go/deepseek-v4.1-flash"), { provider: "opencode-go", model: "deepseek-v4.1-flash" });
	assert.deepEqual(splitModel("fake-model"), { provider: undefined, model: "fake-model" });
});

test("coding agent options inherit config and honour overrides", () => {
	const cfg = { model: "opencode-go/deepseek-v4.1-flash", thinking: "low" };
	assert.deepEqual(buildCodingAgentOptions(cfg), {
		model: "opencode-go/deepseek-v4.1-flash",
		thinking: "low",
		agentOptions: { provider: "opencode-go", model: "deepseek-v4.1-flash", reasoningEffort: "low" },
	});
	const override = buildCodingAgentOptions(cfg, { model: "fake/model", thinking: "" });
	assert.equal(override.model, "fake/model");
	assert.equal(override.thinking, "");
	assert.deepEqual(override.agentOptions, { provider: "fake", model: "model" });
});

test("tool selection defaults to the coding set and rejects delegation tools", () => {
	assert.deepEqual(selectCodingTools(undefined), ["read", "write", "edit", "bash", "glob", "grep", "todo_write"]);
	assert.deepEqual(selectCodingTools(["read", "edit"]), ["read", "edit"]);
	assert.throws(() => selectCodingTools(["subagent"]), /cannot be granted/);
});

test("the allow list fails closed for a tool nobody enumerated", () => {
	// The bug this replaced: a deny list only knows the delegation tools that
	// existed when it was written, so `subagent_omp` passed the moment it was
	// created. An allow list refuses what it does not recognise.
	assert.throws(() => selectCodingTools(["subagent_omp"]), /cannot be granted/, "a newly created delegation tool must not slip through");
	assert.throws(() => selectCodingTools(["some_future_tool"]), /cannot be granted/);
	assert.throws(() => selectCodingTools(["read", "dispatch_project"]), /cannot be granted/);
	// The refusal names what is allowed, so the caller can recover.
	assert.throws(() => selectCodingTools(["workflow"]), /allowed: read, write, edit, bash, glob, grep, todo_write/);
});

/** A tool wired to a fake subagents service. */
function toolWith({ providers = {}, child = undefined, on = () => () => {} } = {}) {
	const seen = [];
	const ctx = {
		subagents: {
			getProvider: (name) => providers[name],
			startActivation: async (spec) => {
				seen.push(spec);
				return {
					childId: "child-1",
					result: Promise.resolve({ output: [{ type: "text", text: "hi" }], stopReason: "completed", ...(spec.provider === "omp" ? { usage: { input: 7, output: 3, total: 10 } } : {}) }),
					dispose: async () => {},
				};
			},
		},
		agents: { get: () => child },
		on,
	};
	const tool = createCodingSubagentTool({
		ctx,
		cfgOf: () => ({ model: "opencode-go/x", thinking: "low", codingTimeoutMinutes: 20 }),
		root: "/repo",
		rootFor: () => "/repo",
	});
	return { tool, seen };
}

const EXEC = { agent: { id: "root" }, signal: new AbortController().signal };

test("an external backend is bounded by --tools, and the result says so", async () => {
	// ctx.agents has no entry for an external child, so the restrict() step is a
	// no-op there. Reporting enforcedBy stops a reader assuming otherwise.
	const { tool, seen } = toolWith({ providers: { omp: { name: "omp", capabilities: { depthLimit: false } } } });
	const out = await tool.execute({ prompt: "do it", agent: "omp" }, EXEC);
	assert.equal(out.enforcedBy, "cli-tools");
	assert.equal(seen[0].provider, "omp");
	assert.deepEqual(seen[0].request.tools, ["read", "write", "edit", "bash", "glob", "grep", "todo_write"]);
	assert.equal("maxDepth" in seen[0].request, false, "omp does not advertise depthLimit, so asking for it would fail admission");
});

test("an in-process child is bounded by its tool scope", async () => {
	const restrict = [];
	const child = { ctx: { tools: { restrict: async (spec) => { restrict.push(spec); } } } };
	const { tool, seen } = toolWith({ providers: { spawn: { name: "spawn", capabilities: { depthLimit: true } } }, child });
	const out = await tool.execute({ prompt: "do it", tools: ["read", "edit"] }, EXEC);
	assert.equal(out.enforcedBy, "tool-scope");
	assert.deepEqual(restrict, [{ allow: ["read", "edit"] }]);
	assert.equal(seen[0].request.maxDepth, 1);
});

test("usage is reported for both backends in the same shape", async () => {
	const external = toolWith({ providers: { omp: { name: "omp", capabilities: { depthLimit: false } } } });
	const ext = await external.tool.execute({ prompt: "x", agent: "omp" }, EXEC);
	assert.deepEqual(ext.usage, { input: 7, output: 3, total: 10 });
});

test("a timeout is always passed, so a wedged child cannot hold the call open", async () => {
	const { tool, seen } = toolWith({ providers: { omp: { name: "omp", capabilities: { depthLimit: false } } } });
	await tool.execute({ prompt: "x", agent: "omp" }, EXEC);
	assert.equal(seen[0].request.timeoutMs, 20 * 60_000);
});

test("an unregistered backend is refused before any child is started", async () => {
	const { tool, seen } = toolWith({ providers: {} });
	const out = await tool.execute({ prompt: "x", agent: "omp" }, EXEC);
	assert.match(out.error, /no subagent provider named "omp"/);
	assert.equal(seen.length, 0);
});

test("an in-process child's usage is summed from its session events", async () => {
	// The child's result carries no usage for an in-process backend; the only
	// source is the session event stream, which is why this had to be added.
	const restrict = [];
	let emit;
	const child = { ctx: { tools: { restrict: async () => { restrict.push(1); } } } };
	const tool = createCodingSubagentTool({
		ctx: {
			subagents: {
				getProvider: () => ({ name: "spawn", capabilities: { depthLimit: true } }),
				startActivation: async () => {
					// The child emits its messages while the result is in flight.
					const result = (async () => {
						await new Promise((r) => setTimeout(r, 5));
						emit({ type: "assistant/message", data: { usage: { input: 100, output: 20, total: 120 } } });
						emit({ type: "assistant/message", data: { usage: { input: 50, output: 5, total: 55 } } });
						emit({ type: "assistant/message", data: { usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 } } });
						emit({ type: "tool/start", data: {} });
						return { output: [{ type: "text", text: "ok" }], stopReason: "completed" };
					})();
					return { childId: "child-1", result, dispose: async () => {} };
				},
			},
			agents: { get: () => child },
			on: (name, fn) => {
				if (name === "session/event") emit = (event) => fn({ id: "child-1" }, event);
				return () => {};
			},
		},
		cfgOf: () => ({ model: "opencode-go/x", thinking: "low", codingTimeoutMinutes: 20 }),
		root: "/repo",
	});
	const out = await tool.execute({ prompt: "x", tools: ["read"] }, EXEC);
	assert.deepEqual(out.usage, { input: 160, output: 26, total: 186 }, "both usage field spellings must accumulate");
	assert.equal(out.enforcedBy, "tool-scope");
});

test("events from a different session do not leak into the total", async () => {
	let emit;
	const child = { ctx: { tools: { restrict: async () => {} } } };
	const tool = createCodingSubagentTool({
		ctx: {
			subagents: {
				getProvider: () => ({ name: "spawn", capabilities: { depthLimit: true } }),
				startActivation: async () => ({
					childId: "child-1",
					result: (async () => {
						await new Promise((r) => setTimeout(r, 5));
						// Another concurrent child's traffic.
						emit({ id: "someone-else" }, { type: "assistant/message", data: { usage: { input: 999, output: 999, total: 1998 } } });
						emit({ id: "child-1" }, { type: "assistant/message", data: { usage: { input: 4, output: 1, total: 5 } } });
						return { output: [], stopReason: "completed" };
					})(),
					dispose: async () => {},
				}),
			},
			agents: { get: () => child },
			on: (name, fn) => {
				if (name === "session/event") emit = (session, event) => fn(session, event);
				return () => {};
			},
		},
		cfgOf: () => ({ model: "m", thinking: "", codingTimeoutMinutes: 20 }),
		root: "/repo",
	});
	const out = await tool.execute({ prompt: "x", tools: ["read"] }, EXEC);
	assert.deepEqual(out.usage, { input: 4, output: 1, total: 5 });
});
