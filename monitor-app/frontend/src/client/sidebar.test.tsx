import { expect, test } from "bun:test";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  AgentGroup,
  AgentSession,
  Attempt,
  Lane,
  MonitorState,
  PlanView,
  RepoView,
  ReviewResult,
  TaskRow,
} from "../shared/types";
import { Sidebar } from "./Sidebar";

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

function render(
  value: MonitorState,
  selection: Parameters<typeof Sidebar>[0]["selection"] = null,
  expanded: Record<string, boolean> = {},
  agents: AgentGroup[] = [],
  onSelectAgent?: (agent: "omp" | "pi", group: string, id: string) => void,
): string {
  return renderToStaticMarkup(
    <Sidebar
      state={value}
      selection={selection}
      expanded={expanded}
      onToggle={noop}
      onSelectTask={noop}
      agents={agents}
      onSelectAgent={onSelectAgent}
    />,
  );
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// Static markup cannot click, and the frontend tests run without a DOM, so the click test walks
// the element tree of the function components (none of them uses a hook) and calls the handler.
function collectButtons(
  node: ReactNode,
  out: ReactElement<{ onClick?: () => void }>[],
): void {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (typeof node === "string" || typeof node === "number") return;
  if (Array.isArray(node)) {
    for (const child of node) collectButtons(child, out);
    return;
  }
  const element = node as ReactElement<Record<string, unknown>>;
  const type = element.type as unknown;
  if (typeof type === "function") {
    const renderNode = type as (props: Record<string, unknown>) => ReactNode;
    collectButtons(renderNode(element.props), out);
    return;
  }
  if (type === "button") {
    out.push(element as ReactElement<{ onClick?: () => void }>);
  }
  collectButtons(element.props.children as ReactNode, out);
}

test("the sidebar renders an expanded active repo and an idle repo behind its strip", () => {
  const html = render(
    state({
      repos: [
        repo({ name: "alpha", active: true }),
        repo({
          name: "beta",
          active: false,
          plan: plan({ id: "20261024-0900-other-r1", state: "done", gate: "pass" }),
        }),
      ],
    }),
  );
  expect(html).toContain('class="sidebar"');
  expect(html).toContain('class="repo-section repo-active"');
  expect(html).toContain('class="repo-section repo-idle"');
  expect(html).toContain('class="repo-live"');
  expect(html).toContain('class="repo-strip"');
  expect(html).toContain('aria-expanded="false"');
  expect(count(html, 'class="board"')).toBe(1);
  expect(html).toContain("20261024-0900-other-r1");
});

test("an idle repo opens its tasks when the expanded map says so", () => {
  const html = render(
    state({
      repos: [
        repo({ name: "alpha", active: true }),
        repo({ name: "beta", active: false, plan: plan({ state: "done", gate: "pass" }) }),
      ],
    }),
    null,
    { beta: true },
  );
  expect(html).toContain('aria-expanded="true"');
  expect(count(html, 'class="board"')).toBe(2);
});

test("a repo with no plan shows its message and no task list", () => {
  const html = render(
    state({
      repos: [repo({ active: false, plan: null, message: "folder cannot be read" })],
    }),
  );
  expect(html).toContain("folder cannot be read");
  expect(html).not.toContain('class="board"');
  expect(html).not.toContain('class="repo-strip"');
});

test("a waiting task and a skipped task are marked in the list", () => {
  const html = render(
    state({
      repos: [
        repo({
          plan: plan({
            tasks: [
              task({ id: "t1" }),
              task({ id: "t2", waitsFor: ["t1"], implementer: lane([]) }),
              task({ id: "t3", skipped: true }),
            ],
          }),
        }),
      ],
    }),
  );
  expect(html).toContain("waits for t1");
  expect(html).toContain("badge badge-skipped");
  expect(html).toContain("badge badge-waiting");
  expect(count(html, 'class="task-row"')).toBe(3);
});

test("each attempt of the implementer and reviewer lanes is a small button", () => {
  const review: ReviewResult = { verdict: "approve", findings: 0, failed: false, text: "ok" };
  const html = render(
    state({
      repos: [
        repo({
          plan: plan({
            tasks: [
              task({
                implementer: lane([
                  attempt(),
                  attempt({ id: "p1.t1.a2", label: "a2", state: "done" }),
                ]),
                reviewer: lane([
                  attempt({
                    id: "p1.t1.review1.a1",
                    label: "r1",
                    state: "done",
                    review,
                  }),
                ]),
              }),
            ],
          }),
        }),
      ],
    }),
  );
  expect(html).toContain('class="attempt-button attempt-implementer attempt-live"');
  expect(html).toContain('class="attempt-button attempt-implementer attempt-done"');
  expect(html).toContain('class="attempt-button attempt-reviewer attempt-done"');
  expect(html).toContain(">a1<");
  expect(html).toContain(">a2<");
  expect(html).toContain(">r1<");
  expect(html).toContain("model deepseek-v4.1-flash");
  expect(html).toContain("12s elapsed");
  expect(html).toContain("verdict verdict-approve");
  expect(html).toContain("findings 0");
});

test("the selected attempt is marked with aria-current", () => {
  const html = render(
    state({
      repos: [
        repo({ name: "alpha", active: true }),
        repo({ name: "beta", active: true }),
      ],
    }),
    { kind: "task", repo: "beta", planId: "20261023-1200-demo-r1", attemptId: "p1.t1.a1" },
  );
  expect(count(html, 'aria-current="true"')).toBe(1);
  expect(count(html, 'aria-pressed="true"')).toBe(1);
  expect(count(html, "selected")).toBe(1);
});

test("an agent selection marks no task attempt", () => {
  const html = render(state(), { kind: "agent", agent: "omp", group: "pi-plan-dispatch", id: "s1" });
  expect(html).not.toContain('aria-current="true"');
});

test("clicking an attempt button passes repo, plan and attempt to onSelectTask", () => {
  const calls: Array<[string, string, string]> = [];
  const tree = Sidebar({
    state: state({ repos: [repo({ name: "alpha" })] }),
    selection: null,
    expanded: {},
    onToggle: noop,
    onSelectTask: (repoName, planId, attemptId) => {
      calls.push([repoName, planId, attemptId]);
    },
  });
  const buttons: ReactElement<{ onClick?: () => void }>[] = [];
  collectButtons(tree, buttons);
  expect(buttons.length).toBe(1);
  buttons[0].props.onClick?.();
  expect(calls).toEqual([["alpha", "20261023-1200-demo-r1", "p1.t1.a1"]]);
});

test("without agents the sidebar shows no agents group and no other sessions", () => {
  const html = render(state());
  expect(html).not.toContain('class="agents-group"');
  expect(html).not.toContain("Other sessions");
});

test("a repo with sessions gets an Agents group with one row per session", () => {
  const html = render(state({ repos: [repo({ name: "alpha" })] }), null, {}, [
    agentGroup({ name: "alpha", sessions: [agentSession({ title: "Fix the parser" })] }),
  ]);
  expect(html).toContain('class="agents-group"');
  expect(html).toContain('class="agents-heading">Agents</h3>');
  expect(html).toContain('class="agent-badge agent-badge-omp"');
  expect(html).toContain("Fix the parser");
  expect(html).not.toContain("Other sessions");
});

test("sessions of a group that matches no repo appear under Other sessions", () => {
  const html = render(state({ repos: [repo({ name: "alpha" })] }), null, {}, [
    agentGroup({ name: "alpha", sessions: [agentSession({ id: "a-session" })] }),
    agentGroup({
      name: "loose-folder",
      sessions: [agentSession({ id: "loose-session", agent: "pi", title: "Elsewhere" })],
    }),
  ]);
  expect(html).toContain("Other sessions");
  expect(html).toContain('<h3 class="agents-heading">loose-folder</h3>');
  expect(html).toContain("Elsewhere");
  expect(html).toContain('class="agent-badge agent-badge-pi"');
});

test("clicking an agent row passes agent, group and id to onSelectAgent", () => {
  const calls: Array<[string, string, string]> = [];
  const tree = Sidebar({
    state: state({ repos: [repo({ name: "alpha" })] }),
    selection: null,
    expanded: {},
    onToggle: noop,
    onSelectTask: noop,
    agents: [agentGroup({ name: "alpha", sessions: [agentSession({ id: "s9", group: "alpha" })] })],
    onSelectAgent: (agent, group, id) => {
      calls.push([agent, group, id]);
    },
  });
  const buttons: ReactElement<{ onClick?: () => void }>[] = [];
  collectButtons(tree, buttons);
  expect(buttons.length).toBe(2);
  buttons[1].props.onClick?.();
  expect(calls).toEqual([["omp", "alpha", "s9"]]);
});
