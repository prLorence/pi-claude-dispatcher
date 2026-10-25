import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Attempt, Lane, PlanView, RepoView, TaskRow } from "../shared/types";
import { RepoSection } from "./RepoSection";

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
    id: "20261025-2156-monitor-multirepo-r1",
    trace: "20261025-2156-monitor-multirepo",
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
    startedAt: "2026-10-25T12:00:00.000Z",
    lastActivity: "2026-10-25T12:05:00.000Z",
    ...over,
  };
}

const noop = (): void => {};

function render(
  value: RepoView,
  expanded = false,
  onSelect: (repo: string, planId: string, attemptId: string) => void = noop,
): string {
  return renderToStaticMarkup(
    <RepoSection
      repo={value}
      expanded={expanded}
      onToggle={noop}
      selectedId={null}
      onSelect={onSelect}
    />,
  );
}

test("an active repo shows its header, live marker and board", () => {
  const html = render(repo());
  expect(html).toContain('class="repo-section repo-active"');
  expect(html).toContain('class="repo-name"');
  expect(html).toContain("pi-plan-dispatch");
  expect(html).toContain('class="repo-live"');
  expect(html).toContain('class="board"');
  expect(html).toContain("20261025-2156-monitor-multirepo-r1");
});

test("an active repo ignores the expanded flag and always shows the board", () => {
  const html = render(repo(), false);
  expect(html).toContain('class="board"');
  expect(html).not.toContain("repo-strip");
});

test("an idle collapsed repo shows a strip and no board", () => {
  const html = render(
    repo({ active: false, plan: plan({ state: "done", gate: "pass" }) }),
    false,
  );
  expect(html).toContain('class="repo-section repo-idle"');
  expect(html).toContain('class="repo-strip"');
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain("20261025-2156-monitor-multirepo-r1");
  expect(html).toContain("done");
  expect(html).toContain("gate pass");
  expect(html).not.toContain('class="board"');
});

test("an idle expanded repo shows the strip and the board", () => {
  const html = render(
    repo({ active: false, plan: plan({ state: "failed", gate: "fail" }) }),
    true,
  );
  expect(html).toContain('class="repo-strip"');
  expect(html).toContain('aria-expanded="true"');
  expect(html).toContain("gate fail");
  expect(html).toContain('class="board"');
});

test("an idle repo with no gate shows the dash", () => {
  const html = render(repo({ active: false, plan: plan({ state: "done", gate: null }) }), false);
  expect(html).toContain("gate -");
});

test("a repo with no plan shows its message and no board", () => {
  const html = render(
    repo({ active: false, plan: null, message: "folder cannot be read" }),
    true,
  );
  expect(html).toContain('class="repo-name"');
  expect(html).toContain("pi-plan-dispatch");
  expect(html).toContain("folder cannot be read");
  expect(html).not.toContain('class="board"');
});

test("a repo with no plan and no message shows the fallback line", () => {
  const html = render(repo({ active: false, plan: null, message: null }));
  expect(html).toContain("No plan yet");
  expect(html).not.toContain("repo-strip");
});

test("a repo name with HTML is escaped", () => {
  const html = render(repo({ name: "<img onerror=x>" }));
  expect(html).toContain("&lt;img");
  expect(html).not.toContain("<img");
});

test("the selected attempt is handed to the board", () => {
  const html = renderToStaticMarkup(
    <RepoSection
      repo={repo({ name: "dfph-app" })}
      expanded={false}
      onToggle={noop}
      selectedId="p1.t1.a1"
      onSelect={noop}
    />,
  );
  expect(html).toContain("dfph-app");
  expect(html).toContain("selected");
  expect(html).toContain('aria-pressed="true"');
});
