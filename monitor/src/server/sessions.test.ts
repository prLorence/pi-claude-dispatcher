import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Entry } from "../shared/types.ts";
import {
  TOOL_ARGS_CAP,
  TOOL_RESULT_CAP,
  findSessionFile,
  listSessionFiles,
  parseSessionLines,
  summarizeSession,
} from "./sessions.ts";
import {
  assistantMsg,
  cleanup,
  makePlansDir,
  modelChange,
  sessionHeader,
  systemMsg,
  textPart,
  thinkingPart,
  toolCall,
  toolResult,
  userMsg,
  writeSession,
} from "../../test/fixture.ts";

const TS = "2026-10-22T18-02-28-549Z";

function messageLine(ts: string, message: object): object {
  return { type: "message", timestamp: ts, message };
}

function withDir(fn: (dir: string) => void): void {
  const dir = makePlansDir();
  try {
    fn(dir);
  } finally {
    cleanup(dir);
  }
}

test("parseSessionLines maps every session line kind to entries", () => {
  const lines = [
    sessionHeader("p.t.a1"),
    modelChange("opencode-go/beam-free", TS),
    { type: "thinking_level_change", timestamp: TS, thinkingLevel: "high" },
    systemMsg(TS),
    userMsg("do the thing", TS),
    assistantMsg(
      [textPart("hello"), thinkingPart("hmm"), toolCall("edit", { path: "src/a.ts" }, "1")],
      TS,
      { stopReason: "toolUse" },
    ),
    toolResult("edit", "ok", TS),
  ];
  const text = lines.map((line) => `${JSON.stringify(line)}\n`).join("");
  const result = parseSessionLines(text, 0);

  expect(result.next).toBe(7);
  expect(result.entries.map((entry) => entry.kind)).toEqual([
    "note",
    "note",
    "note",
    "user",
    "assistant",
    "thinking",
    "tool_call",
    "tool_result",
  ]);
  expect(result.entries.map((entry) => entry.line)).toEqual([2, 3, 4, 5, 6, 6, 6, 7]);
  expect(result.entries[0].text).toBe("model: beam-free");
  expect(result.entries[1].text).toBe("thinking: high");
  expect(result.entries[2].text).toBe("System prompt hidden");
  expect(result.entries[3].text).toBe("do the thing");
  expect(result.entries[3].collapsed).toBe(true);
  expect(result.entries[4].text).toBe("hello");
  expect(result.entries[4].collapsed).toBe(false);
  expect(result.entries[5].text).toBe("hmm");
  expect(result.entries[5].collapsed).toBe(true);
  expect(result.entries[6].text).toBe('edit {"path":"src/a.ts"}');
  expect(result.entries[6].tool).toEqual({ name: "edit", args: '{"path":"src/a.ts"}' });
  expect(result.entries[6].collapsed).toBe(false);
  expect(result.entries[7].text).toBe("ok");
  expect(result.entries[7].tool).toEqual({ name: "edit", args: "" });
  expect(result.entries[7].isError).toBe(false);
  expect(result.entries[0].ts).toBe(TS);
});

test("parseSessionLines joins text parts and marks tool errors", () => {
  const lines = [
    messageLine(TS, {
      role: "user",
      content: [textPart("one "), textPart("two")],
    }),
    messageLine(TS, {
      role: "toolResult",
      toolName: "bash",
      isError: true,
      content: [textPart("failed"), textPart(" hard")],
    }),
  ];
  const text = lines.map((line) => `${JSON.stringify(line)}\n`).join("");
  const result = parseSessionLines(text, 0);

  expect(result.entries).toHaveLength(2);
  expect(result.entries[0].text).toBe("one two");
  expect(result.entries[1].text).toBe("failed hard");
  expect(result.entries[1].isError).toBe(true);
  expect(result.entries[1].tool?.name).toBe("bash");
});

test("parseSessionLines ignores unknown roles and part types", () => {
  const lines = [
    messageLine(TS, { role: "tool", content: [textPart("ignored")] }),
    messageLine(TS, {
      role: "assistant",
      content: [{ type: "image", data: "x" }, { type: "text", text: "kept" }],
    }),
  ];
  const text = lines.map((line) => `${JSON.stringify(line)}\n`).join("");
  const result = parseSessionLines(text, 0);

  expect(result.entries).toHaveLength(1);
  expect(result.entries[0].text).toBe("kept");
});

test("parseSessionLines truncates a long tool result", () => {
  const raw = "x".repeat(TOOL_RESULT_CAP + 10);
  const text = `${JSON.stringify(
    messageLine(TS, { role: "toolResult", toolName: "read", content: [textPart(raw)] }),
  )}\n`;
  const entry: Entry = parseSessionLines(text, 0).entries[0];

  expect(entry.truncated).toBe(true);
  expect(entry.text.startsWith("x".repeat(TOOL_RESULT_CAP))).toBe(true);
  expect(entry.text.endsWith("… [truncated]")).toBe(true);
  expect(entry.text.length).toBe(TOOL_RESULT_CAP + "… [truncated]".length);
});

