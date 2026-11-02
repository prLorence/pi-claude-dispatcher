import { expect, test } from "bun:test";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Settings } from "../shared/types";
import { SettingsPanel } from "./SettingsPanel";

function settings(over: Partial<Settings> = {}): Settings {
  return { ompSessions: false, piSessions: false, scope: "repos", ...over };
}

function render(
  value: Settings,
  message = "",
  repoNames: string[] = ["alpha", "beta"],
): string {
  return renderToStaticMarkup(
    <SettingsPanel
      settings={value}
      onChange={() => {}}
      repoNames={repoNames}
      message={message}
    />,
  );
}

// The panel itself has no hooks, so its element tree can be walked to reach the inputs;
// nested function components with hooks (Repos) are not expanded.
function collect(
  node: ReactNode,
  out: ReactElement<Record<string, unknown>>[],
  tag: string,
): void {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (typeof node === "string" || typeof node === "number") return;
  if (Array.isArray(node)) {
    for (const child of node) collect(child, out, tag);
    return;
  }
  const element = node as ReactElement<Record<string, unknown>>;
  if (element.type === tag) out.push(element);
  collect(element.props.children as ReactNode, out, tag);
}

function checkboxes(): ReactElement<Record<string, unknown>>[] {
  const tree = SettingsPanel({
    settings: settings(),
    onChange: () => {},
    repoNames: [],
    message: "",
  }) as ReactNode;
  const out: ReactElement<Record<string, unknown>>[] = [];
  collect(tree, out, "input");
  return out.filter((input) => input.props.type === "checkbox");
}

function radios(): ReactElement<Record<string, unknown>>[] {
  const tree = SettingsPanel({
    settings: settings(),
    onChange: () => {},
    repoNames: [],
    message: "",
  }) as ReactNode;
  const out: ReactElement<Record<string, unknown>>[] = [];
  collect(tree, out, "input");
  return out.filter((input) => input.props.type === "radio");
}

test("both toggles are off by default in the static markup", () => {
  const html = render(settings());
  expect(html.split('type="checkbox"').length - 1).toBe(2);
  expect(html).not.toContain('type="checkbox" checked');
  expect(html).toContain("omp sessions");
  expect(html).toContain("Pi sessions");
});

test("each toggle and scope combination renders its checked state", () => {
  const combos: Settings[] = [
    settings({ ompSessions: true }),
    settings({ piSessions: true }),
    settings({ ompSessions: true, piSessions: true }),
    settings({ ompSessions: true, piSessions: true, scope: "all" }),
  ];
  for (const combo of combos) {
    const html = render(combo);
    const checked = html.split("checked").length - 1;
    const expected = (combo.ompSessions ? 1 : 0) + (combo.piSessions ? 1 : 0) + 1;
    expect(checked).toBe(expected);
  }
});

test("the scope line explains what All sessions adds", () => {
  const html = render(settings({ scope: "all" }));
  expect(html).toContain("Added repos only");
  expect(html).toContain("All sessions");
  expect(html).toContain("All sessions also shows sessions of repos you did not add.");
});

test("the panel lists the added repos with the existing Add and Remove controls", () => {
  const html = render(settings(), "", ["alpha", "beta"]);
  expect(html).toContain("Add repo");
  expect(html).toContain('aria-label="Remove alpha"');
  expect(html).toContain('aria-label="Remove beta"');
});

test("the message is shown only when it is not empty", () => {
  expect(render(settings(), "")).not.toContain('class="settings-message');
  const html = render(settings(), "no saved repo named beta");
  expect(html).toContain('class="settings-message');
  expect(html).toContain("no saved repo named beta");
});

test("toggling omp sessions passes the whole new settings object", () => {
  const calls: Settings[] = [];
  const tree = SettingsPanel({
    settings: settings(),
    onChange: (next) => calls.push(next),
    repoNames: [],
    message: "",
  }) as ReactNode;
  const out: ReactElement<Record<string, unknown>>[] = [];
  collect(tree, out, "input");
  const omp = out.find((input) => input.props.type === "checkbox");
  expect(omp).toBeDefined();
  const onChange = omp?.props.onChange as (event: { target: { checked: boolean } }) => void;
  onChange({ target: { checked: true } });
  expect(calls).toEqual([{ ompSessions: true, piSessions: false, scope: "repos" }]);
});

test("toggling Pi sessions keeps the other fields", () => {
  const calls: Settings[] = [];
  const tree = SettingsPanel({
    settings: settings({ ompSessions: true, scope: "all" }),
    onChange: (next) => calls.push(next),
    repoNames: [],
    message: "",
  }) as ReactNode;
  const out: ReactElement<Record<string, unknown>>[] = [];
  collect(tree, out, "input");
  const boxes = out.filter((input) => input.props.type === "checkbox");
  const onChange = boxes[1]?.props.onChange as (event: { target: { checked: boolean } }) => void;
  onChange({ target: { checked: true } });
  expect(calls).toEqual([{ ompSessions: true, piSessions: true, scope: "all" }]);
  expect(checkboxes().length).toBe(2);
});

test("choosing All sessions passes scope all and choosing repos passes scope repos", () => {
  const calls: Settings[] = [];
  const tree = SettingsPanel({
    settings: settings({ scope: "repos" }),
    onChange: (next) => calls.push(next),
    repoNames: [],
    message: "",
  }) as ReactNode;
  const out: ReactElement<Record<string, unknown>>[] = [];
  collect(tree, out, "input");
  const scopeRadios = out.filter((input) => input.props.type === "radio");
  expect(scopeRadios.length).toBe(2);
  const toAll = scopeRadios[1]?.props.onChange as () => void;
  toAll();
  expect(calls).toEqual([{ ompSessions: false, piSessions: false, scope: "all" }]);
  expect(radios().length).toBe(2);
});

test("choosing Added repos only passes scope repos", () => {
  const calls: Settings[] = [];
  const tree = SettingsPanel({
    settings: settings({ scope: "all" }),
    onChange: (next) => calls.push(next),
    repoNames: [],
    message: "",
  }) as ReactNode;
  const out: ReactElement<Record<string, unknown>>[] = [];
  collect(tree, out, "input");
  const scopeRadios = out.filter((input) => input.props.type === "radio");
  const toRepos = scopeRadios[0]?.props.onChange as () => void;
  toRepos();
  expect(calls).toEqual([{ ompSessions: false, piSessions: false, scope: "repos" }]);
});
