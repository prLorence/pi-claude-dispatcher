/** Run with: cd pi-plan-dispatch && node --test --test-force-exit resilience.test.ts (Node 24+) */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	CONTINUE_PROMPT,
	OutageGate,
	StallTracker,
	backoffSeconds,
	classifyError,
	probeUrls,
	runWithResume,
} from "./resilience.ts";

/** A clock and sleep the tests own: `sleep` advances the clock, nothing waits. */
function fakeTime() {
	const t = { now: 0, sleeps: [] as number[] };
	return {
		...t,
		sleeps: t.sleeps,
		nowFn: () => t.now,
		sleep: (ms: number) => {
			t.sleeps.push(ms);
			return Promise.resolve();
		},
		advancingSleep: (ms: number) => {
			t.sleeps.push(ms);
			t.now += ms;
			return Promise.resolve();
		},
	};
}

// ---------- classifyError ----------

test("classifyError: the real transient messages of 2026-10-25", () => {
	const transient = [
		'502 "cannot resolve tunnel destination openrouter.ai (ETIMEDOUT): local name resolution failed"',
		'502 "acp-proxy failure"',
		"Stream ended without finish_reason",
		"stalled: no output for 3 min",
		"429 Too Many Requests",
		'429: {"type":"server_error","message":"Upstream request failed: Endpoint is unavailable."}',
		'503: {"type":"server_error","message":"x"}',
		"terminated",
		"connect ECONNABORTED 1.2.3.4:443",
		"The operation was aborted due to timeout",
		"Error: socket hang up",
		"TypeError: fetch failed",
		"read ECONNRESET",
		"connect ECONNREFUSED 127.0.0.1:443",
		"getaddrinfo EAI_AGAIN openrouter.ai",
		"getaddrinfo ENOTFOUND openrouter.ai",
		"write EPIPE",
		"network is unreachable",
		"the other side closed",
		"529 overloaded",
		"504 Gateway Timeout",
		"502 Bad Gateway",
		"503 Service Unavailable",
		"provider is temporarily unavailable",
		"model overloaded, try again",
		"rate limit exceeded",
		"too many requests",
	];
	for (const text of transient) assert.equal(classifyError(text), "transient", text);
});

test("classifyError: a status code counts only as a standalone number", () => {
	assert.equal(classifyError("429: {}"), "transient");
	assert.equal(classifyError('{"status": 503}'), "transient");
	assert.equal(classifyError("status 502 at the edge"), "transient");
	assert.equal(classifyError("TypeError: x is not a function\n    at run (index.ts:502:7)"), "permanent");
	assert.equal(classifyError("src/x.ts:429:12 boom"), "permanent");
	assert.equal(classifyError("build 15029 failed"), "permanent");
	assert.equal(classifyError("portal 5030 unreachable"), "permanent");
});

test("classifyError: the permanent messages stay permanent", () => {
	const permanent = [
		"verification failed: exit code 1",
		"worker reported STATUS: failed",
		"No API key found",
		"worker timed out after 20 min",
		"401 Unauthorized",
		"aborted",
		"stop reason: aborted",
		"TypeError: x is not a function\n    at run (index.ts:502:7)",
		"context length exceeded",
		"maximum context tokens reached",
		"content policy violation",
		"",
		"   ",
	];
	for (const text of permanent) assert.equal(classifyError(text), "permanent", text);
	assert.equal(classifyError(undefined as unknown as string), "permanent", "a non-string is permanent");
});

test("classifyError: a permanent marker wins over a transient one", () => {
	assert.equal(classifyError("verification failed after ECONNRESET"), "permanent");
	assert.equal(classifyError("timed out after 20 min on 503"), "permanent");
});

test("classifyError: the abort words are matched case-insensitively", () => {
	assert.equal(classifyError("ABORTED"), "permanent");
	assert.equal(classifyError("STOP REASON: Aborted"), "permanent");
	assert.equal(classifyError("ECONNABORTED"), "transient", "the bare substring is not a marker");
});

