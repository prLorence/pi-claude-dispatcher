import * as fs from "node:fs";
import { basename } from "node:path";
import type { Entry, EntryKind } from "../shared/types.ts";
import { resolveInside } from "./http.ts";

export const TOOL_RESULT_CAP = 2000;
export const TOOL_ARGS_CAP = 8000;

const TRUNCATION_NOTE = "… [truncated]";
const PATH_KEYS = ["path", "file_path", "filePath", "file"];

interface RawLine {
  line: number;
  raw: string;
}

/**
 * Split the file text into complete lines. The text after the final newline
 * is a line still being written, so it is not returned.
 */
function completeLines(text: string): RawLine[] {
  const parts = text.split("\n");
  const count = parts.length - 1;
  const lines: RawLine[] = [];
  for (let i = 0; i < count; i += 1) {
    lines.push({ line: i + 1, raw: parts[i] });
  }
  return lines;
}

function parseObject(raw: string): Record<string, unknown> | null {
  if (raw.trim() === "") {
    return null;
  }
  try {
    const value = JSON.parse(raw);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // A malformed line is skipped; the monitor never crashes on bad data.
  }
  return null;
}

function textParts(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const part of content) {
    if (part === null || typeof part !== "object") {
      continue;
    }
    const typed = part as Record<string, unknown>;
    if (typed.type === "text" && typeof typed.text === "string") {
      parts.push(typed.text);
    }
  }
  return parts.join("");
}

function cap(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) {
    return { text, truncated: false };
  }
  return { text: text.slice(0, limit) + TRUNCATION_NOTE, truncated: true };
}

function timestampOf(obj: Record<string, unknown>): string | null {
  return typeof obj.timestamp === "string" ? obj.timestamp : null;
}

function entry(
  line: number,
  ts: string | null,
  kind: EntryKind,
  text: string,
): Entry {
  return {
    line,
    ts,
    kind,
    text,
    collapsed: false,
    truncated: false,
    tool: null,
    isError: false,
  };
}

function messageEntries(obj: Record<string, unknown>, line: number, ts: string | null): Entry[] {
  const message = obj.message;
  if (message === null || typeof message !== "object") {
    return [];
  }
  const msg = message as Record<string, unknown>;
  const role = msg.role;

  if (role === "system") {
    return [entry(line, ts, "note", "System prompt hidden")];
  }

  if (role === "user") {
    const result = entry(line, ts, "user", textParts(msg.content));
    result.collapsed = true;
    return [result];
  }

  if (role === "assistant") {
    if (!Array.isArray(msg.content)) {
      return [];
    }
    const entries: Entry[] = [];
    for (const part of msg.content) {
      if (part === null || typeof part !== "object") {
        continue;
      }
      const typed = part as Record<string, unknown>;
      if (typed.type === "text" && typeof typed.text === "string") {
        entries.push(entry(line, ts, "assistant", typed.text));
      } else if (typed.type === "thinking" && typeof typed.thinking === "string") {
        const thinking = entry(line, ts, "thinking", typed.thinking);
        thinking.collapsed = true;
        entries.push(thinking);
      } else if (typed.type === "toolCall") {
        const name = typeof typed.name === "string" ? typed.name : "unknown";
        const args = typed.arguments === undefined ? "" : JSON.stringify(typed.arguments);
        const toolCall = entry(line, ts, "tool_call", `${name} ${args ?? ""}`);
        toolCall.tool = { name, args: args ?? "" };
        const capped = cap(toolCall.text, TOOL_ARGS_CAP);
        toolCall.text = capped.text;
        toolCall.truncated = capped.truncated;
        entries.push(toolCall);
      }
    }
    return entries;
  }

  if (role === "toolResult") {
    const toolName = typeof msg.toolName === "string" ? msg.toolName : "";
    const result = entry(line, ts, "tool_result", textParts(msg.content));
    const capped = cap(result.text, TOOL_RESULT_CAP);
    result.text = capped.text;
    result.truncated = capped.truncated;
    result.tool = { name: toolName, args: "" };
    result.isError = msg.isError === true;
    return [result];
  }

  return [];
}

function lineEntries(obj: Record<string, unknown>, line: number): Entry[] {
  const ts = timestampOf(obj);
  const type = obj.type;

  if (type === "session" || type === "session_info") {
    return [];
  }
  if (type === "model_change") {
    const modelId = typeof obj.modelId === "string" ? obj.modelId : "";
    return [entry(line, ts, "note", `model: ${modelId}`)];
  }
  if (type === "thinking_level_change") {
    const level = typeof obj.thinkingLevel === "string" ? obj.thinkingLevel : "";
    return [entry(line, ts, "note", `thinking: ${level}`)];
  }
  if (type === "message") {
    return messageEntries(obj, line, ts);
  }
  return [];
}

export function parseSessionLines(
  text: string,
  after: number,
): { entries: Entry[]; next: number } {
  const entries: Entry[] = [];
  let next = after;
  for (const { line, raw } of completeLines(text)) {
    if (line <= after) {
      continue;
    }
    next = line;
    const obj = parseObject(raw);
    if (obj === null) {
      continue;
    }
    entries.push(...lineEntries(obj, line));
  }
  return { entries, next };
}

export interface SessionSummary {
  exists: boolean;
  ended: boolean;
  stopReason: string | null;
  startedAt: string | null;
  lastTs: string | null;
  mtimeMs: number;
  lastTool: string | null;
  tokens: number | null;
  cost: number | null;
  lastText: string | null;
  model: string | null;
  thinking: string | null;
  error: string | null;
}

