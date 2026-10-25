import type {
  DeciderAuditView,
  DeciderTaskView,
  PlanView,
} from "../shared/types.ts";
import type { TraceEvent } from "./plans.ts";

function dataOf(event: TraceEvent): Record<string, unknown> {
  return event.data ?? {};
}

/** The task an event belongs to: the top-level field, else `data.task`. */
function taskOf(event: TraceEvent): string | null {
  if (typeof event.task === "string" && event.task !== "") {
    return event.task;
  }
  const fromData = dataOf(event).task;
  return typeof fromData === "string" && fromData !== "" ? fromData : null;
}

function tsOf(event: TraceEvent): number {
  const value = Date.parse(event.ts);
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

function numberOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function textOf(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function probabilitiesOf(value: unknown): Record<string, number> {
  const result: Record<string, number> = {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return result;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const num = numberOf(entry);
    if (num !== null) {
      result[key] = num;
    }
  }
  return result;
}

/** True when `a` is at least as late as `b`, so the later event in the file wins a tie. */
function atLeastAsLate(a: TraceEvent, b: TraceEvent): boolean {
  return tsOf(a) >= tsOf(b);
}

function attemptOf(event: TraceEvent): number {
  return numberOf(event.attempt) ?? Number.POSITIVE_INFINITY;
}

/** True when `a` starts before `b`: lowest attempt first, then earliest `ts`. */
function startsBefore(a: TraceEvent, b: TraceEvent): boolean {
  const attemptA = attemptOf(a);
  const attemptB = attemptOf(b);
  if (attemptA !== attemptB) {
    return attemptA < attemptB;
  }
  return tsOf(a) < tsOf(b);
}

function effortView(event: TraceEvent, start: TraceEvent | null): DeciderTaskView {
  const data = dataOf(event);
  const startData: Record<string, unknown> = start === null ? {} : dataOf(start);
  return {
    suggested: textOf(data.suggested) ?? "",
    probabilities: probabilitiesOf(data.probabilities),
    confidence: numberOf(data.confidence),
    complexity: numberOf(data.complexity),
    ran: textOf(startData.thinking),
  };
}

function findingsOf(value: unknown): DeciderAuditView["findings"] {
  if (!Array.isArray(value)) {
    return [];
  }
  const findings: DeciderAuditView["findings"] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const item = entry as Record<string, unknown>;
    const id = textOf(item.id);
    const severity = textOf(item.severity);
    const p = numberOf(item.p);
    if (id === null || severity === null || p === null) {
      continue;
    }
    findings.push({ id, severity, p });
  }
  return findings;
}

function auditView(event: TraceEvent): DeciderAuditView {
  const data = dataOf(event);
  return {
    proposal: textOf(data.proposal) ?? "unknown",
    aggregate: numberOf(data.aggregate) ?? 0,
    verdict: textOf(data.verdict) ?? "unknown",
    auditRound: numberOf(data.audit_round) ?? 0,
    findings: findingsOf(data.findings),
  };
}

/**
 * The decider's view of one plan: each task's latest `decision.effort`
 * suggestion next to the thinking level its first `task.start` ran with, and
 * the latest `decision.audit` of the plan.
 */
export function applyDecider(plan: PlanView, events: TraceEvent[]): PlanView {
  const latestEffort = new Map<string, TraceEvent>();
  const firstStart = new Map<string, TraceEvent>();
  let latestAudit: TraceEvent | null = null;

  for (const event of events) {
    if (event.kind === "decision.effort") {
      const task = taskOf(event);
      if (task === null || textOf(dataOf(event).suggested) === null) {
        continue;
      }
      const previous = latestEffort.get(task);
      if (previous === undefined || atLeastAsLate(event, previous)) {
        latestEffort.set(task, event);
      }
    } else if (event.kind === "task.start") {
      const task = taskOf(event);
      if (task === null) {
        continue;
      }
      const previous = firstStart.get(task);
      if (previous === undefined || startsBefore(event, previous)) {
        firstStart.set(task, event);
      }
    } else if (event.kind === "decision.audit") {
      if (latestAudit === null || atLeastAsLate(event, latestAudit)) {
        latestAudit = event;
      }
    }
  }

  const tasks = plan.tasks.map((task) => {
    const effort = latestEffort.get(task.id);
    const start = firstStart.get(task.id) ?? null;
    return {
      ...task,
      decider: effort === undefined ? null : effortView(effort, start),
    };
  });

  return {
    ...plan,
    tasks,
    audit: latestAudit === null ? null : auditView(latestAudit),
  };
}