// ---------- backoffSeconds ----------

test("backoffSeconds: indexes by resume number and repeats the last value", () => {
	const list = [15, 30, 60];
	assert.equal(backoffSeconds(list, 1), 15);
	assert.equal(backoffSeconds(list, 2), 30);
	assert.equal(backoffSeconds(list, 3), 60);
	assert.equal(backoffSeconds(list, 4), 60, "past the end repeats the last");
	assert.equal(backoffSeconds(list, 100), 60);
	assert.equal(backoffSeconds([0.05], 1), 0.05);
});

test("backoffSeconds: an empty or invalid list gives the default", () => {
	assert.equal(backoffSeconds([], 1), 15);
	assert.equal(backoffSeconds([0, -1, Number.NaN, Number.POSITIVE_INFINITY], 2), 15);
	assert.equal(backoffSeconds(undefined as unknown as number[], 1), 15);
	assert.equal(backoffSeconds([0, 30], 1), 30, "invalid entries are dropped");
});

test("CONTINUE_PROMPT: the resume prompt of the spec, verbatim", () => {
	assert.equal(
		CONTINUE_PROMPT,
		"Your previous request stopped because of a network or provider error before you finished. Carry on from where you stopped; read the files again if you are unsure what is already done.",
	);
});

// ---------- probeUrls ----------

const fetchAnswering =
	(status: number) => (() => Promise.resolve(new Response("", { status }))) as unknown as typeof fetch;

const fetchFailing = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;

test("probeUrls: one answer of two is enough", async () => {
	const seen: string[] = [];
	const impl = ((url: string) => {
		seen.push(url);
		return url.includes("second") ? Promise.resolve(new Response("", { status: 200 })) : Promise.reject(new Error("no"));
	}) as unknown as typeof fetch;
	assert.equal(await probeUrls(["https://first.test", "https://second.test"], 100, impl), true);
	assert.deepEqual(seen, ["https://first.test", "https://second.test"]);
});

test("probeUrls: all probes failing means no network", async () => {
	assert.equal(await probeUrls(["https://a.test", "https://b.test"], 100, fetchFailing), false);
	assert.equal(await probeUrls([], 100, fetchAnswering(200)), false, "no URLs to probe");
});

test("probeUrls: any HTTP status counts as an answer", async () => {
	assert.equal(await probeUrls(["https://a.test"], 100, fetchAnswering(500)), true);
	assert.equal(await probeUrls(["https://a.test"], 100, fetchAnswering(404)), true);
});

test("probeUrls: a fetch that never answers until the timeout counts as no answer", async () => {
	const hanging = ((_url: string, init?: { signal?: AbortSignal }) =>
		new Promise((_resolve, reject) => {
			init?.signal?.addEventListener("abort", () => reject(new Error("aborted due to timeout")), { once: true });
		})) as unknown as typeof fetch;
	assert.equal(await probeUrls(["https://a.test"], 10, hanging), false);
});

// ---------- OutageGate ----------

test("OutageGate: closed at start, wait is clear at once and report opens it once", async () => {
	const time = fakeTime();
	const starts: string[] = [];
	const gate = new OutageGate({
		pauseMs: 10_000,
		probeMs: 1_000,
		probe: async () => true,
		now: time.nowFn,
		sleep: time.advancingSleep,
		onStart: (reason) => starts.push(reason),
	});
	assert.equal(gate.open, false);
	assert.equal(await gate.wait(), "clear");
	gate.report("502");
	gate.report("502 again");
	assert.equal(gate.open, true);
	assert.deepEqual(starts, ["502"], "onStart fires once per outage");
	assert.equal(await gate.wait(), "clear", "a healthy probe releases the waiter");
	assert.equal(gate.open, false);
});

