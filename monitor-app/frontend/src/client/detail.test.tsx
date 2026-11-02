import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  AgentSession,
  Attempt,
  Lane,
  MonitorState,
  PlanView,
  RepoView,
  TaskRow,
} from "../shared/types";
import { Detail } from "./Detail";

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
    decider: null,
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
    audit: null,
    ...over,
  };
}

function repo(over: Partial<RepoView> = {}): RepoView {
  return {
    name: "pi-plan-dispatch",
    active: true,
    plan: plan(),
    message: null,
    startedAt: "2026-10-23T12:00:00.000Z",
    lastActivity: "2026-10-23T12:05:00.000Z",
    ...over,
  };
}

function state(over: Partial<MonitorState> = {}): MonitorState {
  return {
    repos: [repo()],
    message: null,
    now: "2026-10-23T12:00:00.000Z",
    ...over,
  };
}

function agent(over: Partial<AgentSession> = {}): AgentSession {
  return {
    agent: "omp",
    id: "agent-session-1",
    title: "Refactor the parser",
    model: "claude-sonnet-4",
    cwd: "/repos/pi-plan-dispatch",
    group: "pi-plan-dispatch",
    startedAt: "2026-10-23T12:00:00.000Z",
    mtimeMs: 1760000000000,
    live: true,
    ended: false,
    tokens: 4200,
    cost: 0.0123,
    lastTool: "edit sessions.go",
    thinking: "medium",
    ...over,
  };
}

const taskSelection = {
  kind: "task" as const,
  repo: "pi-plan-dispatch",
  planId: "20261023-1200-demo-r1",
  attemptId: "p1.t1.a1",
};

test("nothing selected says what to click and renders no transcript", () => {
  const html = renderToStaticMarkup(<Detail state={state()} selection={null} />);
  expect(html).toContain("Select a task or an agent session to read it here");
  expect(html).not.toContain('class="transcript"');
  expect(html).not.toContain('class="detail-head"');
});

test("a task attempt shows its header numbers and the transcript", () => {
  const html = renderToStaticMarkup(<Detail state={state()} selection={taskSelection} />);
  expect(html).toContain('class="detail-head"');
  expect(html).toContain('class="detail-task">t1<');
  expect(html).toContain('class="detail-attempt">a1<');
  expect(html).toContain("role implement");
  expect(html).toContain("model deepseek-v4.1-flash");
  expect(html).toContain("thinking low");
  expect(html).toContain("tokens 1.5k");
  expect(html).toContain("cost $0.0020");
  expect(html).toContain("state live");
  expect(html).toContain("elapsed 12s");
});

test("an attempt that is not in the state says so", () => {
  const html = renderToStaticMarkup(
    <Detail
      state={state()}
      selection={{ ...taskSelection, attemptId: "p1.t1.a9" }}
    />,
  );
  expect(html).toContain("The selected attempt is not in the current state");
  expect(html).not.toContain('class="detail-head"');
  expect(html).not.toContain('class="transcript"');
});

test("the transcript is rendered under the task header", () => {
  const html = renderToStaticMarkup(<Detail state={state()} selection={taskSelection} />);
  expect(html).toContain('class="transcript"');
  expect(html).toContain('class="transcript-head">p1.t1.a1<');
  expect(html.indexOf('class="detail-head"')).toBeLessThan(
    html.indexOf('class="transcript-head"'),
  );
});

test("an agent session shows its header and its transcript", () => {
  const html = renderToStaticMarkup(
    <Detail
      state={state()}
      selection={{ kind: "agent", agent: "omp", group: "pi-plan-dispatch", id: "agent-session-1" }}
      agent={agent()}
    />,
  );
  expect(html).toContain("Refactor the parser");
  expect(html).toContain('class="detail-agent">omp<');
  expect(html).toContain("model claude-sonnet-4");
  expect(html).toContain("thinking medium");
  expect(html).toContain("tokens 4.2k");
  expect(html).toContain("cost $0.0123");
  expect(html).toContain(">live<");
  expect(html).toContain("/repos/pi-plan-dispatch");
  expect(html).toContain('class="transcript-head">agent-session-1<');
});
