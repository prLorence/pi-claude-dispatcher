import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Entry, EntryKind } from "../shared/types";
import { Transcript, TranscriptView } from "./Transcript";
import { fetchSession } from "./api";

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

function render(entries: Entry[]): string {
  return renderToStaticMarkup(<TranscriptView entries={entries} title="plan.t1.a1" />);
}

test("fetchSession asks the repo's route and encodes every segment", async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
    calls.push(String(input));
    const body = { id: "s1", live: false, ended: true, entries: [], next: 4 };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const page = await fetchSession("dfph-app", "plan/1", "a 1", 4);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe("/api/session/dfph-app/plan%2F1/a%201?after=4");
    expect(page.id).toBe("s1");
    expect(page.next).toBe(4);
  } finally {
    globalThis.fetch = original;
  }
});

test("shows the placeholder when no attempt is selected for a repo", () => {
  const html = renderToStaticMarkup(
    <Transcript repo="dfph-app" planId="plan.t1" attemptId={null} />,
  );
  expect(html).toContain("Select a lane to read its transcript");
});

test("renders the title", () => {
  const html = render([]);
  expect(html).toContain("plan.t1.a1");
});

test("renders the empty state", () => {
  const html = render([]);
  expect(html).toContain("No output yet");
  expect(html).toContain("muted");
});

test("renders an assistant entry as a paragraph", () => {
  const html = render([makeEntry("assistant", { text: "hello there" })]);
  expect(html).toContain("entry entry-assistant");
  expect(html).toContain("<p>hello there</p>");
});

test("renders a tool call with the tool name and args", () => {
  const html = render([
    makeEntry("tool_call", { tool: { name: "bash", args: '{"command":"bun test"}' } }),
  ]);
  expect(html).toContain("entry entry-tool_call");
  expect(html).toContain("bash");
  expect(html).toContain("tool-args");
  expect(html).toContain("bun test");
});

test("renders a tool result as a pre without the error class", () => {
  const html = render([makeEntry("tool_result", { text: "ok" })]);
  expect(html).toContain("entry entry-tool_result");
  expect(html).toContain("<pre>ok</pre>");
  expect(html).not.toContain('class="error"');
});

test("adds the error class to a failed tool result", () => {
  const html = render([makeEntry("tool_result", { text: "boom", isError: true })]);
  expect(html).toContain('<pre class="error">');
});

test("renders a note as one muted line", () => {
  const html = render([makeEntry("note", { text: "truncated output" })]);
  expect(html).toContain("entry entry-note muted");
  expect(html).toContain("truncated output");
});

test("folds a user prompt into closed details", () => {
  const html = render([makeEntry("user", { text: "do the thing", collapsed: true })]);
  expect(html).toContain("<details");
  expect(html).not.toContain("<details open");
  expect(html).toContain("<summary>task prompt</summary>");
  expect(html).toContain("do the thing");
});

test("folds thinking into closed details", () => {
  const html = render([makeEntry("thinking", { text: "hmm", collapsed: true })]);
  expect(html).toContain("<details");
  expect(html).not.toContain("<details open");
  expect(html).toContain("<summary>thinking</summary>");
  expect(html).toContain("hmm");
});

test("shows a truncated entry's text as given", () => {
  const html = render([makeEntry("tool_result", { text: "first part [truncated]", truncated: true })]);
  expect(html).toContain("first part [truncated]");
});

test("escapes html in assistant text", () => {
  const html = render([makeEntry("assistant", { text: "<script>alert(1)</script>" })]);
  expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(html).not.toContain("<script>alert(1)</script>");
});

test("escapes html in a tool result", () => {
  const html = render([makeEntry("tool_result", { text: "<script>alert(1)</script>" })]);
  expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(html).not.toContain("<script>alert(1)</script>");
});

test("renders entries in order with their own kinds", () => {
  const html = render([
    makeEntry("user", { line: 1, text: "prompt", collapsed: true }),
    makeEntry("assistant", { line: 2, text: "reply" }),
    makeEntry("tool_call", { line: 3, tool: { name: "read", args: "core.ts" } }),
  ]);
  const promptAt = html.indexOf("prompt");
  const replyAt = html.indexOf("reply");
  const readAt = html.indexOf("read");
  expect(promptAt).toBeGreaterThanOrEqual(0);
  expect(replyAt).toBeGreaterThan(promptAt);
  expect(readAt).toBeGreaterThan(replyAt);
});
