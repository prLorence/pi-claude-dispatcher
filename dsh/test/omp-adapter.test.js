import { test } from "node:test";
import assert from "node:assert/strict";
import { ompAdapter } from "../plugins/harness-dispatch/adapters/omp.js";
import { DEFAULT_ROLES } from "../plugins/harness-dispatch/roles.js";

test("omp review runs one-shot with the beam-free model and a read-only tool set", () => {
	const args = ompAdapter.workerArgs({
		model: "opencode-go/beam-free",
		thinking: "low",
		tools: [],
		readonly: true,
		prompt: "review this",
	});
	assert.deepEqual(args, [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--model",
		"opencode-go/beam-free",
		"--thinking",
		"low",
		"--tools",
		"read,grep,glob",
		"review this",
	]);
});

test("omp parses its JSON message_end like pi", () => {
	const events = ompAdapter.parseLine(
		JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "VERDICT: approve" }],
				usage: { input: 3, output: 2, totalTokens: 5, cost: { total: 0.01 } },
				stopReason: "stop",
			},
		}),
	);
	assert.equal(events[0].kind, "assistant_end");
	assert.equal(events[0].text, "VERDICT: approve");
	assert.equal(events[0].usage.input, 3);
	assert.equal(events[0].usage.total, 5);
});

test("the pair-omp role is read-only and uses beam-free", () => {
	assert.equal(DEFAULT_ROLES["pair-omp"].agent, "omp");
	assert.equal(DEFAULT_ROLES["pair-omp"].model, "opencode-go/beam-free");
	assert.equal(DEFAULT_ROLES["pair-omp"].readonly, true);
});
