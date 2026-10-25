import { test, expect } from "bun:test";
import type { PlanView } from "../shared/types.ts";
import type { TraceEvent } from "./plans.ts";
import { applyDecider } from "./decider.ts";

const PLAN_ID = "20261023-1458-monitor-r1";

function planOf(taskIds: string[]): PlanView {
  return {
    id: PLAN_ID,
    trace: "20261023-1458-monitor",
    round: 1,
    state: "done",
    gate: null,
    done: taskIds.length,
    total: taskIds.length,
    tasks: taskIds.map((id) => ({
      id,
      role: "implement",
      pair: null,
      dependsOn: [],
      waitsFor: [],
      skipped: false,
      implementer: { state: "waiting" as const, attempts: [] },
      reviewer: null,
      decider: null,
    })),
    audit: null,
  };
}

function effort(
  ts: string,
  task: string | undefined,
  data: Record<string, unknown>,
): TraceEvent {
  const event: TraceEvent = { ts, kind: "decision.effort", plan: PLAN_ID, data };
  if (task !== undefined) {
    event.task = task;
  }
  return event;
}

function start(
  ts: string,
  task: string,
  attempt: number,
  data: Record<string, unknown> = {},
): TraceEvent {
  return { ts, kind: "task.start", plan: PLAN_ID, task, attempt, data };
}

function audit(ts: string, data: Record<string, unknown>): TraceEvent {
  return { ts, kind: "decision.audit", plan: PLAN_ID, data };
}

test("no events leave every task and the plan audit null", () => {
  const view = applyDecider(planOf(["one", "two"]), []);
  expect(view.tasks[0].decider).toBeNull();
  expect(view.tasks[1].decider).toBeNull();
  expect(view.audit).toBeNull();
});

test("an effort event fills the decider of its task", () => {
  const view = applyDecider(planOf(["one"]), [
    effort("2026-10-23T10:00:00.000Z", "one", {
      task: "one",
      suggested: "high",
      probabilities: { low: 0.1, high: 0.8, max: 0.1 },
      confidence: 0.8,
      complexity: 3,
      model: "some/model",
      cost: 0.0001,
      mode: "apply",
    }),
  ]);
  expect(view.tasks[0].decider).toEqual({
    suggested: "high",
    probabilities: { low: 0.1, high: 0.8, max: 0.1 },
    confidence: 0.8,
    complexity: 3,
    ran: null,
  });
});

test("an effort event for another task leaves this task null", () => {
  const view = applyDecider(planOf(["one"]), [
    effort("2026-10-23T10:00:00.000Z", "two", {
      task: "two",
      suggested: "low",
      probabilities: {},
      confidence: 0.5,
      complexity: 1,
    }),
  ]);
  expect(view.tasks[0].decider).toBeNull();
  expect(view.audit).toBeNull();
});

test("the latest effort event of a task wins", () => {
  const view = applyDecider(planOf(["one"]), [
    effort("2026-10-23T10:00:00.000Z", "one", {
      task: "one",
      suggested: "low",
      probabilities: { low: 0.9 },
      confidence: 0.9,
      complexity: 1,
    }),
    effort("2026-10-23T09:00:00.000Z", "one", {
      task: "one",
      suggested: "max",
      probabilities: { max: 0.9 },
      confidence: 0.1,
      complexity: 9,
    }),
    effort("2026-10-23T11:00:00.000Z", "one", {
      task: "one",
      suggested: "high",
      probabilities: { high: 0.9 },
      confidence: 0.8,
      complexity: 5,
    }),
  ]);
  expect(view.tasks[0].decider?.suggested).toBe("high");
  expect(view.tasks[0].decider?.complexity).toBe(5);
});

test("ran is null before any start and the first attempt after two starts", () => {
  const before = applyDecider(planOf(["one"]), [
    effort("2026-10-23T10:00:00.000Z", "one", {
      task: "one",
      suggested: "high",
      probabilities: {},
      confidence: null,
      complexity: null,
    }),
  ]);
  expect(before.tasks[0].decider?.ran).toBeNull();

  const after = applyDecider(planOf(["one"]), [
    effort("2026-10-23T10:00:00.000Z", "one", {
      task: "one",
      suggested: "high",
      probabilities: {},
      confidence: null,
      complexity: null,
    }),
    start("2026-10-23T10:01:00.000Z", "one", 2, { thinking: "max" }),
    start("2026-10-23T10:00:30.000Z", "one", 1, { thinking: "low" }),
  ]);
  expect(after.tasks[0].decider?.ran).toBe("low");
});

test("a task without an event stays null while another has one", () => {
  const view = applyDecider(planOf(["one", "two"]), [
    effort("2026-10-23T10:00:00.000Z", "two", {
      task: "two",
      suggested: "low",
      probabilities: { low: 1 },
      confidence: 1,
      complexity: 0,
    }),
  ]);
  expect(view.tasks[0].decider).toBeNull();
  expect(view.tasks[1].decider?.suggested).toBe("low");
});

