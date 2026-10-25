/** Run with: node --test dispatch-plan/decide-core.test.mjs (Node 24+) */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DEFAULTS,
	MAX_REQUESTS,
	aggregate,
	auditRequest,
	effortRequest,
	loadDeciderConfig,
	parseSpecRequirements,
	proposal,
	realDefectP,
	suggestEffort,
} from "./decide-core.mjs";

const CONFIG = {
	effort: "apply",
	audit: "shadow",
	model: "other/decider-1",
	timeoutMs: 1000,
	thresholds: { effortMax: 0.5, effortLow: 0.7, complexityHigh: 3.5, approve: 0.6, dismiss: 0.05, minorWeight: 0.3 },
};

test("the defaults are the documented ones", () => {
	assert.deepEqual(DEFAULTS, {
		effort: "off",
		audit: "off",
		model: "perplexity/pplx-decider-flash-v1.2",
		timeoutMs: 30000,
		thresholds: { effortMax: 0.4, effortLow: 0.6, complexityHigh: 3, approve: 0.5, dismiss: 0.1, minorWeight: 0.2 },
	});
	assert.equal(MAX_REQUESTS, 40);
});

test("a full config is kept as it is", () => {
	assert.deepEqual(loadDeciderConfig(CONFIG), CONFIG);
});

test("a missing or non-object value gives a fresh copy of the defaults", () => {
	for (const raw of [undefined, null, "apply", 42, [], true]) {
		assert.deepEqual(loadDeciderConfig(raw), DEFAULTS);
	}
	const first = loadDeciderConfig();
	const second = loadDeciderConfig();
	assert.notEqual(first, second);
	assert.notEqual(first, DEFAULTS);
	assert.notEqual(first.thresholds, second.thresholds);
	first.effort = "apply";
	first.thresholds.effortMax = 0.99;
	assert.equal(second.effort, "off");
	assert.equal(second.thresholds.effortMax, 0.4);
	assert.equal(DEFAULTS.thresholds.effortMax, 0.4);
});

test("an unknown mode becomes off", () => {
	assert.equal(loadDeciderConfig({ effort: "on", audit: "auto" }).effort, "off");
	assert.equal(loadDeciderConfig({ effort: "on", audit: "auto" }).audit, "off");
	assert.equal(loadDeciderConfig({ effort: "off", audit: "off" }).effort, "off");
	assert.equal(loadDeciderConfig({ effort: "APPLY" }).effort, "off");
});

test("apply and shadow are kept", () => {
	const config = loadDeciderConfig({ effort: "apply", audit: "shadow" });
	assert.equal(config.effort, "apply");
	assert.equal(config.audit, "shadow");
});

test("an invalid model falls back", () => {
	assert.equal(loadDeciderConfig({ model: "" }).model, DEFAULTS.model);
	assert.equal(loadDeciderConfig({ model: "   " }).model, DEFAULTS.model);
	assert.equal(loadDeciderConfig({ model: 7 }).model, DEFAULTS.model);
	assert.equal(loadDeciderConfig({ model: null }).model, DEFAULTS.model);
});

test("an invalid timeout falls back", () => {
	for (const timeoutMs of [0, -1, 1.5, "30000", null, Number.NaN, Number.POSITIVE_INFINITY]) {
		assert.equal(loadDeciderConfig({ timeoutMs }).timeoutMs, DEFAULTS.timeoutMs, `timeoutMs ${String(timeoutMs)}`);
	}
	assert.equal(loadDeciderConfig({ timeoutMs: 5000 }).timeoutMs, 5000);
});

test("an invalid threshold falls back to its own default", () => {
	const cases = [
		["effortMax", 1.01],
		["effortLow", -0.1],
		["approve", "0.5"],
		["dismiss", Number.NaN],
		["minorWeight", null],
	];
	for (const [key, value] of cases) {
		const config = loadDeciderConfig({ thresholds: { [key]: value } });
		assert.equal(config.thresholds[key], DEFAULTS.thresholds[key], `${key} ${String(value)}`);
	}
});