test("OutageGate: a healthy probe closes it and reports the duration", async () => {
	const time = fakeTime();
	const ends: Array<[number, string]> = [];
	let calls = 0;
	const gate = new OutageGate({
		pauseMs: 10_000,
		probeMs: 1_000,
		probe: async () => ++calls > 1,
		now: time.nowFn,
		sleep: time.advancingSleep,
		onEnd: (ms, outcome) => ends.push([ms, outcome]),
	});
	gate.report("Stream ended without finish_reason");
	assert.equal(await gate.wait(), "clear");
	assert.equal(calls, 2, "the first probe was unhealthy, the second healthy");
	assert.deepEqual(ends, [[2_000, "healthy"]]);
	assert.deepEqual(time.sleeps, [1_000, 1_000], "it sleeps before every probe");
});

test("OutageGate: it gives up after pauseMs without a healthy probe", async () => {
	const time = fakeTime();
	const ends: Array<[number, string]> = [];
	const gate = new OutageGate({
		pauseMs: 3_000,
		probeMs: 1_000,
		probe: async () => false,
		now: time.nowFn,
		sleep: time.advancingSleep,
		onEnd: (ms, outcome) => ends.push([ms, outcome]),
	});
	gate.report("ECONNRESET");
	assert.equal(await gate.wait(), "gave-up");
	assert.equal(gate.open, false);
	assert.deepEqual(ends, [[3_000, "gave-up"]]);
});

test("OutageGate: a probe that throws counts as unhealthy", async () => {
	const time = fakeTime();
	const gate = new OutageGate({
		pauseMs: 2_000,
		probeMs: 1_000,
		probe: async () => {
			throw new Error("boom");
		},
		now: time.nowFn,
		sleep: time.advancingSleep,
	});
	gate.report("fetch failed");
	assert.equal(await gate.wait(), "gave-up");
});

test("OutageGate: wait is aborted with the signal", async () => {
	const time = fakeTime();
	const gate = new OutageGate({
		pauseMs: 10_000,
		probeMs: 10_000,
		probe: async () => {
			throw new Error("never probed");
		},
		now: time.nowFn,
		sleep: () => new Promise<void>(() => {}),
	});
	gate.report("EAI_AGAIN");
	const controller = new AbortController();
	const waiting = gate.wait(controller.signal);
	controller.abort();
	assert.equal(await waiting, "aborted");
	assert.equal(gate.open, true, "an aborted waiter does not close the gate");
	gate.close();
});

test("OutageGate: a second outage after a close opens it again", async () => {
	const time = fakeTime();
	const starts: string[] = [];
	const gate = new OutageGate({
		pauseMs: 10_000,
		probeMs: 1_000,
		probe: async () => true,
		now: time.nowFn,
		sleep: time.advancingSleep,
		onStart: (reason) => starts.push(reason),
	});
	gate.report("502");
	assert.equal(await gate.wait(), "clear");
	gate.report("503");
	assert.equal(gate.open, true);
	assert.equal(await gate.wait(), "clear");
	assert.deepEqual(starts, ["502", "503"]);
});

test("OutageGate: close stops the probe loop and releases the waiter", async () => {
	let probes = 0;
	let sleeps = 0;
	const gate = new OutageGate({
		pauseMs: 10_000_000,
		probeMs: 1,
		probe: () => {
			probes++;
			return new Promise<boolean>(() => {});
		},
		sleep: () => {
			sleeps++;
			return Promise.resolve();
		},
	});
	gate.report("terminated");
	const waiting = gate.wait();
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(probes, 1, "the probe loop started");
	gate.close();
	assert.equal(await waiting, "aborted");
	assert.equal(gate.open, false);
	const after = [probes, sleeps];
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
	assert.deepEqual([probes, sleeps], after, "no probe runs after the close");
	gate.report("502");
	assert.equal(gate.open, true, "a report after a close starts a new outage");
	gate.close();
});

