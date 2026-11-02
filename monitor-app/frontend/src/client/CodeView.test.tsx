import { test, expect, mock } from "bun:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Entry, EntryKind, SessionPage } from "../shared/types";
import { AssistantText, CodeView, DiffView } from "./CodeView";
import { TranscriptView, transcriptLoadKey } from "./Transcript";

mock.module("../../wailsjs/go/main/App", () => ({
  State: async () => ({ repos: [], message: null, now: "2026-11-02T00:00:00.000Z" }),
  Session: async () => ({ id: "s1", live: false, ended: true, entries: [], next: 0 }),
  AddRepo: async () => "",
  RemoveRepo: async () => "",
}));

function renderCode(code: ReactElement): string {
  return renderToStaticMarkup(code);
}

function makeEntry(kind: EntryKind, over: Partial<Entry> = {}): Entry {
  return {
    line: 1,
    ts: null,
    kind,
    text: "",
    collapsed: false,
    truncated: false,
    tool: null,
    isError: false,
    ...over,
  };
}

test("a TypeScript file block contains hljs markup", () => {
  const html = renderCode(
    <CodeView block={{ kind: "file", path: "src/app.ts", text: "const n: number = 1;" }} />,
  );
  expect(html).toContain("hljs-");
  expect(html).toContain("src/app.ts");
});

test("an unknown extension is shown as plain text", () => {
  const html = renderCode(
    <CodeView block={{ kind: "file", path: "notes.unknownext", text: "plain body" }} />,
  );
  expect(html).not.toContain("hljs-");
  expect(html).toContain("plain body");
});

test("a long block is collapsed behind details with the remaining line count", () => {
  const text = Array.from({ length: 250 }, (_, i) => `line ${i + 1}`).join("\n");
  const html = renderCode(<CodeView block={{ kind: "file", path: "x.log", text }} />);
  expect(html).toContain("<details");
  expect(html).toContain("50 more lines");
  expect(html).toContain("line 1");
});

test("a diff keeps the sign and classes an added and a removed row", () => {
  const html = renderCode(
    <DiffView
      block={{
        kind: "diff",
        path: "src/a.ts",
        text: "@@ -1 +1 @@\n-const a: number = 1;\n+const a: number = 2;\n context",
      }}
    />,
  );
  expect(html).toContain("diff-row diff-added");
  expect(html).toContain("diff-row diff-removed");
  expect(html).toContain('<span class="diff-sign">+</span>');
  expect(html).toContain('<span class="diff-sign">-</span>');
  expect(html).toContain("hljs-");
});

test("a diff separator row is rendered as one separator", () => {
  const html = renderCode(
    <DiffView block={{ kind: "diff", path: "src/a.ts", text: "@@ -1,2 +1,2 @@" }} />,
  );
  expect(html).toContain("diff-row diff-separator");
  expect(html).toContain("@@ -1,2 +1,2 @@");
});

test("markup in the text is escaped in a highlighted block, a plain block and a diff", () => {
  const evil = '<img src=x onerror="alert(1)">';
  const highlighted = renderCode(
    <CodeView block={{ kind: "file", path: "x.ts", text: evil }} />,
  );
  const plain = renderCode(<CodeView block={{ kind: "file", path: "x.unknown", text: evil }} />);
  const diff = renderCode(<DiffView block={{ kind: "diff", path: "x.ts", text: `+${evil}` }} />);
  for (const html of [highlighted, plain, diff]) {
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  }
});

test("AssistantText highlights a fenced code segment and keeps the text plain", () => {
  const html = renderCode(
    <AssistantText text={"before\n```ts\nconst n: number = 1;\n```\nafter"} />,
  );
  expect(html).toContain("<p>before</p>");
  expect(html).toContain("<p>after</p>");
  expect(html).toContain("hljs-");
  expect(html).toContain('class="code-head"');
});

test("AssistantText without a fence renders one paragraph", () => {
  const html = renderCode(<AssistantText text="just words" />);
  expect(html).toContain("<p>just words</p>");
  expect(html).not.toContain("code-view");
});

test("a transcript entry with code renders the code view instead of the raw args", () => {
  const html = renderToStaticMarkup(
    <TranscriptView
      title="plan.t1.a1"
      entries={[
        makeEntry("tool_call", {
          tool: { name: "write", args: '{"path":"a.go"}' },
          code: { kind: "file", path: "a.go", text: "package a\n" },
        }),
      ]}
    />,
  );
  expect(html).toContain("code-head");
  expect(html).toContain("a.go");
  expect(html).not.toContain("tool-args");
});

test("a transcript entry without code renders exactly as before", () => {
  const html = renderToStaticMarkup(
    <TranscriptView
      title="plan.t1.a1"
      entries={[makeEntry("tool_call", { tool: { name: "bash", args: "bun test" } })]}
    />,
  );
  expect(html).toContain("tool-args");
  expect(html).not.toContain("code-view");
});

test("transcriptLoadKey ignores the fetchPage closure and follows resetKey and attemptId", () => {
  const page: SessionPage = { id: "s1", live: false, ended: true, entries: [], next: 0 };
  const base = { repo: "r", planId: "p", attemptId: "a1" };
  const one = { ...base, fetchPage: async () => page };
  const two = { ...base, fetchPage: async () => ({ ...page }) };
  expect(transcriptLoadKey(one)).toBe(transcriptLoadKey(two));
  expect(transcriptLoadKey({ ...one, resetKey: "x" })).not.toBe(transcriptLoadKey(one));
  expect(transcriptLoadKey({ ...base, attemptId: "a2" })).not.toBe(transcriptLoadKey(base));
  expect(transcriptLoadKey(one)).toBe("r|p|a1|");
});
