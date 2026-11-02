import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Attempt, DeciderTaskView, Lane, LaneState, PlanView, ReviewResult, TaskRow } from "../shared/types";
import { Board } from "./Board";
import { LaneCell } from "./LaneCell";

function attempt(over: Partial<Attempt> = {}): Attempt {
  return {
    id: "p1.t1.a1",
    label: "a1",
    state: "live",
    model: "deepseek-v4.1-flash",
    thinking: "low",
    startedAt: "2026-10-23T12:00:00.000Z",
    elapsedS: 12,
    tokens: 1500,
    cost: 0.002,
    lastTool: "edit core.ts",
    error: null,
    hasSession: true,
    review: null,
    ...over,
  };
}

function lane(attempts: Attempt[]): Lane {
  return { state: attempts.length === 0 ? "waiting" : attempts[attempts.length - 1].state, attempts };
}

function task(over: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "t1",
    role: "implement",
    pair: null,
    dependsOn: [],
    waitsFor: [],
    skipped: false,
    implementer: lane([attempt()]),
    reviewer: null,
    decider: null,
    ...over,
  };
}

function plan(over: Partial<PlanView> = {}): PlanView {
  return {
    id: "20261023-1458-monitor-r1",
    trace: "20261023-1458-monitor",
    round: 1,
    state: "running",
    gate: null,
    done: 0,
    total: 1,
    tasks: [task()],
    audit: null,
    ...over,
  };
}

const noop = (): void => {};

function renderPlan(value: PlanView): string {
  return renderToStaticMarkup(<Board plan={value} selectedId={null} onSelect={noop} />);
}

test("each state renders its badge", () => {
  const states: LaneState[] = ["waiting", "live", "done", "failed", "stalled"];
  for (const state of states) {
    const html = renderToStaticMarkup(
      <LaneCell
        lane={lane([attempt({ state })])}
        kind="implementer"
        selectedId={null}
        onSelect={noop}
      />,
    );
    expect(html).toContain(`badge badge-${state}`);
    expect(html).toContain(`>${state}<`);
  }
});

test("an empty lane shows the waiting badge", () => {
  const html = renderToStaticMarkup(
    <LaneCell lane={{ state: "waiting", attempts: [] }} kind="implementer" selectedId={null} onSelect={noop} />,
  );
  expect(html).toContain("badge badge-waiting");
  expect(html).not.toContain("switcher");
});

test("a null lane renders a dash cell", () => {
  const html = renderToStaticMarkup(
    <LaneCell lane={null} kind="reviewer" selectedId={null} onSelect={noop} />,
  );
  expect(html).toContain("lane lane-reviewer");
  expect(html).toContain("lane-dash");
  expect(html).not.toContain("badge");
});

test("the switcher appears only with two attempts", () => {
  const single = renderToStaticMarkup(
    <LaneCell lane={lane([attempt()])} kind="implementer" selectedId={null} onSelect={noop} />,
  );
  expect(single).not.toContain("switcher");

  const double = renderToStaticMarkup(
    <LaneCell
      lane={lane([attempt(), attempt({ id: "p1.t1.a2", label: "a2", state: "done" })])}
      kind="implementer"
      selectedId={null}
      onSelect={noop}
    />,
  );
  expect(double).toContain("switcher");
  expect(double).toContain('aria-pressed="true">a2<');
  expect(double).toContain('aria-pressed="false">a1<');
});

test("a pinned approve verdict is shown", () => {
  const review: ReviewResult = { verdict: "approve", findings: 0, failed: false, text: "ok" };
  const html = renderToStaticMarkup(
    <LaneCell
      lane={lane([attempt({ label: "r1", state: "done", id: "p1.t1.review1.a1", review })])}
      kind="reviewer"
      selectedId={null}
      onSelect={noop}
    />,
  );
  expect(html).toContain("verdict verdict-approve");
  expect(html).toContain("findings 0");
  expect(html).not.toContain("review failed");
});

test("a failed review shows the badge and never the word approve", () => {
  const review: ReviewResult = { verdict: "approve", findings: 1, failed: true, text: null };
  const html = renderToStaticMarkup(
    <LaneCell
      lane={lane([attempt({ label: "r1", state: "failed", id: "p1.t1.review1.a1", review })])}
      kind="reviewer"
      selectedId={null}
      onSelect={noop}
    />,
  );
  expect(html).toContain("badge badge-failed");
  expect(html).toContain("review failed");
  expect(html.toLowerCase()).not.toContain("approve");
});

test("the waits for note and the skipped badge are rendered", () => {
  const html = renderPlan(
    plan({
      tasks: [
        task({ id: "t2", waitsFor: ["a", "b"], skipped: true }),
      ],
    }),
  );
  expect(html).toContain("waits for a, b");
  expect(html).toContain("skipped");
});

test("the header shows the plan id, state, count and gate", () => {
  const html = renderPlan(plan({ state: "done", gate: "pass", done: 1, total: 2 }));
  expect(html).toContain("plan-header");
  expect(html).toContain("20261023-1458-monitor-r1");
  expect(html).toContain("1/2 tasks");
  expect(html).toContain("gate pass");
});

