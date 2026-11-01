/** Run with: cd pi-plan-dispatch && node --test decider/effort.test.ts (Node 24+) */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Thresholds } from "./config.ts";
import { LADDER, effortRequest, escalateLevel, suggestEffort } from "./effort.ts";

test("effortRequest sends the task body, its files and its role", () => {
	const task = { id: "core-lib", body: "Write decide-core.mjs", files: ["dispatch-plan/decide-core.mjs"], role: "implement" };
	assert.deepEqual(effortRequest(task), {
		state: { task: "Write decide-core.mjs", files: ["dispatch-plan/decide-core.mjs"], role: "implement" },
		questions: {
			effort: {
				type: "choice",
				instructions: "How much reasoning effort does a coding model need to implement this task correctly?",
				criteria: {
					low: "mechanical or single-step edit, little ambiguity",
					high: "multi-step logic, several interacting rules or edge cases",
					max: "intricate concurrency, security or algorithmic reasoning",
				},
			},
			complexity: {
				type: "score",
				instructions: "How complex is this task?",
				criteria: ["trivial", "simple", "moderate", "complex", "very complex"],
			},
		},
	});
});

test("effortRequest defaults the role to implement and copies the files", () => {
	const task = { id: "t", body: "body", files: ["a.mjs"] };
	const request = effortRequest(task);
	assert.equal(request.state.role, "implement");
	(request.state.files as string[]).push("b.mjs");
	assert.deepEqual(task.files, ["a.mjs"]);
	assert.equal(effortRequest({ id: "t", body: "body", files: [], role: "qa" }).state.role, "qa");
});

test("the effort rule picks max at P(max) 0.40 and not at 0.39", () => {
	const at = suggestEffort({ effort: { probabilities: { low: 0.3, high: 0.3, max: 0.4 }, confidence: 0.9 } });
	assert.equal(at.suggested, "max");
	assert.deepEqual(at.probabilities, { low: 0.3, high: 0.3, max: 0.4 });
	assert.equal(at.confidence, 0.9);
	assert.equal(at.complexity, null);
	const below = suggestEffort({ effort: { probabilities: { low: 0.61, high: 0, max: 0.39 } } });
	assert.equal(below.suggested, "low");
	assert.equal(below.confidence, null);
});

test("with no complexity answer the P(low) fallback picks high at 0.59 and low at 0.60", () => {
	const below = suggestEffort({ effort: { probabilities: { low: 0.59, high: 0.41, max: 0 } } });
	assert.equal(below.suggested, "high");
	assert.equal(below.complexity, null);
	const at = suggestEffort({ effort: { probabilities: { low: 0.6, high: 0.4, max: 0 } } });
	assert.equal(at.suggested, "low");
	const above = suggestEffort({ effort: { probabilities: { low: 0.61, high: 0.39, max: 0 } } });
	assert.equal(above.suggested, "low");
});

test("a complexity score at or above complexityHigh gives high", () => {
	const answers = (score: number) => ({ effort: { probabilities: { low: 0.7, high: 0.2, max: 0.1 } }, complexity: { score } });
	const at = suggestEffort(answers(3));
	assert.equal(at.suggested, "high");
	assert.equal(at.complexity, 3);
	assert.equal(suggestEffort(answers(2.99)).suggested, "low");
	assert.equal(suggestEffort(answers(4)).suggested, "high");
});

test("a low complexity score does not beat max", () => {
	const at = suggestEffort({ effort: { probabilities: { low: 0.3, high: 0.3, max: 0.4 } }, complexity: { score: 1 } });
	assert.equal(at.suggested, "max");
	const below = suggestEffort({ effort: { probabilities: { low: 0, high: 0.61, max: 0.39 } }, complexity: { score: 1 } });
	assert.equal(below.suggested, "low");
});

test("a complexity score that is not a finite number uses the P(low) fallback", () => {
	const below = suggestEffort({
		effort: { probabilities: { low: 0.59, high: 0.41, max: 0 } },
		complexity: { score: Number.NaN },
	});
	assert.equal(below.suggested, "high");
	assert.equal(below.complexity, null);
	const at = suggestEffort({
		effort: { probabilities: { low: 0.6, high: 0.4, max: 0 } },
		complexity: { score: Number.NaN },
	});
	assert.equal(at.suggested, "low");
});

