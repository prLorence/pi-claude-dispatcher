import * as fs from "node:fs";
import * as path from "node:path";
import { resolveInside } from "./http.ts";

function names(dir: string): string[] {
  try {
    return fs.readdirSync(dir).sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function filePart(file: string): string {
  try {
    const stat = fs.statSync(file);
    return `${file}:${stat.size}:${Math.round(stat.mtimeMs)}`;
  } catch {
    return `${file}:missing`;
  }
}

function entries(dir: string, filter?: (name: string) => boolean): string[] {
  const parts: string[] = [];
  for (const name of names(dir)) {
    if (filter !== undefined && !filter(name)) {
      continue;
    }
    parts.push(filePart(path.join(dir, name)));
  }
  return parts;
}

export function signature(plansDir: string, planId: string | null): string {
  let isDirectory = false;
  try {
    isDirectory = fs.statSync(plansDir).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    return "";
  }

  const parts: string[] = [];
  const traces = resolveInside(plansDir, "traces");
  if (traces !== null) {
    parts.push(...entries(traces, (name) => name.endsWith(".jsonl")));
  }

  const running = resolveInside(plansDir, "running");
  if (running !== null) {
    parts.push(...entries(running));
  }

  const done = resolveInside(plansDir, "done");
  if (done !== null) {
    parts.push(`done:[${names(done).join(",")}]`);
  }

  if (planId !== null) {
    const sessions = resolveInside(plansDir, "sessions", planId);
    if (sessions !== null) {
      parts.push(...entries(sessions));
    }
  }

  return parts.join("|");
}