test("a task without a pair renders the reviewer dash cell", () => {
  const html = renderPlan(plan());
  expect(html).toContain("lane lane-reviewer");
  expect(html).toContain("lane lane-implementer");
});

test("a task id is escaped", () => {
  const html = renderPlan(plan({ tasks: [task({ id: "<img onerror=x>" })] }));
  expect(html).toContain("&lt;img");
  expect(html).not.toContain("<img");
});

const deciderView = (over: Partial<DeciderTaskView> = {}): DeciderTaskView => ({
  suggested: "high",
  probabilities: { low: 0.1, high: 0.8, max: 0.1 },
  confidence: 0.845,
  complexity: 0.5,
  ran: "high",
  ...over,
});

test("the decider badge is plain when the level matches", () => {
  const html = renderToStaticMarkup(
    <LaneCell
      lane={lane([attempt()])}
      kind="implementer"
      selectedId={null}
      onSelect={noop}
      decider={deciderView()}
    />,
  );
  expect(html).toContain("decider-badge");
  expect(html).toContain("decider: high - ran: high");
  expect(html).not.toContain("decider-diff");
});

test("the decider badge is highlighted when the level differs", () => {
  const html = renderToStaticMarkup(
    <LaneCell
      lane={lane([attempt()])}
      kind="implementer"
      selectedId={null}
      onSelect={noop}
      decider={deciderView({ ran: "low" })}
    />,
  );
  expect(html).toContain("decider-badge decider-diff");
  expect(html).toContain("decider: high - ran: low");
});

test("the decider badge shows a dash before the task starts, from an empty lane", () => {
  const html = renderToStaticMarkup(
    <LaneCell
      lane={{ state: "waiting", attempts: [] }}
      kind="implementer"
      selectedId={null}
      onSelect={noop}
      decider={deciderView({ ran: null })}
    />,
  );
  expect(html).toContain("badge badge-waiting");
  expect(html).toContain("decider: high - ran: -");
  expect(html).not.toContain("decider-diff");
});

test("the decider badge shows a dash before the task starts, from a lane with an attempt", () => {
  const html = renderToStaticMarkup(
    <LaneCell
      lane={lane([attempt({ state: "waiting" })])}
      kind="implementer"
      selectedId={null}
      onSelect={noop}
      decider={deciderView({ ran: null })}
    />,
  );
  expect(html).toContain("decider: high - ran: -");
  expect(html).not.toContain("decider-diff");
});

test("no decider renders no badge", () => {
  const html = renderToStaticMarkup(
    <LaneCell lane={lane([attempt()])} kind="implementer" selectedId={null} onSelect={noop} decider={null} />,
  );
  expect(html).not.toContain("decider-badge");
});

test("a reviewer cell never renders the decider badge", () => {
  const html = renderToStaticMarkup(
    <LaneCell
      lane={lane([attempt({ label: "r1", id: "p1.t1.review1.a1" })])}
      kind="reviewer"
      selectedId={null}
      onSelect={noop}
      decider={deciderView()}
    />,
  );
  expect(html).not.toContain("decider-badge");
});

test("the decider title lists probabilities, confidence and complexity", () => {
  const html = renderToStaticMarkup(
    <LaneCell
      lane={lane([attempt()])}
      kind="implementer"
      selectedId={null}
      onSelect={noop}
      decider={deciderView()}
    />,
  );
  expect(html).toContain("low 0.10, high 0.80, max 0.10");
  expect(html).toContain("confidence: 0.84");
  expect(html).toContain("complexity: 0.50");
});

test("the board passes the task decider to the implementer lane", () => {
  const html = renderPlan(plan({ tasks: [task({ decider: deciderView({ ran: "low" }) })] }));
  expect(html).toContain("decider: high - ran: low");
  expect(html).toContain("decider-diff");
});

test("the plan header shows the audit line with its findings", () => {
  const html = renderPlan(
    plan({
      audit: {
        proposal: "fix",
        aggregate: 0.627,
        verdict: "fail",
        auditRound: 1,
        findings: [
          { id: "f1", severity: "major", p: 0.5 },
          { id: "f2", severity: "minor", p: 0.125 },
        ],
      },
    }),
  );
  expect(html).toContain("plan-audit");
  expect(html).toContain("decider audit: fix (0.63)");
  expect(html).toContain("f1 major 0.50");
  expect(html).toContain("f2 minor 0.13");
});

test("no audit line when the plan has no audit", () => {
  const html = renderPlan(plan({ audit: null }));
  expect(html).not.toContain("plan-audit");
});

test("a hostile finding id is escaped", () => {
  const html = renderPlan(
    plan({
      audit: {
        proposal: "hold",
        aggregate: 0.1,
        verdict: "fail",
        auditRound: 2,
        findings: [{ id: "<b>x</b>", severity: "blocker", p: 1 }],
      },
    }),
  );
  expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
  expect(html).not.toContain("<b>x</b>");
});
