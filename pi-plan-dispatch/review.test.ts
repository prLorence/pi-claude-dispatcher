/** Run with: cd pi-plan-dispatch && node --test review.test.ts (Node 24+) */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildReviewPrompt,
	feedbackFromFindings,
	parseReviewReport,
	type ReviewFinding,
} from "./review.ts";

test("parseReviewReport: approval with no findings", () => {
	const out = "VERDICT: approve\nFINDINGS: none";
	assert.deepEqual(parseReviewReport(out), { verdict: "approve", findings: [] });
});

test("parseReviewReport: review format with path:line findings", () => {
	const out = [
		"VERDICT: changes",
		"FINDINGS:",
		"- src/core.ts:41: The retry check counts pair re-runs. Compare failed attempts only.",
		"- src/index.ts:12: The reviewer is spawned without a read-only role.",
	].join("\n");
	assert.deepEqual(parseReviewReport(out), {
		verdict: "changes",
		findings: [
			{ location: "src/core.ts:41", text: "The retry check counts pair re-runs. Compare failed attempts only." },
			{ location: "src/index.ts:12", text: "The reviewer is spawned without a read-only role." },
		],
	});
});

test("parseReviewReport: security format keeps severity tags", () => {
	const out = [
		"VERDICT: issues",
		"FINDINGS:",
		"- [high] src/net.ts:88: The URL is passed to fetch unvalidated, so a user can reach internal hosts. Allowlist the host.",
		"- [medium] src/db.ts:5: The query is built by string concatenation. Use parameters.",
		"- [low] src/log.ts:2: The token is logged on failure. Drop it from the message.",
	].join("\n");
	const report = parseReviewReport(out);
	assert.equal(report.verdict, "issues");
	assert.deepEqual(report.findings, [
		{
			severity: "high",
			location: "src/net.ts:88",
			text: "The URL is passed to fetch unvalidated, so a user can reach internal hosts. Allowlist the host.",
		},
		{
			severity: "medium",
			location: "src/db.ts:5",
			text: "The query is built by string concatenation. Use parameters.",
		},
		{
			severity: "low",
			location: "src/log.ts:2",
			text: "The token is logged on failure. Drop it from the message.",
		},
	]);
});

test("parseReviewReport: mixed case, bold markdown and prose around the report", () => {
	const out = [
		"I looked at the diff and ran the tests. Summary follows.",
		"",
		"**verdict:** CHANGES",
		"",
		"**Findings:**",
		"* src/a.ts:7: The early return skips the cleanup. Move it after the loop.",
		"",
		"Let me know if anything is unclear.",
	].join("\n");
	assert.deepEqual(parseReviewReport(out), {
		verdict: "changes",
		findings: [{ location: "src/a.ts:7", text: "The early return skips the cleanup. Move it after the loop." }],
	});
});

test("parseReviewReport: `none` in any case is no findings, including a bullet", () => {
	assert.deepEqual(parseReviewReport("VERDICT: clean\nFINDINGS: NONE"), { verdict: "clean", findings: [] });
	assert.deepEqual(parseReviewReport("VERDICT: clean\nFINDINGS:\n- None."), { verdict: "clean", findings: [] });
});

test("parseReviewReport: a comment bullet after `FINDINGS: none` is not a finding (review format)", () => {
	const out = [
		"VERDICT: approve",
		"FINDINGS: none",
		"- hello.txt:1: content is exactly right. No change needed.",
	].join("\n");
	assert.deepEqual(parseReviewReport(out), { verdict: "approve", findings: [] });
});

test("parseReviewReport: a comment bullet after `FINDINGS: none` is not a finding (security format)", () => {
	const out = [
		"VERDICT: clean",
		"FINDINGS: none",
		"- src/api.ts:3: input is validated, no issue.",
	].join("\n");
	assert.deepEqual(parseReviewReport(out), { verdict: "clean", findings: [] });
});

test("parseReviewReport: a `none` bullet closes the list, and a normal list is unchanged", () => {
	const closed = ["VERDICT: approve", "FINDINGS:", "- None.", "- src/a.ts:1: nothing to do here. Really."].join("\n");
	assert.deepEqual(parseReviewReport(closed), { verdict: "approve", findings: [] });
	const open = ["VERDICT: changes", "FINDINGS:", "- src/a.ts:1: Broken. Fix it.", "- src/b.ts:2: Also broken. Fix it too."].join("\n");
	assert.deepEqual(parseReviewReport(open), {
		verdict: "changes",
		findings: [
			{ location: "src/a.ts:1", text: "Broken. Fix it." },
			{ location: "src/b.ts:2", text: "Also broken. Fix it too." },
		],
	});
});

test("parseReviewReport: a missing verdict is unknown, findings still parsed", () => {
	assert.deepEqual(parseReviewReport(""), { verdict: "unknown", findings: [] });
	assert.deepEqual(parseReviewReport("FINDINGS: none"), { verdict: "unknown", findings: [] });
	const out = "FINDINGS:\n- src/a.ts:1: Broken. Fix it.";
	assert.equal(parseReviewReport(out).verdict, "unknown");
	assert.equal(parseReviewReport(out).findings.length, 1);
});

