import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Attempt, Lane, MonitorState, PlanView, TaskRow } from "../shared/types";
import { AppView } from "./App";

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
  return {
    state: attempts.length === 0 ? "waiting" : attempts[attempts.length - 1].state,
    attempts,
  };
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
    id: "20261023-1200-demo-r1",
    trace: "20261023-1200-demo",
    round: 1,
    state: "running",
    gate: null,
    done: 0,
    total: 1,
    tasks: [task()],
    ...over,
  };
}

function render(props: Parameters<typeof AppView>[0]): string {
  return renderToStaticMarkup(<AppView {...props} />);
}

const noop = (): void => {};

test("shows a loading line while the first state request is open", () => {
  const html = render({ state: null, error: null, selectedId: null, onSelect: noop });
  expect(html).toContain("Loading");
  expect(html).not.toContain("Cannot reach the monitor server");
});

test("shows the error banner when the request failed", () => {
  const html = render({
    state: null,
    error: "Cannot reach the monitor server",
    selectedId: null,
    onSelect: noop,
  });
  expect(html).toContain("banner-error");
  expect(html).toContain("Cannot reach the monitor server");
});

test("shows the state message when there is no plan", () => {
  const state: MonitorState = { plan: null, message: "Pi is not running", now: "2026-10-23T12:00:00.000Z" };
  const html = render({ state, error: null, selectedId: null, onSelect: noop });
  expect(html).toContain("Pi is not running");
  expect(html).not.toContain("board");
});

test("falls back to a plain message when the state has none", () => {
  const state: MonitorState = { plan: null, message: null, now: "2026-10-23T12:00:00.000Z" };
  const html = render({ state, error: null, selectedId: null, onSelect: noop });
  expect(html).toContain("No plan to show");
});

test("renders the board and the transcript placeholder for a plan", () => {
  const state: MonitorState = { plan: plan(), message: null, now: "2026-10-23T12:00:00.000Z" };
  const html = render({ state, error: null, selectedId: null, onSelect: noop });
  expect(html).toContain("20261023-1200-demo-r1");
  expect(html).toContain("t1");
  expect(html).toContain("0/1 tasks");
  expect(html).toContain("transcript");
  expect(html).toContain("Select a lane to read its transcript");
  expect(html).not.toContain("Loading");
});

test("marks the selected lane", () => {
  const state: MonitorState = { plan: plan(), message: null, now: "2026-10-23T12:00:00.000Z" };
  const html = render({ state, error: null, selectedId: "p1.t1.a1", onSelect: noop });
  expect(html).toContain("selected");
});
