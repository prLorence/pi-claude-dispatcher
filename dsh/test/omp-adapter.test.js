import { test } from "node:test";
import assert from "node:assert/strict";
import { ompAdapter } from "../plugins/harness-dispatch/adapters/omp.js";
import { DEFAULT_ROLES, agentProblem, knownAgents, pairDefaultProblem } from "../plugins/harness-dispatch/roles.js";

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

test("an omp coding role exists and is writable, so omp can pair with itself", () => {
	const coder = DEFAULT_ROLES["implement-omp"];
	assert.equal(coder.agent, "omp");
	assert.equal(coder.readonly, undefined, "a coder is not read-only");
	assert.equal(coder.model, "opencode-go/beam-free");
	assert.match(coder.prompt, /implement exactly one task/);
});

test("the contributor reviewer is read-only and cannot be used as a coder", () => {
	const reviewer = DEFAULT_ROLES["pair-omp-contributor"];
	assert.equal(reviewer.agent, "omp");
	assert.equal(reviewer.readonly, true);
	assert.equal(reviewer.model, "opencode-go/muse-spark-1.3-contributor");
	assert.equal(pairDefaultProblem({ pairDefault: "pair-omp-contributor" }), undefined);
	assert.match(pairDefaultProblem({ pairDefault: "implement-omp" }), /not read-only/);
});

test("every omp role resolves to a known agent", () => {
	for (const [name, role] of Object.entries(DEFAULT_ROLES)) {
		assert.equal(agentProblem({}, name), undefined, `${name} names a known agent`);
		if (role.agent === "omp") assert.ok(knownAgents().includes("omp"));
	}
});