test("a threshold at the edges of the range is kept", () => {
	const config = loadDeciderConfig({ thresholds: { effortMax: 0, effortLow: 1, approve: 1, dismiss: 0, minorWeight: 1 } });
	assert.deepEqual(config.thresholds, { effortMax: 0, effortLow: 1, complexityHigh: 3, approve: 1, dismiss: 0, minorWeight: 1 });
});

test("complexityHigh is a number in 0 to 4 and falls back to 3", () => {
	assert.equal(loadDeciderConfig({ thresholds: { complexityHigh: 4 } }).thresholds.complexityHigh, 4);
	assert.equal(loadDeciderConfig({ thresholds: { complexityHigh: 0 } }).thresholds.complexityHigh, 0);
	for (const complexityHigh of [4.01, -1, Number.NaN, "3", null]) {
		assert.equal(
			loadDeciderConfig({ thresholds: { complexityHigh } }).thresholds.complexityHigh,
			DEFAULTS.thresholds.complexityHigh,
			complexityHigh,
		);
	}
	assert.equal(loadDeciderConfig({ thresholds: {} }).thresholds.complexityHigh, 3);
	assert.equal(loadDeciderConfig({}).thresholds.complexityHigh, 3);
});

test("a partial thresholds object keeps the other defaults", () => {
	const config = loadDeciderConfig({ thresholds: { approve: 0.2 } });
	assert.deepEqual(config.thresholds, { ...DEFAULTS.thresholds, approve: 0.2 });
	assert.deepEqual(loadDeciderConfig({ thresholds: "junk" }).thresholds, DEFAULTS.thresholds);
	assert.deepEqual(loadDeciderConfig({ thresholds: [] }).thresholds, DEFAULTS.thresholds);
});

test("unknown keys are ignored", () => {
	const config = loadDeciderConfig({ effort: "apply", extra: true, thresholds: { approve: 0.3, other: 5 } });
	assert.deepEqual(Object.keys(config).sort(), ["audit", "effort", "model", "thresholds", "timeoutMs"]);
	assert.deepEqual(Object.keys(config.thresholds).sort(), [
		"approve",
		"complexityHigh",
		"dismiss",
		"effortLow",
		"effortMax",
		"minorWeight",
	]);
});

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
	request.state.files.push("b.mjs");
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
	const answers = (score) => ({ effort: { probabilities: { low: 0.7, high: 0.2, max: 0.1 } }, complexity: { score } });
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
	const answers = (score) => ({ effort: { probabilities: { low: 0.7, high: 0.2, max: 0.1 } }, complexity: { score } });
	assert.equal(suggestEffort(answers(2.5), { complexityHigh: 2.5 }).suggested, "high");
	assert.equal(suggestEffort(answers(2.49), { complexityHigh: 2.5 }).suggested, "low");
	assert.equal(suggestEffort(answers(2.5), { complexityHigh: 3 }).suggested, "low");
	// A thresholds object without the key must not compare against undefined.
	assert.equal(suggestEffort(answers(3), { effortMax: 0.4 }).suggested, "high");
	assert.equal(suggestEffort(answers(3), {}).suggested, "high");
	assert.equal(suggestEffort(answers(2.99), { complexityHigh: "2" }).suggested, "low");
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

test("suggestEffort follows the thresholds it is given", () => {
	const thresholds = { effortMax: 0.5, effortLow: 0.3 };
	const low = { effort: { probabilities: { low: 0.25, high: 0.25, max: 0.5 } } };
	assert.equal(suggestEffort(low, thresholds).suggested, "max");
	const high = { effort: { probabilities: { low: 0.29, high: 0.51, max: 0.2 } } };
	assert.equal(suggestEffort(high, thresholds).suggested, "high");
	assert.equal(suggestEffort({ effort: { probabilities: { low: 0.3, high: 0.5, max: 0.2 } } }, thresholds).suggested, "low");
});

