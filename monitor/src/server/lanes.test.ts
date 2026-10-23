import { test, expect } from "bun:test";
import type { ParsedPlan, TraceEvent } from "./plans.ts";
import { buildPlanView } from "./lanes.ts";
import { listSessionFiles, summarizeSession, type SessionSummary } from "./sessions.ts";
import {
  assistantMsg,
  cleanup,
  makePlansDir,
  sessionHeader,
  textPart,
  writeSession,
} from "../../test/fixture.ts";

const NOW = Date.parse("2026-10-23T10:05:00.000Z");
const PLAN_ID = "20261023-1458-monitor-r1";
const TRACE = "20261023-1458-monitor";
const TS = "2026-10-23T10:00:10.000Z";

const PAIR: ParsedPlan = {
  id: PLAN_ID,
  trace: TRACE,
  round: 1,
  tasks: [{ id: "one", role: "implement", pair: "review", dependsOn: [] }],
};

function noSession(): SessionSummary {
  return {
    exists: false,
    ended: false,
    stopReason: null,
    startedAt: null,
    lastTs: null,
    mtimeMs: 0,
    lastTool: null,
    tokens: null,
    cost: null,
    lastText: null,
    model: null,
    thinking: null,
    error: null,
  };
}

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    exists: true,
    ended: true,
    stopReason: "stop",
    startedAt: "2026-10-23T10:00:00.000Z",
    lastTs: "2026-10-23T10:00:30.000Z",
    mtimeMs: NOW - 10000,
    lastTool: "edit lanes.ts",
    tokens: 1500,
    cost: 0.02,
    lastText: "the reviewer text",
    model: "opencode-go/beam-free",
    thinking: "high",
    error: null,
    ...overrides,
  };
}

function summarizeBy(map: Record<string, SessionSummary>) {
  return (file: string | null): SessionSummary => {
    if (file === null) {
      return noSession();
    }
    return map[file] ?? noSession();
  };
}

function attemptId(suffix: string): string {
  return `${PLAN_ID}.one.${suffix}`;
}

function fileOf(sessionId: string): string {
  return `sessions/${PLAN_ID}/${sessionId}.jsonl`;
}

function filesOf(sessionIds: string[]): { id: string; file: string }[] {
  return sessionIds.map((id) => ({ id, file: fileOf(id) }));
}

function startEvent(
  task: string,
  attempt: number,
  data: Record<string, unknown> = {},
): TraceEvent {
  return {
    ts: "2026-10-23T10:00:00.000Z",
    kind: "task.start",
    plan: PLAN_ID,
    task,
    attempt,
    data,
  };
}

function endEvent(
  task: string,
  attempt: number,
  data: Record<string, unknown>,
): TraceEvent {
  return {
    ts: "2026-10-23T10:01:00.000Z",
    kind: "task.end",
    plan: PLAN_ID,
    task,
    attempt,
    data,
  };
}

function reviewEvent(task: string, data: Record<string, unknown>): TraceEvent {
  return {
    ts: "2026-10-23T10:02:00.000Z",
    kind: "task.review",
    plan: PLAN_ID,
    task,
    attempt: 1,
    data,
  };
}

function planEndEvent(data: Record<string, unknown>): TraceEvent {
  return {
    ts: "2026-10-23T10:03:00.000Z",
    kind: "plan.end",
    plan: PLAN_ID,
    data,
  };
}

