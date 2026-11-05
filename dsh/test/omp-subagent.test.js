import { test } from "node:test";
import assert from "node:assert/strict";
import { createOmpProvider, foldOmpLine, ompArgs } from "../plugins/harness-omp-subagent/index.js";

/** One assistant message_end line, as omp emits it. */
function messageEnd(text, usage) {
	return JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], usage } });
}

test("ompArgs gives a reviewer read tools and a coder the whole tool set", () => {
	const reviewer = ompArgs({ model: "m", thinking: "low", readonly: true, prompt: "p" });
	assert.deepEqual(reviewer.slice(-2), ["read,grep,glob", "p"]);
	const coder = ompArgs({ model: "m", thinking: "low", prompt: "p" });
	assert.equal(coder.includes("--tools"), false, "a coder keeps omp's default tool set");
	assert.deepEqual(coder.slice(-1), ["p"]);
	assert.equal(ompArgs({ model: "m", tools: ["read"], prompt: "p" })[7], "read");
});

test("foldOmpLine takes text from message_end and does not double it on turn_end", () => {
	const state = { text: "", tools: [], errors: [] };
	foldOmpLine(state, messageEnd("hello"));
	// turn_end repeats the same message; it must not append a second copy.
	foldOmpLine(state, JSON.stringify({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } }));
	assert.equal(state.text, "hello");
});

test("foldOmpLine keeps several assistant messages and ignores junk", () => {
	const state = { text: "", tools: [], errors: [] };
	foldOmpLine(state, messageEnd("first"));
	foldOmpLine(state, "not json at all");
	foldOmpLine(state, "");
	foldOmpLine(state, messageEnd("second"));
	assert.equal(state.text, "first\nsecond");
});

test("foldOmpLine records tool names and errors", () => {
	const state = { text: "", tools: [], errors: [] };
	foldOmpLine(state, JSON.stringify({ type: "tool_execution_start", toolName: "read" }));
	foldOmpLine(state, JSON.stringify({ type: "tool_execution_start", toolName: "grep" }));
	assert.deepEqual(state.tools, ["read", "grep"]);
	foldOmpLine(state, JSON.stringify({ type: "error", message: "boom" }));
	assert.deepEqual(state.errors, ["boom"]);
});

test("the provider advertises the external shape and no fake capabilities", () => {
	const p = createOmpProvider({ command: "omp" });
	assert.equal(p.name, "omp");
	assert.equal(typeof p.start, "function");
	assert.equal(p.prepareContinuable, undefined, "an external child is one-shot");
	assert.equal(p.inheritsParentContext, false);
	assert.deepEqual(p.capabilities, {
		agentOptions: false,
		agentPreset: false,
		outputSchema: false,
		depthLimit: false,
	});
});

test("a failed spawn settles as error instead of throwing", async () => {
	const p = createOmpProvider({ command: "definitely-not-a-real-binary-xyz", timeoutMs: 5000 });
	const run = await p.start({ prompt: "hi", cwd: "/tmp" });
	const result = await run.result;
	assert.equal(result.stopReason, "error");
	assert.match(result.diagnostic, /omp (failed to start|spawn failed)/);
	await run.dispose();
});

test("the run handle exposes id, result and an idempotent dispose", async () => {
	const p = createOmpProvider({ command: "definitely-not-a-real-binary-xyz", timeoutMs: 5000 });
	const run = await p.start({ prompt: "hi", cwd: "/tmp" });
	assert.equal(typeof run.id, "string");
	assert.ok(run.result instanceof Promise);
	await run.dispose();
	await run.dispose();
	await run.result;
});

test("dispose before the spawn settles must not block the event loop", async () => {
	// kill() on a handle whose spawn has not settled (pid undefined, exitCode
	// null) blocks forever instead of returning false. This test hangs if the
	// provider regresses to guarding on exitCode alone.
	const p = createOmpProvider({ command: "definitely-not-a-real-binary-xyz", timeoutMs: 30_000 });
	const run = await p.start({ prompt: "hi", cwd: "/tmp" });
	const settled = await Promise.race([
		run.dispose().then(() => "disposed"),
		new Promise((resolve) => setTimeout(() => resolve("blocked"), 4000)),
	]);
	assert.equal(settled, "disposed", "dispose returned without wedging the loop");
	const result = await run.result;
	assert.equal(result.stopReason, "aborted");
});

test("a settled run removes its abort listener from a shared signal", async () => {
	// The parent's signal outlives the child. A listener left behind pins this
	// run's closure and child handle for every future run on the same signal.
	const controller = new AbortController();
	let added = 0;
	let removed = 0;
	const add = controller.signal.addEventListener.bind(controller.signal);
	const remove = controller.signal.removeEventListener.bind(controller.signal);
	controller.signal.addEventListener = (type, fn, opts) => {
		if (type === "abort") added += 1;
		return add(type, fn, opts);
	};
	controller.signal.removeEventListener = (type, fn, opts) => {
		if (type === "abort") removed += 1;
		return remove(type, fn, opts);
	};

	const p = createOmpProvider({ command: "definitely-not-a-real-binary-xyz", timeoutMs: 5000 });
	const run = await p.start({ prompt: "hi", cwd: "/tmp", signal: controller.signal });
	await run.result;
	await run.dispose();
	assert.equal(added, 1);
	assert.equal(removed, 1, "the abort listener was removed when the run settled");
});
