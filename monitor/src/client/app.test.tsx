import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentSession, Attempt, Lane, MonitorState, PlanView, RepoView, TaskRow } from "../shared/types";
import { AppView, isEmbedded } from "./App";

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

const noop = (): void => {};

function render(props: Partial<Parameters<typeof AppView>[0]> = {}): string {
  return renderToStaticMarkup(
    <AppView
      state={null}
      error={null}
      selection={null}
      expanded={{}}
      onToggle={noop}
      onSelect={noop}
      {...props}
    />,
  );
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

test("shows a loading line while the first state request is open", () => {
  const html = render();
  expect(html).toContain("Loading");
  expect(html).not.toContain("Cannot reach the monitor server");
  expect(html).not.toContain("transcript");
});

test("shows the error banner when the request failed", () => {
  const html = render({ error: "Cannot reach the monitor server" });
  expect(html).toContain("banner-error");
  expect(html).toContain("Cannot reach the monitor server");
});

test("shows the configuration message when the state has one", () => {
  const html = render({ state: state({ message: "3 more repos ignored (limit 24)" }) });
  expect(html).toContain("3 more repos ignored (limit 24)");
  expect(html).toContain("pi-plan-dispatch");
});

test("shows a muted line when no repos are configured", () => {
  const html = render({ state: state({ repos: [] }) });
  expect(html).toContain("No repos configured");
  expect(html).not.toContain("repo-section");
  expect(html).not.toContain("transcript");
});

test("renders the repos in the given order, the active board and the idle strip", () => {
  const html = render({
    state: state({
      repos: [
        repo({ name: "alpha", active: true }),
        repo({
          name: "beta",
          active: false,
          plan: plan({ id: "20261024-0900-other-r1", state: "done", gate: "pass" }),
        }),
      ],
    }),
  });
  expect(html.indexOf("alpha")).toBeLessThan(html.indexOf("beta"));
  expect(html).toContain('class="repo-section repo-active"');
  expect(html).toContain('class="repo-section repo-idle"');
  expect(html).toContain('class="repo-strip"');
  expect(html).toContain('aria-expanded="false"');
  expect(count(html, 'class="board"')).toBe(1);
  expect(html).toContain("20261024-0900-other-r1");
});

test("an expanded idle repo shows its board", () => {
  const html = render({
    state: state({
      repos: [
        repo({ name: "alpha", active: true }),
        repo({ name: "beta", active: false, plan: plan({ state: "done", gate: "pass" }) }),
      ],
    }),
    expanded: { beta: true },
  });
  expect(html).toContain('aria-expanded="true"');
  expect(count(html, 'class="board"')).toBe(2);
});

test("an active repo renders its board without a strip", () => {
  const html = render({ state: state(), expanded: { "pi-plan-dispatch": false } });
  expect(html).toContain('class="repo-section repo-active"');
  expect(html).toContain('class="board"');
  expect(html).not.toContain('class="repo-strip"');
});

test("marks only the selected repo's lane", () => {
  const html = render({
    state: state({
      repos: [
        repo({ name: "alpha", active: true }),
        repo({ name: "beta", active: true }),
      ],
    }),
    selection: { repo: "beta", planId: "20261023-1200-demo-r1", attemptId: "p1.t1.a1" },
  });
  expect(count(html, "selected")).toBe(1);
  expect(count(html, 'aria-pressed="true"')).toBe(1);
});

test("the selection names the transcript and there is only one", () => {
  const html = render({
    state: state({
      repos: [
        repo({ name: "alpha", active: true }),
        repo({ name: "beta", active: true }),
      ],
    }),
    selection: { repo: "beta", planId: "20261023-1200-demo-r1", attemptId: "p1.t1.a1" },
  });
  expect(count(html, 'class="transcript"')).toBe(1);
  expect(html).toContain('class="transcript-head"');
});

test("an empty selection still shows one transcript placeholder", () => {
  const html = render({ state: state() });
  expect(count(html, 'class="transcript"')).toBe(1);
  expect(html).toContain("Select a lane to read its transcript");
  expect(html).not.toContain('class="transcript-head"');
});

test("a repo with no plan shows its message", () => {
  const html = render({
    state: state({
      repos: [repo({ name: "alpha", active: false, plan: null, message: "folder cannot be read" })],
    }),
  });
  expect(html).toContain("folder cannot be read");
  expect(html).not.toContain('class="board"');
});

test("an error before the first state does not also render the skeleton", () => {
  const html = render({ state: null, error: "Cannot reach the monitor server" });
  expect(html).toContain("banner-error");
  expect(html).not.toContain("skeleton");
});

test("embed mode requires the exact ?embed=1 value", () => {
  expect(isEmbedded("?embed=1")).toBe(true);
  expect(isEmbedded("?embed=0")).toBe(false);
  expect(isEmbedded("?theme=dark")).toBe(false);
});

test("previews the newest idle plan when nothing is running", () => {
  const html = render({
    state: state({
      repos: [
        repo({ name: "alpha", active: false, plan: plan({ state: "done", gate: "pass" }) }),
        repo({ name: "beta", active: false, plan: plan({ id: "20261024-0900-other-r1" }) }),
      ],
    }),
  });
  expect(count(html, 'class="board"')).toBe(1);
  expect(html).toContain('aria-expanded="true"');
  expect(html.indexOf("alpha")).toBeLessThan(html.indexOf("beta"));
});

function agent(over: Partial<AgentSession> = {}): AgentSession {
  return {
    id: "omp-1",
    file: "/tmp/omp-1.jsonl",
    mtimeMs: Date.now(),
    live: true,
    ended: false,
    model: "opencode-go/beam-free",
    prompt: "Review the monitor change",
    tokens: 1200,
    cost: 0.01,
    agent: "omp",
    ...over,
  };
}

test("shows a running omp agent", () => {
  const html = render({
    state: state(),
    agents: { groups: [{ agent: "omp", sessions: [agent()] }], scope: "all", now: new Date().toISOString() },
  });
  expect(html).toContain("Agents");
  expect(html).toContain("omp");
  expect(html).toContain("1 running");
  expect(html).toContain("Review the monitor change");
});

test("does not show ended agents as running", () => {
  const html = render({
    state: state(),
    agents: { groups: [{ agent: "omp", sessions: [agent({ live: false, ended: true })] }], scope: "all", now: new Date().toISOString() },
  });
  expect(html).not.toContain("1 running");
});