test("an implementer is live while recent and stalled when the file stops growing", () => {
  const dir = makePlansDir();
  try {
    const sessionId = attemptId("a1");
    writeSession(
      dir,
      PLAN_ID,
      sessionId,
      [
        sessionHeader(sessionId),
        assistantMsg([textPart("working")], TS, {
          stopReason: "toolUse",
          input: 100,
          output: 20,
          cost: 0.5,
        }),
      ],
      { mtimeMs: NOW - 5000 },
    );
    const sessionFiles = listSessionFiles(dir, PLAN_ID);
    const events = [
      startEvent("one", 1, {
        session_id: sessionId,
        model: "opencode-go/beam-free",
        thinking: "high",
      }),
    ];

    const live = buildPlanView(PAIR, true, events, sessionFiles, NOW);
    const attempt = live.tasks[0].implementer.attempts[0];
    expect(attempt.state).toBe("live");
    expect(live.tasks[0].implementer.state).toBe("live");
    expect(attempt.hasSession).toBe(true);
    expect(attempt.label).toBe("a1");
    expect(attempt.model).toBe("opencode-go/beam-free");
    expect(attempt.thinking).toBe("high");
    expect(attempt.tokens).toBe(120);
    expect(attempt.cost).toBe(0.5);
    expect(attempt.startedAt).toBe(TS);
    expect(attempt.elapsedS).toBe(0);

    writeSession(
      dir,
      PLAN_ID,
      sessionId,
      [
        sessionHeader(sessionId),
        assistantMsg([textPart("working")], TS, { stopReason: "toolUse" }),
      ],
      { mtimeMs: NOW - 120000 },
    );
    const stalled = buildPlanView(PAIR, true, events, sessionFiles, NOW);
    expect(stalled.tasks[0].implementer.state).toBe("stalled");

    const idle = buildPlanView(PAIR, false, events, sessionFiles, NOW);
    expect(idle.tasks[0].implementer.state).toBe("stalled");
    expect(summarizeSession(sessionFiles[0].file).ended).toBe(false);
  } finally {
    cleanup(dir);
  }
});

test("an attempt with no session file is live while the plan runs and waiting otherwise", () => {
  const sessionId = attemptId("a1");
  const events = [startEvent("one", 1, { session_id: sessionId })];

  const live = buildPlanView(PAIR, true, events, [], NOW, summarizeBy({}));
  const attempt = live.tasks[0].implementer.attempts[0];
  expect(attempt.state).toBe("live");
  expect(attempt.hasSession).toBe(false);
  expect(attempt.id).toBe(sessionId);
  expect(live.tasks[0].implementer.state).toBe("live");

  const idle = buildPlanView(PAIR, false, events, [], NOW, summarizeBy({}));
  expect(idle.tasks[0].skipped).toBe(false);
  expect(idle.tasks[0].implementer.state).toBe("waiting");
});

test("an ended implementer with no task.end yet is done", () => {
  const sessionId = attemptId("a1");
  const view = buildPlanView(
    PAIR,
    true,
    [startEvent("one", 1)],
    filesOf([sessionId]),
    NOW,
    summarizeBy({ [fileOf(sessionId)]: summary({ stopReason: "stop" }) }),
  );
  const lane = view.tasks[0].implementer;
  expect(lane.attempts[0].id).toBe(sessionId);
  expect(lane.attempts[0].hasSession).toBe(true);
  expect(lane.state).toBe("done");
});

test("an implementer is failed by a failed task.end, a failed retry or a stopReason error", () => {
  const sessionId = attemptId("a1");
  const file = fileOf(sessionId);

  const failedEnd = buildPlanView(
    PAIR,
    true,
    [startEvent("one", 1), endEvent("one", 1, { state: "failed", ok: false })],
    filesOf([sessionId]),
    NOW,
    summarizeBy({ [file]: summary({ stopReason: "stop" }) }),
  );
  expect(failedEnd.tasks[0].implementer.state).toBe("failed");

  const failedRetry = buildPlanView(
    PAIR,
    true,
    [startEvent("one", 1), endEvent("one", 1, { state: "retry", ok: false })],
    filesOf([sessionId]),
    NOW,
    summarizeBy({ [file]: summary({ stopReason: "stop" }) }),
  );
  expect(failedRetry.tasks[0].implementer.state).toBe("failed");

  const stopError = buildPlanView(
    PAIR,
    true,
    [startEvent("one", 1)],
    filesOf([sessionId]),
    NOW,
    summarizeBy({ [file]: summary({ stopReason: "error", error: "boom" }) }),
  );
  expect(stopError.tasks[0].implementer.state).toBe("failed");
  expect(stopError.tasks[0].implementer.attempts[0].error).toBe("boom");
});