test("OutageGate: changed resolves on the next flip", async () => {
	const time = fakeTime();
	const gate = new OutageGate({
		pauseMs: 10_000,
		probeMs: 1_000,
		probe: async () => true,
		now: time.nowFn,
		sleep: time.advancingSleep,
	});
	let flipped = 0;
	const changed = gate.changed().then(() => flipped++);
	gate.report("429");
	await changed;
	assert.equal(flipped, 1);
	await gate.wait();
	const closed = gate.changed().then(() => flipped++);
	gate.close();
	await closed;
	assert.equal(flipped, 2);
});

// ---------- StallTracker ----------

test("StallTracker: idle time grows and a stall is reported", () => {
	const now = { t: 0 };
	const tracker = new StallTracker({ stallMs: 1_000, now: () => now.t });
	assert.equal(tracker.stalled(), false);
	now.t = 999;
	assert.equal(tracker.idleMs, 999);
	assert.equal(tracker.stalled(), false);
	now.t = 1_000;
	assert.equal(tracker.stalled(), true);
	assert.equal(tracker.toolsInFlight, 0);
});

test("StallTracker: a tool in flight blocks the stall and its end clears it", () => {
	const now = { t: 0 };
	const tracker = new StallTracker({ stallMs: 1_000, now: () => now.t });
	tracker.toolStart("call-1");
	now.t = 60_000;
	assert.equal(tracker.toolsInFlight, 1);
	assert.equal(tracker.stalled(), false, "a long tool call is never a stall");
	tracker.toolEnd("call-1");
	assert.equal(tracker.toolsInFlight, 0);
	assert.equal(tracker.stalled(), false, "the end of the tool resets the clock");
	now.t += 1_000;
	assert.equal(tracker.stalled(), true);
});

test("StallTracker: touch resets the idle clock, stallMs 0 never stalls", () => {
	const now = { t: 0 };
	const tracker = new StallTracker({ stallMs: 1_000, now: () => now.t });
	now.t = 900;
	tracker.touch();
	now.t = 1_500;
	assert.equal(tracker.idleMs, 600);
	assert.equal(tracker.stalled(), false);

	const off = new StallTracker({ stallMs: 0, now: () => now.t });
	now.t = 10_000_000;
	assert.equal(off.stalled(), false);
});

test("StallTracker: an unknown tool end is ignored", () => {
	const now = { t: 0 };
	const tracker = new StallTracker({ stallMs: 1_000, now: () => now.t });
	tracker.toolEnd("never-started");
	assert.equal(tracker.toolsInFlight, 0);
	now.t = 1_000;
	assert.equal(tracker.stalled(), true);
});

// ---------- runWithResume ----------

type FakeResult = {
	ok: boolean;
	error?: string;
	cost: number;
	tokens?: { input: number; output: number; total: number };
	tools?: unknown[];
	session?: { file?: string };
	output: string;
};

const result = (over: Partial<FakeResult>): FakeResult => ({
	ok: true,
	cost: 0.1,
	tokens: { input: 10, output: 5, total: 15 },
	tools: [{ name: "read" }],
	output: "done",
	...over,
});

/** A gate that opens on a report and is clear at once: no probing in the loop tests. */
function instantGate() {
	const reports: string[] = [];
	const clock = { t: 0 };
	const gate = new OutageGate({
		pauseMs: 10_000,
		probeMs: 1,
		probe: async () => true,
		now: () => clock.t,
		sleep: (ms) => {
			clock.t += ms;
			return Promise.resolve();
		},
		onStart: (reason) => reports.push(reason),
	});
	return { gate, reports };
}

const hasFile = (r: FakeResult) => Boolean(r.session?.file);

test("runWithResume: a first-run success makes no resume", async () => {
	const { gate } = instantGate();
	const infos: Array<{ resume: number; continueSession: boolean } | null> = [];
	const r = await runWithResume({
		run: async (info) => {
			infos.push(info);
			return result({});
		},
		hasSession: hasFile,
		gate,
		maxResumes: 6,
		backoff: [0.05],
		signal: new AbortController().signal,
		sleep: () => Promise.resolve(),
	});
	assert.equal(r.resumes, 0);
	assert.deepEqual(infos, [null]);
	assert.equal(r.ok, true);
	assert.equal(r.cost, 0.1);
	assert.equal(r.output, "done");
});