test("suggestEffort rejects a malformed answer", () => {
	assert.throws(() => suggestEffort({}), TypeError);
	assert.throws(() => suggestEffort({ effort: {} }), TypeError);
	assert.throws(() => suggestEffort({ effort: { probabilities: null } }), TypeError);
	assert.throws(() => suggestEffort(), TypeError);
});

test("auditRequest sends the finding, the named tasks and requirements and the plan context", () => {
	const finding = {
		id: "f1",
		severity: "major",
		text: "Task b edits a file another task owns",
		tasks: ["a", "b", "missing"],
		reqs: ["R6", "R99"],
	};
	const ctx = {
		tasks: { a: "Task a body", b: "Task b body" },
		reqs: { R6: "- R6. effort command." },
		planContext: "Shared plan context",
	};
	assert.deepEqual(auditRequest(finding, ctx), {
		state: {
			finding: "Task b edits a file another task owns",
			severity: "major",
			tasks: { a: "Task a body", b: "Task b body" },
			requirements: { R6: "- R6. effort command." },
			plan_context: "Shared plan context",
		},
		questions: {
			real_defect: {
				type: "noul",
				instructions:
					"Is this finding a real defect in the current plan text that would make the plan fail, produce wrong results or break a rule?",
				criteria: { false: "wording, style or already handled", true: "a real defect that must be fixed" },
			},
		},
	});
});

test("auditRequest cuts a task body to 8000 and the plan context to 6000 characters", () => {
	const body = "x".repeat(8100);
	const planContext = "y".repeat(6100);
	const request = auditRequest(
		{ id: "f", severity: "blocker", text: "text", tasks: ["a"] },
		{ tasks: { a: body }, reqs: {}, planContext },
	);
	assert.equal(request.state.tasks.a.length, 8000);
	assert.equal(request.state.plan_context.length, 6000);
	assert.ok(request.state.tasks.a.startsWith("x"));
	assert.ok(request.state.plan_context.startsWith("y"));
	assert.equal(auditRequest({ id: "f", severity: "minor", text: "t" }, { tasks: {}, reqs: {} }).state.plan_context, "");
});

test("auditRequest drops a task or requirement the ctx does not have", () => {
	const request = auditRequest(
		{ id: "f", severity: "minor", text: "text", tasks: ["missing"], reqs: ["R99"] },
		{ tasks: { a: "body" }, reqs: { R1: "- R1. line." } },
	);
	assert.deepEqual(request.state.tasks, {});
	assert.deepEqual(request.state.requirements, {});
	assert.equal(request.state.finding, "text");
	assert.equal(request.state.severity, "minor");
});

test("realDefectP returns the noul answer", () => {
	assert.equal(realDefectP({ real_defect: { type: "noul", noul: 0.885 } }), 0.885);
	assert.equal(realDefectP({ real_defect: { noul: 0 } }), 0);
	assert.equal(realDefectP({ real_defect: { noul: 1 } }), 1);
});

test("realDefectP rejects anything that is not a probability", () => {
	assert.throws(() => realDefectP({}), TypeError);
	assert.throws(() => realDefectP({ real_defect: {} }), TypeError);
	assert.throws(() => realDefectP({ real_defect: { noul: "0.5" } }), TypeError);
	assert.throws(() => realDefectP({ real_defect: { noul: 1.2 } }), TypeError);
	assert.throws(() => realDefectP({ real_defect: { noul: -0.1 } }), TypeError);
	assert.throws(() => realDefectP({ real_defect: { noul: Number.NaN } }), TypeError);
});

test("aggregate is 0 with no findings", () => {
	assert.equal(aggregate([]), 0);
	assert.equal(aggregate(), 0);
});

