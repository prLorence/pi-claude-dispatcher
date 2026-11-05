import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReviewPrompt, feedbackFromFindings, parseReviewReport } from "../plugins/harness-dispatch/review.js";

test("parses a review verdict and bullet findings", () => {
	const report = parseReviewReport("Some prose.\nVERDICT: changes\nFINDINGS:\n- src/a.ts:10: wrong. fix it.\n- src/b.ts:2: also wrong. fix.\n");
	assert.equal(report.verdict, "changes");
	assert.equal(report.findings.length, 2);
	assert.equal(report.findings[0].location, "src/a.ts:10");
	assert.equal(report.findings[0].text, "wrong. fix it.");
});

test("is case-insensitive, tolerant of bold and prose, and accepts none", () => {
	assert.equal(parseReviewReport("**Verdict:** APPROVE\n**Findings:** none").verdict, "approve");
	assert.deepEqual(parseReviewReport("verdict: clean\nfindings: none").findings, []);
	const report = parseReviewReport("blah\nVERDICT: approve\nFINDINGS:\nplain one\nplain two\n");
	assert.equal(report.findings.length, 2);
});

test("security findings keep severity tags", () => {
	const report = parseReviewReport("VERDICT: issues\nFINDINGS:\n- [high] src/a.ts:1: injection. escape it.\n- [medium] src/b.ts:2: weak check.\n");
	assert.equal(report.findings[0].severity, "high");
	assert.equal(report.findings[1].severity, "medium");
});

test("a missing or unknown verdict is unknown", () => {
	assert.equal(parseReviewReport("FINDINGS: none").verdict, "unknown");
	assert.equal(parseReviewReport("VERDICT: lgtm\nFINDINGS: none").verdict, "unknown");
});

test("findings stop at STATUS/TESTS and at a wrapped bullet continuation", () => {
	const report = parseReviewReport("VERDICT: changes\nFINDINGS:\n- one\n  more detail\nSTATUS: done\n- not a finding\n");
	assert.equal(report.findings.length, 1);
	assert.equal(report.findings[0].text, "one more detail");
});

test("buildReviewPrompt includes kind-specific format and role", () => {
	const p = buildReviewPrompt({ kind: "security", planId: "p", context: "ctx", taskId: "t", taskBody: "body", files: ["a.ts"], rolePrompt: "be strict" });
	assert.match(p, /security reviewer/);
	assert.match(p, /VERDICT: clean \| issues/);
	assert.match(p, /be strict/);
});

test("feedbackFromFindings numbers the findings", () => {
	const text = feedbackFromFindings([{ location: "a.ts:1", text: "broken" }], "review");
	assert.match(text, /1\. a\.ts:1: broken/);
	assert.match(feedbackFromFindings([], "review"), /No findings were listed/);
});