test("runWithResume: a transient failure resumes the same session and sums the runs", async () => {
	const { gate, reports } = instantGate();
	const infos: Array<{ resume: number; continueSession: boolean } | null> = [];
	const resumes: Array<{ resume: number; waitSec: number; error: string }> = [];
	const sleeps: number[] = [];
	const r = await runWithResume({
		run: async (info) => {
			infos.push(info);
			return info === null
				? result({ ok: false, error: "Stream ended without finish_reason", session: { file: "/tmp/s.jsonl" } })
				: result({ cost: 0.2, tokens: { input: 1, output: 2, total: 3 }, tools: [{ name: "edit" }], output: "second" });
		},
		hasSession: (x) => hasFile(x),
		gate,
		maxResumes: 6,
		backoff: [0.05, 0.1],
		signal: new AbortController().signal,
		sleep: async (ms) => {
			sleeps.push(ms);
		},
		onResume: (i) => resumes.push(i),
	});
	assert.equal(r.resumes, 1);
	assert.deepEqual(infos, [null, { resume: 1, continueSession: true }]);
	assert.deepEqual(sleeps, [50], "the wait comes from backoffSeconds");
	assert.deepEqual(resumes, [{ resume: 1, waitSec: 0.05, error: "Stream ended without finish_reason" }]);
	assert.deepEqual(reports, ["Stream ended without finish_reason"], "the gate hears the error");
	assert.equal(r.ok, true, "the last result is returned");
	assert.equal(r.output, "second");
	assert.ok(Math.abs(r.cost - 0.3) < 1e-9, "cost is summed over both runs");
	assert.deepEqual(r.tokens, { input: 11, output: 7, total: 18 }, "tokens are summed");
	assert.deepEqual(r.tools, [{ name: "read" }, { name: "edit" }], "tools are concatenated in run order");
});

test("runWithResume: without a session file the resume starts from the original prompt", async () => {
	const { gate } = instantGate();
	const infos: Array<{ resume: number; continueSession: boolean } | null> = [];
	await runWithResume({
		run: async (info) => {
			infos.push(info);
			return info === null ? result({ ok: false, error: "502 gateway" }) : result({});
		},
		hasSession: hasFile,
		gate,
		maxResumes: 6,
		backoff: [0.05],
		signal: new AbortController().signal,
		sleep: () => Promise.resolve(),
	});
	assert.deepEqual(infos, [null, { resume: 1, continueSession: false }]);
});

test("runWithResume: a permanent failure returns at once with no resume", async () => {
	const { gate, reports } = instantGate();
	let calls = 0;
	const r = await runWithResume({
		run: async () => {
			calls++;
			return result({ ok: false, error: "verification failed: exit code 1" });
		},
		hasSession: hasFile,
		gate,
		maxResumes: 6,
		backoff: [0.05],
		signal: new AbortController().signal,
		sleep: () => Promise.resolve(),
	});
	assert.equal(calls, 1);
	assert.equal(r.resumes, 0);
	assert.equal(r.ok, false);
	assert.equal(r.error, "verification failed: exit code 1");
	assert.deepEqual(reports, [], "the gate never hears a permanent failure");
});