test("a retry with ok true is a good attempt the reviewer sent back, so it is done", () => {
  const sessionId = attemptId("a1");
  const view = buildPlanView(
    PAIR,
    true,
    [startEvent("one", 1), endEvent("one", 1, { state: "retry", ok: true })],
    filesOf([sessionId]),
    NOW,
    summarizeBy({ [fileOf(sessionId)]: summary({ stopReason: "stop" }) }),
  );
  expect(view.tasks[0].implementer.state).toBe("done");
});

test("an attempt with no session file takes its outcome from task.end", () => {
  const done = buildPlanView(
    PAIR,
    true,
    [endEvent("one", 1, { state: "done", ok: true })],
    [],
    NOW,
    summarizeBy({}),
  );
  expect(done.tasks[0].implementer.attempts).toHaveLength(1);
  expect(done.tasks[0].implementer.attempts[0].hasSession).toBe(false);
  expect(done.tasks[0].implementer.attempts[0].state).toBe("done");
  expect(done.tasks[0].implementer.state).toBe("done");

  const failed = buildPlanView(
    PAIR,
    true,
    [endEvent("one", 2, { state: "failed", ok: false })],
    [],
    NOW,
    summarizeBy({}),
  );
  expect(failed.tasks[0].implementer.attempts[0].label).toBe("a2");
  expect(failed.tasks[0].implementer.state).toBe("failed");
});

test("a reviewer waits before its file exists and is live during its run", () => {
  const sessionId = `${PLAN_ID}.one.review1.a1`;
  const waiting = buildPlanView(
    PAIR,
    true,
    [startEvent("one", 1)],
    [],
    NOW,
    summarizeBy({}),
  );
  const waitingLane = waiting.tasks[0].reviewer;
  expect(waitingLane).not.toBeNull();
  if (waitingLane === null) {
    return;
  }
  expect(waitingLane.state).toBe("waiting");
  expect(waitingLane.attempts).toEqual([]);

  const live = buildPlanView(
    PAIR,
    true,
    [startEvent("one", 1)],
    filesOf([sessionId]),
    NOW,
    summarizeBy({
      [fileOf(sessionId)]: summary({ ended: false, mtimeMs: NOW - 1000 }),
    }),
  );
  const liveLane = live.tasks[0].reviewer;
  expect(liveLane).not.toBeNull();
  if (liveLane === null) {
    return;
  }
  expect(liveLane.state).toBe("live");
  expect(liveLane.attempts[0].label).toBe("r1");
  expect(liveLane.attempts[0].review).toBeNull();
});

test("a finished reviewer pins its verdict and findings count", () => {
  const sessionId = `${PLAN_ID}.one.review1.a1`;
  const view = buildPlanView(
    PAIR,
    true,
    [
      startEvent("one", 1),
      reviewEvent("one", {
        round: 1,
        session_id: sessionId,
        verdict: "approve",
        findings: 0,
        ok: true,
        model: "opencode-go/beam-free",
      }),
    ],
    filesOf([sessionId]),
    NOW,
    summarizeBy({ [fileOf(sessionId)]: summary({ lastText: "all good" }) }),
  );
  const lane = view.tasks[0].reviewer;
  expect(lane).not.toBeNull();
  if (lane === null) {
    return;
  }
  expect(lane.state).toBe("done");
  expect(lane.attempts[0].review).toEqual({
    verdict: "approve",
    findings: 0,
    failed: false,
    text: "all good",
  });

  const changes = buildPlanView(
    PAIR,
    true,
    [
      startEvent("one", 1),
      reviewEvent("one", {
        round: 1,
        session_id: sessionId,
        verdict: "changes",
        findings: 2,
        ok: true,
      }),
    ],
    filesOf([sessionId]),
    NOW,
    summarizeBy({ [fileOf(sessionId)]: summary() }),
  );
  const changesReview = changes.tasks[0].reviewer?.attempts[0].review;
  expect(changesReview?.verdict).toBe("changes");
  expect(changesReview?.findings).toBe(2);
  expect(changesReview?.failed).toBe(false);
});

