import { expect, test } from "bun:test";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentGroup, AgentSession } from "../shared/types";
import { AgentsList } from "./AgentsList";

function session(over: Partial<AgentSession> = {}): AgentSession {
  return {
    agent: "omp",
    id: "s1",
    title: "Fix the parser",
    model: "deepseek-v4.1-flash",
    cwd: "/work/pi-plan-dispatch",
    group: "pi-plan-dispatch",
    startedAt: "2026-11-02T11:00:00.000Z",
    mtimeMs: Date.parse("2026-11-02T11:55:00.000Z"),
    live: false,
    ended: true,
    tokens: 1200,
    cost: 0.05,
    lastTool: "edit core.ts",
    thinking: "high",
    ...over,
  };
}

function group(over: Partial<AgentGroup> = {}): AgentGroup {
  return { name: "pi-plan-dispatch", sessions: [session()], ...over };
}

const nowMs = Date.parse("2026-11-02T12:00:00.000Z");
const noop = (): void => {};

function render(
  groups: AgentGroup[],
  repoName = "pi-plan-dispatch",
  selection: Parameters<typeof AgentsList>[0]["selection"] = null,
): string {
  return renderToStaticMarkup(
    <AgentsList
      groups={groups}
      repoName={repoName}
      nowMs={nowMs}
      selection={selection}
      onSelectAgent={noop}
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

test("one row per session of the named group, each with its agent badge", () => {
  const html = render([
    group({
      sessions: [
        session(),
        session({ id: "s2", agent: "pi", title: "Port the server", model: "claude-sonnet-5.5" }),
      ],
    }),
    group({ name: "other-repo", sessions: [session({ id: "s3", title: "Elsewhere" })] }),
  ]);
  expect(count(html, 'class="agent-row')).toBe(2);
  expect(html).toContain('class="agent-badge agent-badge-omp"');
  expect(html).toContain('class="agent-badge agent-badge-pi"');
  expect(html).toContain("Fix the parser");
  expect(html).toContain("Port the server");
  expect(html).not.toContain("Elsewhere");
});

test("a live session shows the marker, and every row shows cost and time since the last change", () => {
  const html = render([
    group({ sessions: [session({ live: true }), session({ id: "s2", live: false })] }),
  ]);
  expect(count(html, 'class="agent-live"')).toBe(1);
  expect(html).toContain("$0.0500");
  expect(html).toContain("5m 00s ago");
});

test("a null model is shown as a dash", () => {
  const html = render([group({ sessions: [session({ model: null })] })]);
  expect(html).toContain('<span class="agent-model">-</span>');
});

test("only the selected agent row is aria-current", () => {
  const html = render(
    [group({ sessions: [session(), session({ id: "s2", agent: "pi", title: "Port the server" })] })],
    "pi-plan-dispatch",
    { kind: "agent", agent: "pi", group: "pi-plan-dispatch", id: "s2" },
  );
  expect(count(html, 'aria-current="true"')).toBe(1);
  expect(count(html, "agent-row-selected")).toBe(1);
});

test("clicking a row passes agent, group and id to onSelectAgent", () => {
  const calls: Array<[string, string, string]> = [];
  const tree = AgentsList({
    groups: [
      group({
        sessions: [session(), session({ id: "s2", agent: "pi", title: "Port the server" })],
      }),
    ],
    repoName: "pi-plan-dispatch",
    nowMs,
    selection: null,
    onSelectAgent: (agent, groupName, id) => {
      calls.push([agent, groupName, id]);
    },
  });
  const buttons: ReactElement<{ onClick?: () => void }>[] = [];
  collectButtons(tree, buttons);
  expect(buttons.length).toBe(2);
  buttons[0].props.onClick?.();
  buttons[1].props.onClick?.();
  expect(calls).toEqual([
    ["omp", "pi-plan-dispatch", "s1"],
    ["pi", "pi-plan-dispatch", "s2"],
  ]);
});

test("a group with no matching name renders the empty case and no rows", () => {
  const html = render([group({ name: "another-repo" })]);
  expect(html).toContain("No agent sessions");
  expect(html).not.toContain('class="agent-row');
});
