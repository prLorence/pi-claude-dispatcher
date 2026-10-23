import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  assistantMsg,
  cleanup,
  ev,
  makePlansDir,
  modelChange,
  sessionHeader,
  systemMsg,
  thinkingPart,
  textPart,
  toolCall,
  toolResult,
  userMsg,
  writeEvents,
  writePlan,
  writeSession,
} from "./fixture";

function readLines(file: string): any[] {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

test("makePlansDir creates the plans tree and cleanup removes it", () => {
  const dir = makePlansDir();
  try {
    expect(fs.existsSync(dir)).toBe(true);
    for (const name of ["traces", "running", "done", "sessions", "inbox"]) {
      expect(fs.statSync(path.join(dir, name)).isDirectory()).toBe(true);
    }
    expect(path.dirname(dir)).toBe(os.tmpdir());
  } finally {
    cleanup(dir);
  }
  expect(fs.existsSync(dir)).toBe(false);
});

test("writePlan writes a running plan with frontmatter, context and tasks", () => {
  const dir = makePlansDir();
  try {
    writePlan(dir, "running", "p1", [
      { id: "t1", dependsOn: ["t0", "t9"], pair: "review" },
      { id: "t2", role: "qa" },
    ], "trace-1");
    const file = path.join(dir, "running", "p1.md");
    expect(fs.existsSync(file)).toBe(true);
    const text = fs.readFileSync(file, "utf8");
    expect(text.startsWith("---\n")).toBe(true);
    expect(text).toContain("id: p1");
    expect(text).toContain("trace: trace-1");
    expect(text).toContain("round: 1");
    expect(text).toContain("status: ready");
    expect(text).toContain("## task: t1");
    expect(text).toContain("files: x.ts");
    expect(text).toContain("depends_on: [t0, t9]");
    expect(text).toContain("pair: review");
    expect(text).toContain("Body line for t1.");
    expect(text).toContain("## task: t2");
    expect(text).toContain("depends_on: []");
    expect(text).toContain("role: qa");
    expect(text).toContain("Body line for t2.");
    expect(text.indexOf("## task: t1")).toBeLessThan(text.indexOf("## task: t2"));
    expect(text).not.toContain("pair: review\n\nrole:");
  } finally {
    cleanup(dir);
  }
});

test("writePlan defaults trace to the plan id and writes done plans", () => {
  const dir = makePlansDir();
  try {
    writePlan(dir, "done", "p2", [{ id: "a" }]);
    const file = path.join(dir, "done", "p2", "plan.md");
    expect(fs.existsSync(file)).toBe(true);
    const text = fs.readFileSync(file, "utf8");
    expect(text).toContain("id: p2");
    expect(text).toContain("trace: p2");
    expect(fs.existsSync(path.join(dir, "running", "p2.md"))).toBe(false);
  } finally {
    cleanup(dir);
  }
});

test("ev builds an event with the optional fields and writeEvents appends lines", () => {
  const dir = makePlansDir();
  try {
    expect(ev("plan.end", "p1", "2026-10-22T18:00:00.000Z")).toEqual({
      ts: "2026-10-22T18:00:00.000Z",
      plan: "p1",
      kind: "plan.end",
      actor: "worker",
      round: 1,
    });
    const withExtra = ev("task.start", "p1", "2026-10-22T18:00:01.000Z", {
      task: "t1",
      attempt: 2,
      data: { session_id: "p1.t1.a2" },
    }) as any;
    expect(withExtra.task).toBe("t1");
    expect(withExtra.attempt).toBe(2);
    expect(withExtra.data.session_id).toBe("p1.t1.a2");

    writeEvents(dir, "p1", [withExtra]);
    writeEvents(dir, "p1", [ev("task.end", "p1", "2026-10-22T18:00:02.000Z")]);
    const lines = readLines(path.join(dir, "traces", "p1.jsonl"));
    expect(lines.length).toBe(2);
    expect(lines[0].v).toBe(1);
    expect(lines[0].trace).toBe("p1");
    expect(lines[0].kind).toBe("task.start");
    expect(lines[0].task).toBe("t1");
    expect(lines[1].kind).toBe("task.end");
    expect(lines[1].trace).toBe("p1");
  } finally {
    cleanup(dir);
  }
});

test("writeSession writes the expected file, lines, raw tail and mtime", () => {
  const dir = makePlansDir();
  try {
    const file = writeSession(dir, "p1", "p1.t1.a1", [
      sessionHeader("p1.t1.a1"),
      modelChange("opencode-go/deepseek-v4.1-flash", "2026-10-22T18:02:29.000Z"),
      userMsg("do the task", "2026-10-22T18:02:30.000Z"),
    ]);
    expect(path.basename(file)).toBe("2026-10-22T18-02-28-549Z_p1.t1.a1.jsonl");
    expect(path.dirname(file)).toBe(path.join(dir, "sessions", "p1"));
    const lines = readLines(file);
    expect(lines.length).toBe(3);
    expect(lines[0]).toEqual({ type: "session", version: 3, id: "p1.t1.a1" });
    expect(lines[1]).toEqual({
      type: "model_change",
      timestamp: "2026-10-22T18:02:29.000Z",
      provider: "opencode-go",
      modelId: "deepseek-v4.1-flash",
    });
    expect(lines[2].message.role).toBe("user");
    expect(lines[2].message.content[0].text).toBe("do the task");

    const second = writeSession(dir, "p1", "p1.t1.a2", [sessionHeader("p1.t1.a2")], {
      mtimeMs: 1700000000000,
      raw: '{"type":"message","message":',
    });
    const text = fs.readFileSync(second, "utf8");
    expect(text.endsWith('{"type":"message","message":')).toBe(true);
    const stat = fs.statSync(second);
    expect(Math.abs(stat.mtimeMs - 1700000000000)).toBeLessThan(5);
  } finally {
    cleanup(dir);
  }
});

test("message and part builders use the shapes the server reads", () => {
  const ts = "2026-10-22T18:03:00.000Z";
  expect(textPart("hi")).toEqual({ type: "text", text: "hi" });
  expect(thinkingPart("hmm")).toEqual({ type: "thinking", thinking: "hmm" });
  expect(toolCall("bash", { command: "bun test" }, "call-1")).toEqual({
    type: "toolCall",
    id: "call-1",
    name: "bash",
    arguments: { command: "bun test" },
  });

  const assistant = assistantMsg(
    [thinkingPart("plan"), textPart("done"), toolCall("edit", { path: "x.ts" }, "c1")],
    ts,
    { stopReason: "toolUse", input: 100, output: 20, cost: 0.0123 },
  ) as any;
  expect(assistant.type).toBe("message");
  expect(assistant.timestamp).toBe(ts);
  expect(assistant.message.role).toBe("assistant");
  expect(assistant.message.content.length).toBe(3);
  expect(assistant.message.content[2].type).toBe("toolCall");
  expect(assistant.message.stopReason).toBe("toolUse");
  expect(assistant.message.usage).toEqual({
    input: 100,
    output: 20,
    cost: { total: 0.0123 },
  });

  const plain = assistantMsg([textPart("ok")], ts) as any;
  expect(plain.message.stopReason).toBeUndefined();
  expect(plain.message.usage).toBeUndefined();

  const result = toolResult("bash", "exit 0", ts) as any;
  expect(result.type).toBe("message");
  expect(result.timestamp).toBe(ts);
  expect(result.message.role).toBe("toolResult");
  expect(result.message.toolName).toBe("bash");
  expect(result.message.content[0].text).toBe("exit 0");
  expect(result.message.isError).toBeUndefined();

  const failed = toolResult("bash", "boom", ts, true) as any;
  expect(failed.message.isError).toBe(true);

  const user = userMsg("prompt", ts) as any;
  expect(user.message.role).toBe("user");
  expect(user.message.content).toEqual([{ type: "text", text: "prompt" }]);

  const system = systemMsg(ts) as any;
  expect(system.message.role).toBe("system");
  expect(system.message.content).toBe("");
  expect(typeof system.message.sections.tools).toBe("string");
  expect(system.message.sections.tools.length).toBeGreaterThan(100);
});