test("an effort event whose task is only in data.task is matched", () => {
  const view = applyDecider(planOf(["one"]), [
    effort("2026-10-23T10:00:00.000Z", undefined, {
      task: "one",
      suggested: "max",
      probabilities: { max: 0.7 },
      confidence: 0.7,
      complexity: 8,
    }),
  ]);
  expect(view.tasks[0].decider?.suggested).toBe("max");
});

test("an audit event fills the plan audit", () => {
  const view = applyDecider(planOf(["one"]), [
    audit("2026-10-23T10:00:00.000Z", {
      model: "some/model",
      cost: 0.002,
      audit_round: 2,
      verdict: "pass",
      proposal: "approve",
      aggregate: 0.12,
      findings: [
        { id: "f1", severity: "minor", p: 0.2 },
        { id: "f2", severity: "blocker", p: 0.9 },
      ],
    }),
  ]);
  expect(view.audit).toEqual({
    proposal: "approve",
    aggregate: 0.12,
    verdict: "pass",
    auditRound: 2,
    findings: [
      { id: "f1", severity: "minor", p: 0.2 },
      { id: "f2", severity: "blocker", p: 0.9 },
    ],
  });
  expect(view.tasks[0].decider).toBeNull();
});

test("the latest audit event wins", () => {
  const view = applyDecider(planOf(["one"]), [
    audit("2026-10-23T10:00:00.000Z", {
      audit_round: 1,
      verdict: "fail",
      proposal: "fix",
      aggregate: 0.8,
      findings: [],
    }),
    audit("2026-10-23T11:00:00.000Z", {
      audit_round: 2,
      verdict: "pass",
      proposal: "approve",
      aggregate: 0.1,
      findings: [],
    }),
    audit("2026-10-23T09:00:00.000Z", {
      audit_round: 0,
      verdict: "fail",
      proposal: "hold",
      aggregate: 0.5,
      findings: [],
    }),
  ]);
  expect(view.audit?.auditRound).toBe(2);
  expect(view.audit?.verdict).toBe("pass");
  expect(view.audit?.proposal).toBe("approve");
});

test("malformed data falls back to safe defaults", () => {
  const view = applyDecider(planOf(["one"]), [
    effort("2026-10-23T10:00:00.000Z", "one", {
      task: "one",
      suggested: "high",
      probabilities: { low: "nope", high: 0.5, max: Number.NaN },
      confidence: "wide",
      complexity: null,
    }),
    audit("2026-10-23T10:01:00.000Z", {
      audit_round: "two",
      verdict: 42,
      proposal: null,
      aggregate: "big",
      findings: [
        { id: "ok", severity: "minor", p: 0.3 },
        { id: "no-p", severity: "minor" },
        { severity: "minor", p: 0.4 },
        null,
        "text",
      ],
    }),
  ]);
  expect(view.tasks[0].decider?.probabilities).toEqual({ high: 0.5 });
  expect(view.tasks[0].decider?.confidence).toBeNull();
  expect(view.tasks[0].decider?.complexity).toBeNull();
  expect(view.audit?.aggregate).toBe(0);
  expect(view.audit?.auditRound).toBe(0);
  expect(view.audit?.verdict).toBe("unknown");
  expect(view.audit?.proposal).toBe("unknown");
  expect(view.audit?.findings).toEqual([{ id: "ok", severity: "minor", p: 0.3 }]);
});

test("an effort event with no suggested is ignored", () => {
  const view = applyDecider(planOf(["one"]), [
    effort("2026-10-23T10:00:00.000Z", "one", {
      task: "one",
      probabilities: { low: 1 },
      confidence: 1,
      complexity: 1,
    }),
  ]);
  expect(view.tasks[0].decider).toBeNull();
});

test("an empty thinking level counts as no level", () => {
  const view = applyDecider(planOf(["one"]), [
    effort("2026-10-23T10:00:00.000Z", "one", {
      task: "one",
      suggested: "low",
      probabilities: {},
      confidence: null,
      complexity: null,
    }),
    start("2026-10-23T10:01:00.000Z", "one", 1, { thinking: "" }),
  ]);
  expect(view.tasks[0].decider?.ran).toBeNull();
});

test("the input plan is not mutated", () => {
  const plan = planOf(["one"]);
  const before = JSON.parse(JSON.stringify(plan));
  const view = applyDecider(plan, [
    effort("2026-10-23T10:00:00.000Z", "one", {
      task: "one",
      suggested: "high",
      probabilities: { high: 1 },
      confidence: 1,
      complexity: 2,
    }),
    audit("2026-10-23T10:01:00.000Z", {
      audit_round: 1,
      verdict: "pass",
      proposal: "approve",
      aggregate: 0,
      findings: [],
    }),
  ]);
  expect(view).not.toBe(plan);
  expect(view.tasks[0]).not.toBe(plan.tasks[0]);
  expect(plan).toEqual(before as PlanView);
});
