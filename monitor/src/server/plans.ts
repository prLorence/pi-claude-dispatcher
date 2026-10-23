import * as fs from "node:fs";
import * as path from "node:path";
import { resolveInside } from "./http.ts";

export interface PlanTask {
  id: string;
  role: string;
  pair: string | null;
  dependsOn: string[];
}

export interface ParsedPlan {
  id: string;
  trace: string;
  round: number;
  tasks: PlanTask[];
}

export interface TraceEvent {
  ts: string;
  kind: string;
  plan?: string;
  task?: string;
  attempt?: number;
  data?: Record<string, any>;
}

const KEY_LINE_RE = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/;
const TASK_HEADING_RE = /^##\s+task\s*:\s*(.+?)\s*$/;

function cleanValue(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("#")) {
    return "";
  }
  let value = trimmed.replace(/\s+#.*$/, "").trim();
  if (
    value.length >= 2 &&
    ((value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1).trim();
  }
  return value;
}

function parseList(raw: string): string[] {
  const value = raw.trim();
  const inner =
    value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  return inner
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function parsePlan(text: string): ParsedPlan | null {
  const lines = text.split(/\r?\n/);
  const open = lines.findIndex((line) => line.trim() === "---");
  if (open === -1) {
    return null;
  }
  const closeRel = lines.slice(open + 1).findIndex((line) => line.trim() === "---");
  if (closeRel === -1) {
    return null;
  }
  const close = open + 1 + closeRel;

  const meta = new Map<string, string>();
  for (const line of lines.slice(open + 1, close)) {
    const match = KEY_LINE_RE.exec(line);
    if (match === null) {
      continue;
    }
    meta.set(match[1].toLowerCase(), cleanValue(match[2]));
  }

  const id = meta.get("id");
  if (id === undefined || id === "") {
    return null;
  }
  const trace = meta.get("trace");
  const roundRaw = meta.get("round");
  const parsedRound = roundRaw === undefined ? 1 : Number.parseInt(roundRaw, 10);
  const round = Number.isFinite(parsedRound) ? parsedRound : 1;

  const tasks: PlanTask[] = [];
  let current: PlanTask | null = null;
  let inMeta = false;

  for (const line of lines.slice(close + 1)) {
    const heading = TASK_HEADING_RE.exec(line);
    if (heading !== null) {
      current = { id: heading[1], role: "implement", pair: null, dependsOn: [] };
      tasks.push(current);
      inMeta = true;
      continue;
    }
    if (current === null || !inMeta) {
      continue;
    }
    if (line.trim() === "") {
      inMeta = false;
      continue;
    }
    const match = KEY_LINE_RE.exec(line);
    if (match === null) {
      inMeta = false;
      continue;
    }
    const key = match[1].toLowerCase();
    const value = cleanValue(match[2]);
    if (key === "depends_on") {
      current.dependsOn = parseList(match[2]);
    } else if (key === "role") {
      if (value !== "") {
        current.role = value;
      }
    } else if (key === "pair") {
      current.pair = value === "" ? null : value;
    }
  }

  return {
    id,
    trace: trace === undefined || trace === "" ? id : trace,
    round,
    tasks,
  };
}

export function readTraceEvents(
  plansDir: string,
  trace: string,
  planId: string,
): TraceEvent[] {
  const file = resolveInside(plansDir, "traces", `${trace}.jsonl`);
  if (file === null) {
    return [];
  }
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const events: TraceEvent[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue;
    }
    const event = parsed as TraceEvent;
    if (event.plan !== planId) {
      continue;
    }
    events.push(event);
  }
  return events;
}

function readPlanFile(file: string): ParsedPlan | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  return parsePlan(text);
}

interface Candidate {
  plan: ParsedPlan;
  key: number;
}

function selectNewest(candidates: Candidate[]): ParsedPlan | null {
  let best: Candidate | null = null;
  for (const candidate of candidates) {
    if (best === null || candidate.key > best.key) {
      best = candidate;
    }
  }
  return best === null ? null : best.plan;
}

function selectRunning(plansDir: string): ParsedPlan | null {
  let names: string[];
  try {
    names = fs.readdirSync(path.join(plansDir, "running"));
  } catch {
    return null;
  }
  const candidates: Candidate[] = [];
  for (const name of names) {
    if (!name.endsWith(".md")) {
      continue;
    }
    const file = resolveInside(plansDir, "running", name);
    if (file === null) {
      continue;
    }
    const plan = readPlanFile(file);
    if (plan === null) {
      continue;
    }
    let key = 0;
    try {
      key = fs.statSync(file).mtimeMs;
    } catch {
      key = 0;
    }
    candidates.push({ plan, key });
  }
  return selectNewest(candidates);
}

function doneKey(plansDir: string, plan: ParsedPlan, folder: string): number {
  const events = readTraceEvents(plansDir, plan.trace, plan.id);
  let key: number | null = null;
  for (const event of events) {
    if (event.kind !== "plan.end") {
      continue;
    }
    const ts = Date.parse(event.ts);
    if (Number.isFinite(ts)) {
      key = ts;
    }
  }
  if (key !== null) {
    return key;
  }
  try {
    return fs.statSync(folder).mtimeMs;
  } catch {
    return 0;
  }
}

function selectDone(plansDir: string): ParsedPlan | null {
  let names: string[];
  try {
    names = fs.readdirSync(path.join(plansDir, "done"));
  } catch {
    return null;
  }
  const candidates: Candidate[] = [];
  for (const name of names) {
    const folder = resolveInside(plansDir, "done", name);
    if (folder === null) {
      continue;
    }
    const file = resolveInside(plansDir, "done", name, "plan.md");
    if (file === null) {
      continue;
    }
    const plan = readPlanFile(file);
    if (plan === null) {
      continue;
    }
    candidates.push({ plan, key: doneKey(plansDir, plan, folder) });
  }
  return selectNewest(candidates);
}

export function selectPlan(plansDir: string): {
  plan: ParsedPlan | null;
  running: boolean;
  message: string | null;
} {
  let isDirectory = false;
  try {
    isDirectory = fs.statSync(plansDir).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    return { plan: null, running: false, message: "No plans folder found" };
  }

  const running = selectRunning(plansDir);
  if (running !== null) {
    return { plan: running, running: true, message: null };
  }

  const done = selectDone(plansDir);
  if (done !== null) {
    return { plan: done, running: false, message: null };
  }

  return { plan: null, running: false, message: "No plan has run yet" };
}