test("a failed reviewer is failed and never a pass", () => {
  const sessionId = `${PLAN_ID}.one.review1.a1`;
  const failed = buildPlanView(
    PAIR,
    true,
    [
      startEvent("one", 1),
      reviewEvent("one", {
        round: 1,
        session_id: sessionId,
        verdict: "changes",
        findings: 1,
        ok: false,
      }),
    ],
    [],
    NOW,
    summarizeBy({}),
  );
  const failedLane = failed.tasks[0].reviewer;
  expect(failedLane).not.toBeNull();
  if (failedLane === null) {
    return;
  }
  expect(failedLane.state).toBe("failed");
  expect(failedLane.attempts[0].hasSession).toBe(false);
  expect(failedLane.attempts[0].review?.failed).toBe(true);
  expect(failedLane.attempts[0].review?.text).toBeNull();

  const unknown = buildPlanView(
    PAIR,
    true,
    [
      startEvent("one", 1),
      reviewEvent("one", {
        round: 1,
        session_id: sessionId,
        verdict: "clean",
        findings: 0,
        ok: true,
      }),
    ],
    [],
    NOW,
    summarizeBy({}),
  );
  const unknownLane = unknown.tasks[0].reviewer;
  expect(unknownLane).not.toBeNull();
  if (unknownLane === null) {
    return;
  }
  expect(unknownLane.state).toBe("failed");
  expect(unknownLane.attempts[0].review?.verdict).toBe("unknown");
  expect(unknownLane.attempts[0].review?.failed).toBe(true);
});

test("two implementer attempts keep their order and the newest one sets the lane", () => {
  const first = attemptId("a1");
  const second = attemptId("a2");
  const view = buildPlanView(
    PAIR,
    true,
    [
      startEvent("one", 1),
      endEvent("one", 1, { state: "failed", ok: false }),
      startEvent("one", 2),
    ],
    filesOf([first, second]),
    NOW,
    summarizeBy({
      [fileOf(first)]: summary({ stopReason: "stop" }),
      [fileOf(second)]: summary({ ended: false, mtimeMs: NOW - 2000 }),
    }),
  );
  const lane = view.tasks[0].implementer;
  expect(lane.attempts.map((attempt) => attempt.label)).toEqual(["a1", "a2"]);
  expect(lane.attempts[0].state).toBe("failed");
  expect(lane.attempts[1].state).toBe("live");
  expect(lane.state).toBe("live");
});

test("attempts named only by session files are picked up", () => {
  const first = attemptId("a1");
  const second = attemptId("a2");
  const view = buildPlanView(
    PAIR,
    true,
    [],
    filesOf([second, first]),
    NOW,
    summarizeBy({
      [fileOf(first)]: summary({ stopReason: "stop" }),
      [fileOf(second)]: summary({ ended: false, mtimeMs: NOW - 1000 }),
    }),
  );
  const lane = view.tasks[0].implementer;
  expect(lane.attempts.map((attempt) => attempt.label)).toEqual(["a1", "a2"]);
  expect(lane.attempts.map((attempt) => attempt.hasSession)).toEqual([true, true]);
  expect(lane.state).toBe("live");
});

test("two review rounds keep their order and the newest round sets the lane", () => {
  const first = `${PLAN_ID}.one.review1.a1`;
  const second = `${PLAN_ID}.one.review2.a1`;
  const view = buildPlanView(
    PAIR,
    true,
    [
      startEvent("one", 1),
      reviewEvent("one", {
        round: 1,
        session_id: first,
        verdict: "approve",
        findings: 0,
        ok: true,
      }),
    ],
    filesOf([first, second]),
    NOW,
    summarizeBy({
      [fileOf(first)]: summary({ stopReason: "stop" }),
      [fileOf(second)]: summary({ ended: false, mtimeMs: NOW - 1000 }),
    }),
  );
  const lane = view.tasks[0].reviewer;
  expect(lane).not.toBeNull();
  if (lane === null) {
    return;
  }
  expect(lane.attempts.map((attempt) => attempt.label)).toEqual(["r1", "r2"]);
  expect(lane.attempts[0].review?.verdict).toBe("approve");
  expect(lane.attempts[1].review).toBeNull();
  expect(lane.state).toBe("live");
});

