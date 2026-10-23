import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const SESSION_FILE_TS = "2026-10-22T18-02-28-549Z";

export interface FixtureTask {
  id: string;
  dependsOn?: string[];
  pair?: string;
  role?: string;
}

export interface EventExtra {
  task?: string;
  attempt?: number;
  data?: object;
}

export interface SessionOptions {
  mtimeMs?: number;
  raw?: string;
}

export function makePlansDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-monitor-fixture-"));
  for (const name of ["traces", "running", "done", "sessions", "inbox"]) {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
  }
  return dir;
}

export function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function planText(id: string, trace: string, tasks: FixtureTask[]): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push(`id: ${id}`);
  lines.push(`trace: ${trace}`);
  lines.push("round: 1");
  lines.push("status: ready");
  lines.push("---");
  lines.push("## Context");
  lines.push("");
  lines.push("Fixture plan for the monitor tests.");
  for (const task of tasks) {
    const dependsOn = task.dependsOn ?? [];
    lines.push("");
    lines.push(`## task: ${task.id}`);
    lines.push("files: x.ts");
    lines.push(`depends_on: [${dependsOn.join(", ")}]`);
    if (task.role !== undefined) {
      lines.push(`role: ${task.role}`);
    }
    if (task.pair !== undefined) {
      lines.push(`pair: ${task.pair}`);
    }
    lines.push("");
    lines.push(`Body line for ${task.id}.`);
  }
  lines.push("");
  return lines.join("\n");
}

export function writePlan(
  dir: string,
  where: "running" | "done",
  id: string,
  tasks: FixtureTask[],
  trace = id,
): void {
  const text = planText(id, trace, tasks);
  if (where === "running") {
    fs.writeFileSync(path.join(dir, "running", `${id}.md`), text);
    return;
  }
  const folder = path.join(dir, "done", id);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "plan.md"), text);
}

export function oneLine(value: object): string {
  return `${JSON.stringify(value)}\n`;
}

export function writeEvents(dir: string, trace: string, events: object[]): void {
  fs.mkdirSync(path.join(dir, "traces"), { recursive: true });
  const file = path.join(dir, "traces", `${trace}.jsonl`);
  const text = events.map((event) => oneLine({ ...event, v: 1, trace })).join("");
  fs.appendFileSync(file, text);
}

export function ev(
  kind: string,
  plan: string,
  ts: string,
  extra: EventExtra = {},
): object {
  const event: Record<string, unknown> = {
    ts,
    plan,
    kind,
    actor: "worker",
    round: 1,
  };
  if (extra.task !== undefined) {
    event.task = extra.task;
  }
  if (extra.attempt !== undefined) {
    event.attempt = extra.attempt;
  }
  if (extra.data !== undefined) {
    event.data = extra.data;
  }
  return event;
}

export function writeSession(
  dir: string,
  planId: string,
  sessionId: string,
  lines: object[],
  opts: SessionOptions = {},
): string {
  const folder = path.join(dir, "sessions", planId);
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${SESSION_FILE_TS}_${sessionId}.jsonl`);
  let text = lines.map(oneLine).join("");
  if (opts.raw !== undefined) {
    text += opts.raw;
  }
  fs.writeFileSync(file, text);
  if (opts.mtimeMs !== undefined) {
    const seconds = opts.mtimeMs / 1000;
    fs.utimesSync(file, seconds, seconds);
  }
  return file;
}

export function sessionHeader(id: string): object {
  return { type: "session", version: 3, id };
}

export function modelChange(model: string, ts: string): object {
  const slash = model.indexOf("/");
  const provider = slash === -1 ? "" : model.slice(0, slash);
  const modelId = slash === -1 ? model : model.slice(slash + 1);
  return { type: "model_change", timestamp: ts, provider, modelId };
}

export function userMsg(text: string, ts: string): object {
  return messageLine(ts, { role: "user", content: [textPart(text)] });
}

export interface AssistantOptions {
  stopReason?: string;
  input?: number;
  output?: number;
  cost?: number;
}

export function assistantMsg(
  parts: object[],
  ts: string,
  opts: AssistantOptions = {},
): object {
  const message: Record<string, unknown> = { role: "assistant", content: parts };
  if (opts.stopReason !== undefined) {
    message.stopReason = opts.stopReason;
  }
  if (opts.input !== undefined || opts.output !== undefined || opts.cost !== undefined) {
    message.usage = {
      input: opts.input ?? 0,
      output: opts.output ?? 0,
      cost: { total: opts.cost ?? 0 },
    };
  }
  return messageLine(ts, message);
}

export function textPart(text: string): object {
  return { type: "text", text };
}

export function thinkingPart(text: string): object {
  return { type: "thinking", thinking: text };
}

export function toolCall(name: string, args: object, id: string): object {
  return { type: "toolCall", id, name, arguments: args };
}

export function toolResult(
  toolName: string,
  text: string,
  ts: string,
  isError = false,
): object {
  const message: Record<string, unknown> = {
    role: "toolResult",
    toolName,
    content: [textPart(text)],
  };
  if (isError) {
    message.isError = true;
  }
  return messageLine(ts, message);
}

export function systemMsg(ts: string): object {
  return messageLine(ts, {
    role: "system",
    content: "",
    sections: { tools: "system prompt text. ".repeat(500) },
  });
}

function messageLine(ts: string, message: object): object {
  return { type: "message", timestamp: ts, message };
}