function emptySummary(): SessionSummary {
  return {
    exists: false,
    ended: false,
    stopReason: null,
    startedAt: null,
    lastTs: null,
    mtimeMs: 0,
    lastTool: null,
    tokens: null,
    cost: null,
    lastText: null,
    model: null,
    thinking: null,
    error: null,
  };
}

function firstPath(args: Record<string, unknown>): string | null {
  for (const key of PATH_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
}

function formatTool(name: string, args: unknown): string {
  if (args === null || typeof args !== "object") {
    return name;
  }
  const record = args as Record<string, unknown>;
  if (name === "read" || name === "edit" || name === "write") {
    const target = firstPath(record);
    if (target !== null) {
      return `${name} ${basename(target)}`;
    }
    return name;
  }
  if (name === "bash") {
    const command = typeof record.command === "string" ? record.command : "";
    if (command === "") {
      return name;
    }
    return `bash ${command.slice(0, 60)}`;
  }
  return name;
}

function usageNumbers(message: Record<string, unknown>): {
  tokens: number | null;
  cost: number | null;
} {
  const usage = message.usage;
  if (usage === null || typeof usage !== "object") {
    return { tokens: null, cost: null };
  }
  const record = usage as Record<string, unknown>;
  const input = typeof record.input === "number" ? record.input : 0;
  const output = typeof record.output === "number" ? record.output : 0;
  let cost: number | null = null;
  const costRecord = record.cost;
  if (costRecord !== null && typeof costRecord === "object") {
    const total = (costRecord as Record<string, unknown>).total;
    if (typeof total === "number") {
      cost = total;
    }
  }
  return { tokens: input + output, cost };
}

export function summarizeSession(file: string | null): SessionSummary {
  const summary = emptySummary();
  if (file === null) {
    return summary;
  }

  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return summary;
  }

  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { ...summary, exists: true, error: "unreadable session" };
  }

  summary.exists = true;
  summary.mtimeMs = mtimeMs;

  let lastAssistant: Record<string, unknown> | null = null;
  let lastMessageRole: string | null = null;
  let tokens: number | null = null;
  let cost: number | null = null;

  for (const { raw } of completeLines(text)) {
    const obj = parseObject(raw);
    if (obj === null) {
      continue;
    }
    const ts = timestampOf(obj);
    if (ts !== null) {
      if (summary.startedAt === null) {
        summary.startedAt = ts;
      }
      summary.lastTs = ts;
    }

    const type = obj.type;
    if (type === "model_change" && typeof obj.modelId === "string") {
      summary.model = obj.modelId;
      continue;
    }
    if (type === "thinking_level_change" && typeof obj.thinkingLevel === "string") {
      summary.thinking = obj.thinkingLevel;
      continue;
    }
    if (type !== "message") {
      continue;
    }
    const message = obj.message;
    if (message === null || typeof message !== "object") {
      continue;
    }
    const msg = message as Record<string, unknown>;
    const role = typeof msg.role === "string" ? msg.role : null;
    lastMessageRole = role;
    if (role !== "assistant") {
      continue;
    }

    lastAssistant = msg;
    const usage = usageNumbers(msg);
    if (usage.tokens !== null) {
      tokens = (tokens ?? 0) + usage.tokens;
    }
    if (usage.cost !== null) {
      cost = (cost ?? 0) + usage.cost;
    }

    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part === null || typeof part !== "object") {
          continue;
        }
        const typed = part as Record<string, unknown>;
        if (
          typed.type === "toolCall" &&
          typeof typed.name === "string"
        ) {
          summary.lastTool = formatTool(typed.name, typed.arguments);
        }
      }
      const textOfMessage = textParts(msg.content);
      if (textOfMessage !== "") {
        summary.lastText = textOfMessage;
      }
    }
  }

  const stopReason = lastAssistant === null ? null : lastAssistant.stopReason;
  summary.stopReason = typeof stopReason === "string" ? stopReason : null;
  summary.ended =
    lastMessageRole === "assistant" &&
    typeof stopReason === "string" &&
    stopReason !== "" &&
    stopReason !== "toolUse";
  summary.tokens = tokens;
  summary.cost = cost;
  if (
    summary.stopReason === "error" &&
    lastAssistant !== null &&
    typeof lastAssistant.errorMessage === "string"
  ) {
    summary.error = lastAssistant.errorMessage;
  }

  return summary;
}

function sessionIdFromName(name: string): string | null {
  if (!name.endsWith(".jsonl")) {
    return null;
  }
  const base = name.slice(0, -".jsonl".length);
  const underscore = base.indexOf("_");
  if (underscore === -1) {
    return null;
  }
  const id = base.slice(underscore + 1);
  return id === "" ? null : id;
}

export function listSessionFiles(
  plansDir: string,
  planId: string,
): { id: string; file: string }[] {
  const folder = resolveInside(plansDir, "sessions", planId);
  if (folder === null) {
    return [];
  }

  let names: string[];
  try {
    names = fs.readdirSync(folder);
  } catch {
    return [];
  }
  names.sort();

  const files: { id: string; file: string }[] = [];
  for (const name of names) {
    const id = sessionIdFromName(name);
    if (id === null) {
      continue;
    }
    const file = resolveInside(folder, name);
    if (file === null) {
      continue;
    }
    try {
      if (!fs.statSync(file).isFile()) {
        continue;
      }
    } catch {
      continue;
    }
    files.push({ id, file });
  }
  return files;
}

export function findSessionFile(
  plansDir: string,
  planId: string,
  sessionId: string,
): string | null {
  let found: string | null = null;
  for (const item of listSessionFiles(plansDir, planId)) {
    if (item.id === sessionId) {
      found = item.file;
    }
  }
  return found;
}