test("waitsFor lists the dependencies that are not done yet", () => {
  const plan: ParsedPlan = {
    id: PLAN_ID,
    trace: TRACE,
    round: 1,
    tasks: [
      { id: "one", role: "implement", pair: null, dependsOn: [] },
      { id: "two", role: "implement", pair: null, dependsOn: ["one"] },
      { id: "three", role: "qa", pair: "review", dependsOn: ["one", "two"] },
    ],
  };
  const view = buildPlanView(
    plan,
    true,
    [
      startEvent("one", 1),
      endEvent("one", 1, { state: "done", ok: true }),
      startEvent("two", 1),
    ],
    [],
    NOW,
    summarizeBy({}),
  );
  expect(view.tasks[0].waitsFor).toEqual([]);
  expect(view.tasks[1].waitsFor).toEqual([]);
  expect(view.tasks[2].waitsFor).toEqual(["two"]);
  expect(view.tasks[2].role).toBe("qa");
  expect(view.tasks[2].dependsOn).toEqual(["one", "two"]);
});

test("a task of a finished plan with no events is skipped and waits for nothing", () => {
  const plan: ParsedPlan = {
    id: PLAN_ID,
    trace: TRACE,
    round: 1,
    tasks: [
      { id: "one", role: "implement", pair: "review", dependsOn: [] },
      { id: "two", role: "implement", pair: "review", dependsOn: ["one"] },
    ],
  };
  const view = buildPlanView(
    plan,
    false,
    [startEvent("one", 1), endEvent("one", 1, { state: "done", ok: true })],
    [],
    NOW,
    summarizeBy({}),
  );
  const skipped = view.tasks[1];
  expect(skipped.skipped).toBe(true);
  expect(skipped.waitsFor).toEqual([]);
  expect(skipped.implementer.state).toBe("waiting");
  expect(skipped.reviewer?.state).toBe("waiting");
  expect(view.tasks[0].skipped).toBe(false);
});

test("a task without a pair has no reviewer lane", () => {
  const plan: ParsedPlan = {
    id: PLAN_ID,
    trace: TRACE,
    round: 1,
    tasks: [{ id: "one", role: "implement", pair: null, dependsOn: [] }],
  };
  const view = buildPlanView(
    plan,
    true,
    [startEvent("one", 1)],
    [],
    NOW,
    summarizeBy({}),
  );
  expect(view.tasks[0].reviewer).toBeNull();
  expect(view.tasks[0].pair).toBeNull();
});

test("done counts the tasks whose latest task.end is done", () => {
  const plan: ParsedPlan = {
    id: PLAN_ID,
    trace: TRACE,
    round: 1,
    tasks: [
      { id: "one", role: "implement", pair: null, dependsOn: [] },
      { id: "two", role: "implement", pair: null, dependsOn: [] },
    ],
  };
  const view = buildPlanView(
    plan,
    false,
    [
      startEvent("one", 1),
      endEvent("one", 1, { state: "done", ok: true }),
      startEvent("two", 1),
      endEvent("two", 1, { state: "done", ok: true }),
      endEvent("two", 2, { state: "failed", ok: false }),
    ],
    [],
    NOW,
    summarizeBy({}),
  );
  expect(view.done).toBe(1);
  expect(view.total).toBe(2);
  expect(view.state).toBe("done");
  expect(view.gate).toBeNull();
});

test("the plan state and gate follow running and the plan.end event", () => {
  const planEnd = [planEndEvent({ gate_pass: true })];
  const pass = buildPlanView(PAIR, false, planEnd, [], NOW, summarizeBy({}));
  expect(pass.state).toBe("done");
  expect(pass.gate).toBe("pass");

  const fail = buildPlanView(
    PAIR,
    false,
    [planEndEvent({ gate_pass: false })],
    [],
    NOW,
    summarizeBy({}),
  );
  expect(fail.state).toBe("failed");
  expect(fail.gate).toBe("fail");

  const running = buildPlanView(PAIR, true, planEnd, [], NOW, summarizeBy({}));
  expect(running.state).toBe("running");
  expect(running.gate).toBe("pass");

  const noEnd = buildPlanView(PAIR, false, [], [], NOW, summarizeBy({}));
  expect(noEnd.state).toBe("done");
  expect(noEnd.gate).toBeNull();

  expect(pass.id).toBe(PLAN_ID);
  expect(pass.trace).toBe(TRACE);
  expect(pass.round).toBe(1);
});
