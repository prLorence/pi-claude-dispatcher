import { test } from "node:test";
import assert from "node:assert/strict";
import {
	CONTINUE_PROMPT,
	OutageGate,
	StallTracker,
	backoffSeconds,
	classifyError,
	probeUrls,
	runWithResume,
} from "../plugins/harness-dispatch/resilience.js";

test("classifies transient provider and network errors", () => {
	for (const text of [
		"fetch failed",
		"ECONNRESET",
		"429: rate limited",
		"stream ended without finish_reason",
		"stalled: no output",
		"terminated",
		"socket hang up",
	]) {
		assert.equal(classifyError(text), "transient", text);
	}
});

test("permanent markers win, and aborted is permanent only as the whole text", () => {
	for (const text of ["verification failed", "STATUS: failed", "No API key found", "timed out after 20 min", "aborted", "stop reason: aborted"]) {
		assert.equal(classifyError(text), "permanent", text);
	}
	assert.equal(classifyError("ECONNABORTED"), "transient");
	assert.equal(classifyError(""), "permanent");
});

test("a stack position like index.ts:502:7 does not look like an HTTP status", () => {
	assert.equal(classifyError("Error at index.ts:502:7"), "permanent");
	assert.equal(classifyError("502"), "transient");
});

test("backoff repeats the last step and falls back safely", () => {
	assert.equal(backoffSeconds([1, 2, 3], 1), 1);
	assert.equal(backoffSeconds([1, 2, 3], 2), 2);
	assert.equal(backoffSeconds([1, 2, 3], 9), 3);
	assert.equal(backoffSeconds([], 1), 15);
	assert.equal(backoffSeconds([0, -1], 1), 15);
});

test("probeUrls succeeds when any URL answers and fails when none does", async () => {
	assert.equal(await probeUrls(["http://a", "http://b"], 100, async () => ({})), true);
	assert.equal(await probeUrls(["http://a", "http://b"], 100, async () => { throw new Error("x"); }), false);
	assert.equal(await probeUrls([], 100, async () => ({})), false);
});

test("outage gate opens, probes, closes and reports", async () => {
	let now = 0;
	let healthy = false;
	const starts = [];
	const ends = [];
	const gate = new OutageGate({
		pauseMs: 10_000,
		probeMs: 1,
		probe: async () => healthy,
		now: () => now,
		sleep: async (ms) => {
			now += ms;
		},
		onStart: (r) => starts.push(r),
		onEnd: (d, o) => ends.push([d, o]),
	});
	gate.report("fetch failed");
	assert.equal(gate.open, true);
	assert.deepEqual(starts, ["fetch failed"]);
	const wait = gate.wait();
	healthy = true;
	now += 1;
	assert.equal(await wait, "clear");
	assert.equal(gate.open, false);
	assert.deepEqual(ends[0][1], "healthy");
});

test("outage gate gives up after the pause", async () => {
	let now = 0;
	const gate = new OutageGate({
		pauseMs: 100,
		probeMs: 10,
		probe: async () => false,
		now: () => now,
		sleep: async (ms) => {
			now += ms;
		},
	});
	gate.report("down");
	assert.equal(await gate.wait(), "gave-up");
});

test("stall tracker ignores a tool in flight", () => {
	let now = 0;
	const tracker = new StallTracker({ stallMs: 1000, now: () => now });
	now = 2000;
	assert.equal(tracker.stalled(), true);
	tracker.toolStart("t1");
	now = 5000;
	assert.equal(tracker.stalled(), false);
	tracker.toolEnd("t1");
	now = 7000;
	assert.equal(tracker.stalled(), true);
});

test("runWithResume backs off, reopens the session and sums cost", async () => {
	const calls = [];
	let now = 0;
	const gate = new OutageGate({
		pauseMs: 10_000,
		probeMs: 1,
		probe: async () => true,
		now: () => now,
		sleep: async (ms) => {
			now += ms;
		},
	});
	const result = await runWithResume({
		run: async (info) => {
			calls.push(info);
			if (calls.length === 1) return { ok: false, error: "ECONNRESET", cost: 1, tokens: { input: 1, output: 2, total: 3 }, session: { id: "s" } };
			return { ok: true, cost: 2, tokens: { input: 3, output: 4, total: 7 }, session: { id: "s" } };
		},
		hasSession: (r) => Boolean(r.session),
		gate,
		maxResumes: 3,
		backoff: [1],
		signal: new AbortController().signal,
		sleep: async (ms) => {
			now += ms;
		},
	});
	assert.equal(result.ok, true);
	assert.equal(result.resumes, 1);
	assert.equal(result.cost, 3);
	assert.deepEqual(result.tokens, { input: 4, output: 6, total: 10 });
	assert.equal(calls[1].continueSession, true);
	assert.equal(CONTINUE_PROMPT.includes("Carry on"), true);
});

test("runWithResume does not retry a permanent error", async () => {
	let calls = 0;
	const gate = new OutageGate({ pauseMs: 1, probeMs: 1, probe: async () => true });
	const result = await runWithResume({
		run: async () => {
			calls++;
			return { ok: false, error: "verification failed", cost: 0 };
		},
		hasSession: () => false,
		gate,
		maxResumes: 5,
		backoff: [1],
		signal: new AbortController().signal,
	});
	assert.equal(result.resumes, 0);
	assert.equal(calls, 1);
});
