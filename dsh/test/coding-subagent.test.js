import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCodingAgentOptions, selectCodingTools, splitModel } from "../plugins/harness-dispatch/coding-subagent.js";

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