test("runWithResume: maxResumes is a limit of the call, and a second call has its own", async () => {
	const { gate } = instantGate();
	const always = (calls: { n: number }) => async () => {
		calls.n++;
		return result({ ok: false, error: "ECONNRESET" });
	};
	const first = { n: 0 };
	const r1 = await runWithResume({
		run: always(first),
		hasSession: hasFile,
		gate,
		maxResumes: 2,
		backoff: [0.05],
		signal: new AbortController().signal,
		sleep: () => Promise.resolve(),
	});
	assert.equal(first.n, 3, "the first run plus two resumes");
	assert.equal(r1.resumes, 2);
	assert.equal(r1.ok, false);
	assert.equal(r1.error, "ECONNRESET", "the last failed result comes back");

	const second = { n: 0 };
	const r2 = await runWithResume({
		run: always(second),
		hasSession: hasFile,
		gate,
		maxResumes: 2,
		backoff: [0.05],
		signal: new AbortController().signal,
		sleep: () => Promise.resolve(),
	});
	assert.equal(second.n, 3);
	assert.equal(r2.resumes, 2, "the counter is per call");
});

test("runWithResume: the backoff waits follow the list", async () => {
	const { gate } = instantGate();
	const sleeps: number[] = [];
	const r = await runWithResume({
		run: async () => result({ ok: false, error: "429 Too Many Requests" }),
		hasSession: hasFile,
		gate,
		maxResumes: 3,
		backoff: [0.05, 0.1, 0.2],
		signal: new AbortController().signal,
		sleep: async (ms) => {
			sleeps.push(ms);
		},
	});
	assert.equal(r.resumes, 3);
	assert.deepEqual(sleeps, [50, 100, 200]);
});

test("runWithResume: an abort during the wait ends the loop", async () => {
	const { gate } = instantGate();
	const controller = new AbortController();
	let calls = 0;
	const r = await runWithResume({
		run: async () => {
			calls++;
			return result({ ok: false, error: "EAI_AGAIN" });
		},
		hasSession: hasFile,
		gate,
		maxResumes: 6,
		backoff: [0.05],
		signal: controller.signal,
		sleep: async () => {
			controller.abort();
		},
	});
	assert.equal(calls, 1, "no run after the abort");
	assert.equal(r.resumes, 1, "the resume was counted before the wait");
	assert.equal(r.ok, false);
});

test("runWithResume: an already aborted signal makes no resume", async () => {
	const { gate } = instantGate();
	const controller = new AbortController();
	controller.abort();
	let calls = 0;
	const r = await runWithResume({
		run: async () => {
			calls++;
			return result({ ok: false, error: "ECONNREFUSED" });
		},
		hasSession: hasFile,
		gate,
		maxResumes: 6,
		backoff: [0.05],
		signal: controller.signal,
		sleep: () => Promise.resolve(),
	});
	assert.equal(calls, 1);
	assert.equal(r.resumes, 0);
});

test("runWithResume: a gate that gives up returns the last failed result", async () => {
	const clock = { t: 0 };
	const gate = new OutageGate({
		pauseMs: 3_000,
		probeMs: 1_000,
		probe: async () => false,
		now: () => clock.t,
		sleep: (ms) => {
			clock.t += ms;
			return Promise.resolve();
		},
	});
	let calls = 0;
	const r = await runWithResume({
		run: async () => {
			calls++;
			return result({ ok: false, error: "502 acp-proxy failure" });
		},
		hasSession: hasFile,
		gate,
		maxResumes: 6,
		backoff: [0.05],
		signal: new AbortController().signal,
		sleep: () => Promise.resolve(),
	});
	assert.equal(calls, 1, "the gate gave up before the resumed run, so there is no second run");
	assert.equal(r.resumes, 1, "the resume that was interrupted is counted");
	assert.equal(r.ok, false);
	assert.equal(r.error, "502 acp-proxy failure");
});

test("runWithResume: an outage is reported to the gate once, not on every resume", async () => {
	const starts: string[] = [];
	const clock = { t: 0 };
	const gate = new OutageGate({
		pauseMs: 10_000,
		probeMs: 1_000,
		probe: async () => false,
		now: () => clock.t,
		sleep: (ms) => {
			clock.t += ms;
			return Promise.resolve();
		},
		onStart: (reason) => starts.push(reason),
	});
	gate.report("502");
	gate.report("502");
	gate.report("503");
	assert.deepEqual(starts, ["502"]);
	gate.close();
});