test("parseSessionLines keeps text of exactly the cap untruncated", () => {
  const raw = "y".repeat(TOOL_RESULT_CAP);
  const text = `${JSON.stringify(
    messageLine(TS, { role: "toolResult", toolName: "read", content: [textPart(raw)] }),
  )}\n`;
  const entry: Entry = parseSessionLines(text, 0).entries[0];

  expect(entry.truncated).toBe(false);
  expect(entry.text.length).toBe(TOOL_RESULT_CAP);
});

test("parseSessionLines truncates a long tool call", () => {
  const text = `${JSON.stringify(
    messageLine(TS, {
      role: "assistant",
      content: [toolCall("bash", { command: "z".repeat(TOOL_ARGS_CAP + 50) }, "1")],
    }),
  )}\n`;
  const entry = parseSessionLines(text, 0).entries[0];

  expect(entry.truncated).toBe(true);
  expect(entry.text.endsWith("… [truncated]")).toBe(true);
  expect(entry.text.length).toBe(TOOL_ARGS_CAP + "… [truncated]".length);
  expect(entry.tool?.name).toBe("bash");
});

test("parseSessionLines skips an invalid middle line and still advances", () => {
  const first = JSON.stringify(
    messageLine(TS, { role: "assistant", content: [textPart("one")], stopReason: "stop" }),
  );
  const third = JSON.stringify(
    messageLine(TS, { role: "assistant", content: [textPart("three")], stopReason: "stop" }),
  );
  const result = parseSessionLines(`${first}\nnot json\n${third}\n`, 0);

  expect(result.next).toBe(3);
  expect(result.entries.map((entry) => entry.text)).toEqual(["one", "three"]);
});

test("parseSessionLines does not consume a partial last line", () => {
  const first = `${JSON.stringify(
    messageLine(TS, { role: "assistant", content: [textPart("one")], stopReason: "stop" }),
  )}\n`;
  const second = `${JSON.stringify(
    messageLine(TS, { role: "assistant", content: [textPart("two")], stopReason: "stop" }),
  )}\n`;
  const partial = second.slice(0, 25);

  const before = parseSessionLines(first + partial, 0);
  expect(before.next).toBe(1);
  expect(before.entries.map((entry) => entry.text)).toEqual(["one"]);

  const after = parseSessionLines(first + second, before.next);
  expect(after.next).toBe(2);
  expect(after.entries.map((entry) => entry.text)).toEqual(["two"]);

  const again = parseSessionLines(first + second, after.next);
  expect(again.next).toBe(2);
  expect(again.entries).toEqual([]);
});

test("parseSessionLines with nothing new returns after", () => {
  expect(parseSessionLines("", 0)).toEqual({ entries: [], next: 0 });
  expect(parseSessionLines("one\n", 5)).toEqual({ entries: [], next: 5 });
});

test("summarizeSession reports a missing file", () => {
  const summary = summarizeSession(null);
  expect(summary.exists).toBe(false);
  expect(summary.ended).toBe(false);
  expect(summary.mtimeMs).toBe(0);
  expect(summary.tokens).toBeNull();
  expect(summary.error).toBeNull();
});

test("summarizeSession reports an unreadable file without throwing", () => {
  withDir((dir) => {
    const folder = path.join(dir, "sessions", "p1");
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, "not-a-file.jsonl");
    fs.mkdirSync(file);

    const summary = summarizeSession(file);
    expect(summary.exists).toBe(true);
    expect(summary.ended).toBe(false);
    expect(summary.error).toBe("unreadable session");
    expect(summary.tokens).toBeNull();
    expect(summary.cost).toBeNull();
  });
});

test("summarizeSession treats an empty file as not ended", () => {
  withDir((dir) => {
    const file = writeSession(dir, "p1", "p1.t.a1", []);
    const summary = summarizeSession(file);

    expect(summary.exists).toBe(true);
    expect(summary.ended).toBe(false);
    expect(summary.stopReason).toBeNull();
    expect(summary.startedAt).toBeNull();
    expect(summary.lastTs).toBeNull();
    expect(summary.mtimeMs).toBeGreaterThan(0);
  });
});

test("summarizeSession is not ended while the last message waits for a tool", () => {
  withDir((dir) => {
    const file = writeSession(dir, "p1", "p1.t.a1", [
      sessionHeader("p1.t.a1"),
      assistantMsg([textPart("working")], TS, { stopReason: "toolUse" }),
    ]);
    const summary = summarizeSession(file);

    expect(summary.ended).toBe(false);
    expect(summary.stopReason).toBe("toolUse");
    expect(summary.lastText).toBe("working");
  });
});

