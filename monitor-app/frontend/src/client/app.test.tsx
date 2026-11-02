import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  AgentGroup,
  AgentSession,
  Attempt,
  Lane,
  MonitorState,
  PlanView,
  RepoView,
  Settings,
  TaskRow,
} from "../shared/types";
import { AppView, loadSnapshot, reconcileSelection, shouldFetchAgents } from "./App";

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
  expect(html).toContain('class="panes"');
  expect(html).toContain('class="sidebar"');
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
    selection: {
      kind: "task",
      repo: "beta",
      planId: "20261023-1200-demo-r1",
      attemptId: "p1.t1.a1",
    },
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
    selection: {
      kind: "task",
      repo: "beta",
      planId: "20261023-1200-demo-r1",
      attemptId: "p1.t1.a1",
    },
  });
  expect(count(html, 'class="transcript"')).toBe(1);
  expect(html).toContain('class="transcript-head"');
});

test("an empty selection shows the detail placeholder and no transcript", () => {
  const html = render({ state: state() });
  expect(count(html, 'class="transcript"')).toBe(0);
  expect(html).toContain("Select a task or an agent session to read it here");
  expect(html).not.toContain('class="transcript-head"');
});

test("reconcileSelection keeps null as null", () => {
  expect(reconcileSelection(null, state())).toBeNull();
});

test("reconcileSelection keeps a task selection while its repo and plan exist", () => {
  const selection = {
    kind: "task" as const,
    repo: "pi-plan-dispatch",
    planId: "20261023-1200-demo-r1",
    attemptId: "p1.t1.a1",
  };
  expect(reconcileSelection(selection, state())).toEqual(selection);
});

test("reconcileSelection drops a task selection when its repo is gone", () => {
  const selection = {
    kind: "task" as const,
    repo: "pi-plan-dispatch",
    planId: "20261023-1200-demo-r1",
    attemptId: "p1.t1.a1",
  };
  expect(reconcileSelection(selection, state({ repos: [repo({ name: "other" })] }))).toBeNull();
});