test("parseReviewReport: a verdict that contradicts its findings keeps both", () => {
	const out = "VERDICT: approve\nFINDINGS:\n- src/a.ts:3: This is actually broken. Fix it.";
	assert.deepEqual(parseReviewReport(out), {
		verdict: "approve",
		findings: [{ location: "src/a.ts:3", text: "This is actually broken. Fix it." }],
	});
});

test("parseReviewReport: unrecognised verdict word is unknown", () => {
	assert.equal(parseReviewReport("VERDICT: maybe\nFINDINGS: none").verdict, "unknown");
});

test("parseReviewReport: findings with and without a location", () => {
	const out = [
		"VERDICT: changes",
		"FINDINGS:",
		"- src/a.ts:10: The guard is never called. Call it before the write.",
		"- The docs still describe the old flag. Update them.",
		"- README.md:40: The command omits --thinking. Add it.",
	].join("\n");
	const { findings } = parseReviewReport(out);
	assert.deepEqual(findings, [
		{ location: "src/a.ts:10", text: "The guard is never called. Call it before the write." },
		{ text: "The docs still describe the old flag. Update them." },
		{ location: "README.md:40", text: "The command omits --thinking. Add it." },
	]);
});

test("parseReviewReport: numbered and plus bullets, and multi-line findings", () => {
	const out = [
		"VERDICT: changes",
		"FINDINGS:",
		"1) [high] src/a.ts:9: SQL is concatenated.",
		"   Use a parameterised query.",
		"+ src/b.ts:2: The timeout is ignored. Pass it through.",
	].join("\n");
	assert.deepEqual(parseReviewReport(out), {
		verdict: "changes",
		findings: [
			{ severity: "high", location: "src/a.ts:9", text: "SQL is concatenated. Use a parameterised query." },
			{ location: "src/b.ts:2", text: "The timeout is ignored. Pass it through." },
		],
	});
});

test("parseReviewReport: stops at a worker report section after the findings", () => {
	const out = [
		"VERDICT: changes",
		"FINDINGS: none",
		"",
		"STATUS: done",
		"NOTES: I changed src/a.ts.",
	].join("\n");
	assert.deepEqual(parseReviewReport(out), { verdict: "changes", findings: [] });
});

test("buildReviewPrompt: review kind carries context, task, files, report and format", () => {
	const prompt = buildReviewPrompt({
		kind: "review",
		planId: "roles-pair-r1",
		context: "Plans name a role instead of a model.",
		taskId: "review-module",
		taskBody: "Write review.ts per the contract.",
		files: ["pi-plan-dispatch/review.ts", "pi-plan-dispatch/review.test.ts"],
		implementerReport: "STATUS: done\nCHANGED: pi-plan-dispatch/review.ts",
		rolePrompt: "You review another engineer's change for one task.",
		round: 2,
	});
	assert.match(prompt, /roles-pair-r1/);
	assert.match(prompt, /review round 2/);
	assert.match(prompt, /Plans name a role instead of a model\./);
	assert.match(prompt, /Write review\.ts per the contract\./);
	assert.match(prompt, /pi-plan-dispatch\/review\.ts, pi-plan-dispatch\/review\.test\.ts/);
	assert.match(prompt, /STATUS: done\nCHANGED: pi-plan-dispatch\/review\.ts/);
	assert.match(prompt, /You review another engineer's change for one task\./);
	assert.match(prompt, /VERDICT: approve \| changes/);
	assert.doesNotMatch(prompt, /VERDICT: clean \| issues/);
	assert.match(prompt, /FINDINGS:/);
});

test("buildReviewPrompt: security kind states the security format and severity tags", () => {
	const prompt = buildReviewPrompt({
		kind: "security",
		planId: "p",
		context: "",
		taskId: "sec",
		taskBody: "Review the new upload path.",
		files: ["src/upload.ts"],
		rolePrompt: "You are a security reviewer.",
	});
	assert.match(prompt, /VERDICT: clean \| issues/);
	assert.match(prompt, /\[high\|medium\|low\] <path>:<line>/);
	assert.doesNotMatch(prompt, /VERDICT: approve \| changes/);
	assert.match(prompt, /Review the new upload path\./);
	assert.match(prompt, /You are a security reviewer\./);
	assert.match(prompt, /Not provided/, "a missing implementer report is stated, not left out");
});

test("feedbackFromFindings: names the reviewer, numbers findings, says fix the cause", () => {
	const findings: ReviewFinding[] = [
		{ location: "src/a.ts:4", text: "The retry count is wrong." },
		{ severity: "low", text: "The comment is stale." },
	];
	const text = feedbackFromFindings(findings, "review (minimax)");
	assert.match(text, /review \(minimax\)/);
	assert.match(text, /1\. src\/a\.ts:4: The retry count is wrong\./);
	assert.match(text, /2\. \[low\] The comment is stale\./);
	assert.match(text, /Fix the cause/);
	assert.match(text, /If a finding is wrong, explain why under NOTES; otherwise fix its cause\./);
	assert.doesNotMatch(text, /Do not argue/);
	assert.ok(text.indexOf("1. ") < text.indexOf("2. "), "findings keep their order");
});

test("feedbackFromFindings: an empty list still asks for a re-check", () => {
	const text = feedbackFromFindings([], "reviewer");
	assert.match(text, /reviewer/);
	assert.match(text, /No findings were listed/);
	assert.match(text, /Fix the cause/);
	assert.doesNotMatch(text, /^1\. /m);
});