test("summarizeSession is ended on stop and sums usage", () => {
  withDir((dir) => {
    const file = writeSession(dir, "p1", "p1.t.a1", [
      sessionHeader("p1.t.a1"),
      modelChange("opencode-go/beam-free", TS),
      { type: "thinking_level_change", timestamp: TS, thinkingLevel: "medium" },
      userMsg("go", TS),
      assistantMsg([textPart("first")], TS, { stopReason: "stop", input: 10, output: 5, cost: 0.25 }),
      assistantMsg([textPart("second")], TS, { stopReason: "stop", input: 7, output: 3, cost: 0.5 }),
    ]);
    const summary = summarizeSession(file);

    expect(summary.ended).toBe(true);
    expect(summary.stopReason).toBe("stop");
    expect(summary.tokens).toBe(25);
    expect(summary.cost).toBe(0.75);
    expect(summary.startedAt).toBe(TS);
    expect(summary.lastTs).toBe(TS);
    expect(summary.lastText).toBe("second");
    expect(summary.model).toBe("beam-free");
    expect(summary.thinking).toBe("medium");
    expect(summary.error).toBeNull();
  });
});

test("summarizeSession is ended on error and keeps the error message", () => {
  withDir((dir) => {
    const file = writeSession(dir, "p1", "p1.t.a1", [
      messageLine(TS, {
        role: "assistant",
        content: [textPart("boom")],
        stopReason: "error",
        errorMessage: "provider failed",
      }),
    ]);
    const summary = summarizeSession(file);

    expect(summary.ended).toBe(true);
    expect(summary.stopReason).toBe("error");
    expect(summary.error).toBe("provider failed");
  });
});

test("summarizeSession reports no tokens for a session without usage", () => {
  withDir((dir) => {
    const file = writeSession(dir, "p1", "p1.t.a1", [
      assistantMsg([textPart("no usage")], TS, { stopReason: "stop" }),
    ]);
    const summary = summarizeSession(file);

    expect(summary.tokens).toBeNull();
    expect(summary.cost).toBeNull();
  });
});

test("summarizeSession formats the last tool call", () => {
  const cases: { name: string; args: object; expected: string }[] = [
    { name: "read", args: { path: "src/deep/a.ts" }, expected: "read a.ts" },
    { name: "edit", args: { file_path: "src/b.ts" }, expected: "edit b.ts" },
    { name: "write", args: { file: "src/c.ts" }, expected: "write c.ts" },
    { name: "bash", args: { command: "npm test -- --watch" }, expected: "bash npm test -- --watch" },
    { name: "grep", args: { pattern: "x" }, expected: "grep" },
  ];

  withDir((dir) => {
    for (const [index, item] of cases.entries()) {
      const file = writeSession(dir, "p1", `p1.t.a${index + 1}`, [
        assistantMsg([toolCall(item.name, item.args, "1")], TS, { stopReason: "stop" }),
      ]);
      expect(summarizeSession(file).lastTool).toBe(item.expected);
    }
  });
});

test("summarizeSession cuts a long bash command at 60 characters", () => {
  withDir((dir) => {
    const command = "c".repeat(100);
    const file = writeSession(dir, "p1", "p1.t.a1", [
      assistantMsg([toolCall("bash", { command }, "1")], TS, { stopReason: "stop" }),
    ]);
    expect(summarizeSession(file).lastTool).toBe(`bash ${"c".repeat(60)}`);
  });
});

test("listSessionFiles lists plain session files and ignores a retired one", () => {
  withDir((dir) => {
    writeSession(dir, "p1", "p1.t.a2", [sessionHeader("p1.t.a2")]);
    writeSession(dir, "p1", "p1.t.review1.a1", [sessionHeader("p1.t.review1.a1")]);
    const retired = path.join(dir, "sessions", "p1", `${TS}_p1.t.a1.jsonl`);
    fs.writeFileSync(retired, "");
    const retiredName = path.join(dir, "sessions", "p1", `${TS}_p1.t.a1.jsonl.prev-20261023`);
    fs.renameSync(retired, retiredName);
    const folder = path.join(dir, "sessions", "p1", "nested.jsonl");
    fs.mkdirSync(folder);

    const files = listSessionFiles(dir, "p1");
    expect(files.map((item) => item.id)).toEqual(["p1.t.a2", "p1.t.review1.a1"]);
    for (const item of files) {
      expect(fs.statSync(item.file).isFile()).toBe(true);
    }
  });
});

test("listSessionFiles returns an empty list when the session folder is missing", () => {
  withDir((dir) => {
    expect(listSessionFiles(dir, "missing")).toEqual([]);
  });
});

test("findSessionFile returns the last match by file name", () => {
  withDir((dir) => {
    const folder = path.join(dir, "sessions", "p1");
    fs.mkdirSync(folder, { recursive: true });
    const first = path.join(folder, "2026-01-01T00-00-00-000Z_p1.t.a1.jsonl");
    const second = path.join(folder, "2026-02-01T00-00-00-000Z_p1.t.a1.jsonl");
    fs.writeFileSync(first, "");
    fs.writeFileSync(second, "");

    expect(findSessionFile(dir, "p1", "p1.t.a1")).toBe(second);
    expect(findSessionFile(dir, "p1", "p1.t.a9")).toBeNull();
  });
});
