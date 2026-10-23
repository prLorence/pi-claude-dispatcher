import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Attempt, Lane, LaneState, PlanView, ReviewResult, TaskRow } from "../shared/types";
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