test("reconcileSelection drops a task selection when the plan id changed", () => {
  const selection = {
    kind: "task" as const,
    repo: "pi-plan-dispatch",
    planId: "20261023-1200-demo-r1",
    attemptId: "p1.t1.a1",
  };
  const next = state({ repos: [repo({ plan: plan({ id: "20261024-0900-other-r1" }) })] });
  expect(reconcileSelection(selection, next)).toBeNull();
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

function settings(over: Partial<Settings> = {}): Settings {
  return { ompSessions: false, piSessions: false, scope: "repos", ...over };
}

function agentSession(over: Partial<AgentSession> = {}): AgentSession {
  return {
    agent: "omp",
    id: "s1",
    title: "Fix the parser",
    model: "deepseek-v4.1-flash",
    cwd: "/work/pi-plan-dispatch",
    group: "pi-plan-dispatch",
    startedAt: "2026-10-23T11:00:00.000Z",
    mtimeMs: Date.parse("2026-10-23T11:55:00.000Z"),
    live: true,
    ended: false,
    tokens: 1200,
    cost: 0.05,
    lastTool: "edit core.ts",
    thinking: "high",
    ...over,
  };
}

function agentGroup(over: Partial<AgentGroup> = {}): AgentGroup {
  return { name: "pi-plan-dispatch", sessions: [agentSession()], ...over };
}

test("the header has a Settings control and the panel is closed by default", () => {
  const html = render({ state: state(), settings: settings() });
  expect(html).toContain('class="settings-toggle-button"');
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain('class="settings-panel"');
});

test("an open settings panel renders above the panes", () => {
  const html = render({ state: state(), settings: settings(), settingsOpen: true });
  expect(html).toContain('class="settings-panel"');
  expect(html).toContain('aria-expanded="true"');
  expect(html).toContain("omp sessions");
});

test("agents passed to the view show up in the sidebar", () => {
  const html = render({ state: state(), agents: [agentGroup()] });
  expect(html).toContain('class="agent-row agent-row-omp"');
  expect(html).toContain("Fix the parser");
});

test("shouldFetchAgents is false only when both toggles are off", () => {
  expect(shouldFetchAgents(settings())).toBe(false);
  expect(shouldFetchAgents(settings({ ompSessions: true }))).toBe(true);
  expect(shouldFetchAgents(settings({ piSessions: true }))).toBe(true);
  expect(shouldFetchAgents(settings({ ompSessions: true, piSessions: true }))).toBe(true);
});

test("loadSnapshot never asks for agents when both toggles are off", async () => {
  let agentCalls = 0;
  const snapshot = await loadSnapshot({
    fetchState: async () => state(),
    fetchSettings: async () => settings(),
    fetchAgents: async () => {
      agentCalls += 1;
      return [agentGroup()];
    },
  });
  expect(agentCalls).toBe(0);
  expect(snapshot.agents).toEqual([]);
  expect(snapshot.settings).toEqual(settings());
});

test("loadSnapshot asks for agents once when a toggle is on", async () => {
  let agentCalls = 0;
  const snapshot = await loadSnapshot({
    fetchState: async () => state(),
    fetchSettings: async () => settings({ piSessions: true }),
    fetchAgents: async () => {
      agentCalls += 1;
      return [agentGroup()];
    },
  });
  expect(agentCalls).toBe(1);
  expect(snapshot.agents).toEqual([agentGroup()]);
});

test("an agent selection survives a snapshot that still lists the session", async () => {
  const selection = {
    kind: "agent" as const,
    agent: "omp" as const,
    group: "pi-plan-dispatch",
    id: "s1",
  };
  const sources = {
    fetchState: async () => state(),
    fetchSettings: async () => settings({ ompSessions: true }),
    fetchAgents: async () => [agentGroup()],
  };
  const first = await loadSnapshot(sources);
  const second = await loadSnapshot(sources);
  expect(reconcileSelection(selection, second.state, second.agents)).toEqual(selection);
  expect(reconcileSelection(selection, first.state, first.agents)).toEqual(selection);
});

test("an agent selection is cleared by a snapshot that drops the session", async () => {
  const selection = {
    kind: "agent" as const,
    agent: "omp" as const,
    group: "pi-plan-dispatch",
    id: "s1",
  };
  const snapshot = await loadSnapshot({
    fetchState: async () => state(),
    fetchSettings: async () => settings({ ompSessions: true }),
    fetchAgents: async () => [agentGroup({ sessions: [] })],
  });
  expect(reconcileSelection(selection, snapshot.state, snapshot.agents)).toBeNull();
});

test("reconcileSelection keeps an agent selection that is still listed", () => {
  const selection = {
    kind: "agent" as const,
    agent: "pi" as const,
    group: "pi-plan-dispatch",
    id: "s2",
  };
  const agents = [
    agentGroup({
      sessions: [agentSession({ agent: "pi", id: "s2" }), agentSession()],
    }),
  ];
  expect(reconcileSelection(selection, state(), agents)).toEqual(selection);
});

test("reconcileSelection clears an agent selection against an empty list", () => {
  const selection = {
    kind: "agent" as const,
    agent: "omp" as const,
    group: "pi-plan-dispatch",
    id: "s1",
  };
  expect(reconcileSelection(selection, state(), [])).toBeNull();
  expect(reconcileSelection(selection, state())).toBeNull();
});

test("reconcileSelection clears an agent selection whose id is gone from its group", () => {
  const selection = {
    kind: "agent" as const,
    agent: "omp" as const,
    group: "pi-plan-dispatch",
    id: "s1",
  };
  const agents = [agentGroup({ sessions: [agentSession({ id: "other" })] })];
  expect(reconcileSelection(selection, state(), agents)).toBeNull();
});