test("a custom complexityHigh moves the cut and a missing one defaults to 3", () => {
	const answers = (score: number) => ({ effort: { probabilities: { low: 0.7, high: 0.2, max: 0.1 } }, complexity: { score } });
	assert.equal(suggestEffort(answers(2.5), { complexityHigh: 2.5 }).suggested, "high");
	assert.equal(suggestEffort(answers(2.49), { complexityHigh: 2.5 }).suggested, "low");
	assert.equal(suggestEffort(answers(2.5), { complexityHigh: 3 }).suggested, "low");
	// A thresholds object without the key must not compare against undefined.
	assert.equal(suggestEffort(answers(3), { effortMax: 0.4 }).suggested, "high");
	assert.equal(suggestEffort(answers(3), {}).suggested, "high");
	assert.equal(
		suggestEffort(answers(2.99), { complexityHigh: "2" } as unknown as Partial<Thresholds>).suggested,
		"low",
	);
});

test("max wins over high when both would fire", () => {
	const result = suggestEffort({ effort: { probabilities: { low: 0.1, high: 0.4, max: 0.5 } } });
	assert.equal(result.suggested, "max");
	const complex = suggestEffort({ effort: { probabilities: { low: 0.1, high: 0.4, max: 0.5 } }, complexity: { score: 4 } });
	assert.equal(complex.suggested, "max");
});

test("a missing option counts as 0", () => {
	const noMax = suggestEffort({ effort: { probabilities: { low: 0.7, high: 0.3 } } });
	assert.equal(noMax.suggested, "low");
	assert.equal(noMax.probabilities.max, 0);
	const noLow = suggestEffort({ effort: { probabilities: { high: 0.9, max: 0.1 } } });
	assert.equal(noLow.suggested, "high");
	assert.equal(noLow.probabilities.low, 0);
});

test("suggestEffort follows the thresholds it is given", () => {
	const thresholds = { effortMax: 0.5, effortLow: 0.3 };
	const low = { effort: { probabilities: { low: 0.25, high: 0.25, max: 0.5 } } };
	assert.equal(suggestEffort(low, thresholds).suggested, "max");
	const high = { effort: { probabilities: { low: 0.29, high: 0.51, max: 0.2 } } };
	assert.equal(suggestEffort(high, thresholds).suggested, "high");
	assert.equal(suggestEffort({ effort: { probabilities: { low: 0.3, high: 0.5, max: 0.2 } } }, thresholds).suggested, "low");
});

test("suggestEffort keeps a complexity score and lets it decide", () => {
	const result = suggestEffort({
		effort: { probabilities: { low: 0.7, high: 0.2, max: 0.1 }, confidence: 0.75 },
		complexity: { score: 2, legend: ["trivial", "simple", "moderate", "complex", "very complex"], confidence: 0.6 },
	});
	assert.equal(result.suggested, "low");
	assert.equal(result.complexity, 2);
	assert.equal(result.confidence, 0.75);
});

test("suggestEffort rejects a malformed answer", () => {
	assert.throws(() => suggestEffort({}), TypeError);
	assert.throws(() => suggestEffort({ effort: {} }), TypeError);
	assert.throws(() => suggestEffort({ effort: { probabilities: null } }), TypeError);
	assert.throws(() => (suggestEffort as (...args: unknown[]) => unknown)(), TypeError);
});

test("LADDER is low, high, max", () => {
	assert.deepEqual([...LADDER], ["low", "high", "max"]);
});

test("escalateLevel moves one step from low to high and two steps to max", () => {
	assert.equal(escalateLevel("low", 1), "high");
	assert.equal(escalateLevel("low", 2), "max");
});

test("escalateLevel keeps max at max for any positive steps", () => {
	assert.equal(escalateLevel("max", 1), "max");
	assert.equal(escalateLevel("max", 5), "max");
	assert.equal(escalateLevel("max", 100), "max");
});

test("escalateLevel caps high plus 5 at max", () => {
	assert.equal(escalateLevel("high", 5), "max");
});

test("escalateLevel leaves a level that is not on the ladder unchanged", () => {
	assert.equal(escalateLevel("", 1), "");
	assert.equal(escalateLevel("medium", 2), "medium");
	assert.equal(escalateLevel("xhigh", 3), "xhigh");
});

test("escalateLevel changes nothing for zero or negative steps", () => {
	assert.equal(escalateLevel("low", 0), "low");
	assert.equal(escalateLevel("low", -1), "low");
	assert.equal(escalateLevel("high", 0), "high");
});
