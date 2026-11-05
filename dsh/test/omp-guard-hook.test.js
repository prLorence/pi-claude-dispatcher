/**
 * The omp guard adapter is the only thing enforcing the dispatcher's worker
 * policy inside an external child. It runs in the omp process, but the decision
 * logic is plain and worth pinning: a regression here is a silent loss of
 * enforcement, which is exactly how the original hole went unnoticed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import hook from "../plugins/harness-omp-subagent/omp-guard-hook.js";

/** A fake HookAPI that captures the registered handler. */
function capture() {
	let handler;
	const pi = { on: (name, fn) => { if (name === "tool_call") handler = fn; } };
	hook(pi);
	return (event) => handler(event);
}

function withEnv(vars, fn) {
	const saved = {};
	for (const k of Object.keys(vars)) {
		saved[k] = process.env[k];
		if (vars[k] === undefined) delete process.env[k];
		else process.env[k] = vars[k];
	}
	try {
		return fn();
	} finally {
		for (const k of Object.keys(saved)) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	}
}

test("no policy in the environment leaves the run unguarded", async () => {
	const call = capture();
	const decision = await withEnv({ PI_PLAN_DISPATCH_GUARD: undefined }, () =>
		call({ toolName: "write", input: { path: "a.js", content: "x" } }),
	);
	assert.equal(decision, undefined, "a delegation that asked for no guard must not be blocked");
});

test("a read-only policy blocks a write", async () => {
	const call = capture();
	const decision = await withEnv(
		{ PI_PLAN_DISPATCH_GUARD: JSON.stringify({ files: [], bash: true, readonly: true }) },
		() => call({ toolName: "write", input: { path: "a.js", content: "x" } }),
	);
	assert.equal(decision.block, true);
	assert.match(decision.reason, /BLOCKED by harness-dispatch/);
	assert.match(decision.reason, /read-only/);
});

test("a file outside the task's files is blocked", async () => {
	const call = capture();
	const decision = await withEnv(
		{ PI_PLAN_DISPATCH_GUARD: JSON.stringify({ files: ["src/allowed.js"] }) },
		() => call({ toolName: "write", input: { path: "src/other.js", content: "x" } }),
	);
	assert.equal(decision.block, true);
});

test("a file inside the task's files is allowed", async () => {
	const call = capture();
	const decision = await withEnv(
		{ PI_PLAN_DISPATCH_GUARD: JSON.stringify({ files: ["src/allowed.js"] }) },
		() => call({ toolName: "write", input: { path: "src/allowed.js", content: "x" } }),
	);
	assert.equal(decision, undefined);
});

test("an unreadable policy fails closed instead of allowing everything", async () => {
	// omp blocks a tool call when its hook throws, so the only safe reading of a
	// corrupt policy is to refuse. Allowing would downgrade a guarded run.
	const call = capture();
	const decision = await withEnv({ PI_PLAN_DISPATCH_GUARD: "{not json" }, () =>
		call({ toolName: "bash", input: { command: "rm -rf /" } }),
	);
	assert.equal(decision.block, true);
	assert.match(decision.reason, /not valid JSON/);
});

test("a policy that is not an object also fails closed", async () => {
	const call = capture();
	const decision = await withEnv({ PI_PLAN_DISPATCH_GUARD: "[1,2,3]" }, () =>
		call({ toolName: "read", input: { path: "a.js" } }),
	);
	assert.equal(decision.block, true);
});