test("one blocker at 0.95 plus nine minors at 0.05 is about 0.96", () => {
	const findings = [
		{ severity: "blocker", p: 0.95 },
		...Array.from({ length: 9 }, () => ({ severity: "minor", p: 0.05 })),
	];
	// 1 - 0.05 * (1 - 0.2 * 0.05)^9 = 1 - 0.05 * 0.99^9 = 0.9543.
	const value = aggregate(findings);
	assert.ok(Math.abs(value - 0.9543) < 1e-4, `aggregate ${value}`);
	assert.ok(Math.abs(value - 0.96) < 0.01);
});

test("a minor counts with minorWeight and a blocker and major count fully", () => {
	assert.ok(Math.abs(aggregate([{ severity: "minor", p: 0.5 }]) - 0.1) < 1e-12);
	assert.ok(Math.abs(aggregate([{ severity: "blocker", p: 0.5 }]) - 0.5) < 1e-12);
	assert.ok(Math.abs(aggregate([{ severity: "major", p: 0.5 }]) - 0.5) < 1e-12);
	const withWeightOne = aggregate([{ severity: "minor", p: 0.5 }], { minorWeight: 1 });
	assert.ok(Math.abs(withWeightOne - 0.5) < 1e-12);
});

test("aggregate handles p 0 and p 1", () => {
	assert.equal(aggregate([{ severity: "blocker", p: 0 }]), 0);
	assert.equal(aggregate([{ severity: "minor", p: 0 }]), 0);
	assert.equal(aggregate([{ severity: "blocker", p: 1 }]), 1);
	assert.ok(Math.abs(aggregate([{ severity: "minor", p: 1 }]) - 0.2) < 1e-12);
});

test("a pass approves below 0.50 and holds at 0.50", () => {
	assert.equal(proposal("pass", [], 0.49), "approve");
	assert.equal(proposal("pass", [], 0.5), "hold");
	assert.equal(proposal("pass", [], 0.51), "hold");
	assert.equal(proposal("pass", [], 0), "approve");
});

test("a pass follows the approve threshold it is given", () => {
	assert.equal(proposal("pass", [], 0.4, { approve: 0.3 }), "hold");
	assert.equal(proposal("pass", [], 0.4, { approve: 0.6 }), "approve");
});

test("a fail dismisses when every blocker and major is below 0.10", () => {
	assert.equal(proposal("fail", [{ severity: "blocker", p: 0.05 }, { severity: "major", p: 0.02 }], 0.06), "dismiss");
	assert.equal(proposal("fail", [{ severity: "blocker", p: 0.1 }], 0.1), "fix");
	assert.equal(proposal("fail", [{ severity: "blocker", p: 0.05 }, { severity: "major", p: 0.3 }], 0.33), "fix");
});

test("a fail with only minors fixes", () => {
	assert.equal(proposal("fail", [{ severity: "minor", p: 0 }], 0), "fix");
	assert.equal(proposal("fail", [], 0), "fix");
});

test("proposal rejects an unknown verdict", () => {
	assert.throws(() => proposal("maybe", [], 0), RangeError);
	assert.throws(() => proposal(undefined, [], 0), RangeError);
	assert.throws(() => proposal("PASS", [], 0), RangeError);
});

test("parseSpecRequirements finds every requirement line", () => {
	const spec = [
		"# Spec",
		"",
		"## Requirements",
		"- R1. CLI and layout. It is one file.",
		"- R12. Stats. Reads traces only.   ",
		"- R3. A line that continues",
		"  over two lines.",
		"  - R2. Indented, so not a requirement.",
		"- not a requirement",
		"- R4 without a dot is not a requirement",
		"",
	].join("\n");
	assert.deepEqual(parseSpecRequirements(spec), {
		R1: "- R1. CLI and layout. It is one file.",
		R12: "- R12. Stats. Reads traces only.",
		R3: "- R3. A line that continues",
	});
});

test("parseSpecRequirements copes with an empty or missing text", () => {
	assert.deepEqual(parseSpecRequirements(""), {});
	assert.deepEqual(parseSpecRequirements(undefined), {});
});
