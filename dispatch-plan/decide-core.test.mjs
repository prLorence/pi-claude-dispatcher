/** Run with: node --test dispatch-plan/decide-core.test.mjs (Node 24+) */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	MAX_REQUESTS,
	aggregate,
	auditRequest,
	parseSpecRequirements,
	proposal,
	realDefectP,
} from "./decide-core.mjs";

test("the request cap is the documented one", () => {
	assert.equal(MAX_REQUESTS, 40);
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
