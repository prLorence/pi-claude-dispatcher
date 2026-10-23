import type {
  Attempt,
  Lane,
  LaneState,
  PlanView,
  ReviewResult,
  TaskRow,
  Verdict,
} from "../shared/types.ts";
import type { ParsedPlan, PlanTask, TraceEvent } from "./plans.ts";
import { summarizeSession, type SessionSummary } from "./sessions.ts";

export const STALL_MS = 30000;

type Summarize = (file: string | null) => SessionSummary;

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function dataOf(event: TraceEvent): Record<string, unknown> {
  return event.data ?? {};
}

function eventData(event: TraceEvent | null): Record<string, unknown> {
  return event === null ? {} : dataOf(event);
}

function numberOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function attemptNumberOf(event: TraceEvent): number | null {
  return numberOf(event.attempt);
}

function sessionIdOf(event: TraceEvent): string | null {
  const value = dataOf(event).session_id;
  return typeof value === "string" && value !== "" ? value : null;
}

function roundOf(event: TraceEvent): number | null {
  return numberOf(dataOf(event).round);
}

function textOf(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** A `task.end` state: failed by `failed`, or by `retry` with `ok: false`. */
function endStateOf(event: TraceEvent): LaneState {
  const data = dataOf(event);
  if (data.state === "failed") {
    return "failed";
  }
  if (data.state === "retry" && data.ok === false) {
    return "failed";
  }
  return "done";
}

function freshness(summary: SessionSummary, running: boolean, nowMs: number): LaneState {
  if (running && nowMs - summary.mtimeMs <= STALL_MS) {
    return "live";
  }
  return "stalled";
}

function elapsedSeconds(
  summary: SessionSummary,
  state: LaneState,
  nowMs: number,
): number | null {
  if (summary.startedAt === null) {
    return null;
  }
  const start = Date.parse(summary.startedAt);
  if (!Number.isFinite(start)) {
    return null;
  }
  let end = summary.lastTs === null ? Number.NaN : Date.parse(summary.lastTs);
  if (!Number.isFinite(end)) {
    if (state !== "live") {
      return null;
    }
    end = nowMs;
  }
  return Math.max(0, Math.round((end - start) / 1000));
}

interface ImplementerSlot {
  num: number;
  sessionId: string;
  file: string | null;
  startEvent: TraceEvent | null;
  endEvent: TraceEvent | null;
}

interface ReviewerSlot {
  round: number;
  attempt: number;
  sessionId: string;
  file: string | null;
  event: TraceEvent | null;
}

/**
 * The attempts of one implementer lane: first the ones the events name, then
 * the session files the events do not know yet. Sorted by attempt number.
 */
function implementerSlots(
  plan: ParsedPlan,
  task: PlanTask,
  taskEvents: TraceEvent[],
  sessionFiles: { id: string; file: string }[],
  fileById: Map<string, string>,
): ImplementerSlot[] {
  const slots = new Map<number, ImplementerSlot>();
  const ensure = (num: number): ImplementerSlot => {
    const found = slots.get(num);
    if (found !== undefined) {
      return found;
    }
    const slot: ImplementerSlot = {
      num,
      sessionId: `${plan.id}.${task.id}.a${num}`,
      file: null,
      startEvent: null,
      endEvent: null,
    };
    slots.set(num, slot);
    return slot;
  };

  for (const event of taskEvents) {
    if (event.kind === "task.start") {
      const num = attemptNumberOf(event);
      if (num === null) {
        continue;
      }
      const slot = ensure(num);
      slot.startEvent = event;
      const sessionId = sessionIdOf(event);
      if (sessionId !== null) {
        slot.sessionId = sessionId;
      }
    } else if (event.kind === "task.end") {
      const num = attemptNumberOf(event);
      if (num === null) {
        continue;
      }
      ensure(num).endEvent = event;
    }
  }

  const pattern = new RegExp(`^${escapeRe(plan.id)}\\.${escapeRe(task.id)}\\.a(\\d+)$`);
  for (const item of sessionFiles) {
    const match = pattern.exec(item.id);
    if (match === null) {
      continue;
    }
    const num = Number.parseInt(match[1], 10);
    const existing = slots.get(num);
    if (existing !== undefined) {
      if (existing.file === null) {
        existing.file = item.file;
        existing.sessionId = item.id;
      }
      continue;
    }
    slots.set(num, {
      num,
      sessionId: item.id,
      file: item.file,
      startEvent: null,
      endEvent: null,
    });
  }

  for (const slot of slots.values()) {
    if (slot.file === null) {
      slot.file = fileById.get(slot.sessionId) ?? null;
    }
  }

  return [...slots.values()].sort((a, b) => a.num - b.num);
}

/**
 * The attempts of one reviewer lane: the rounds the events name, then the
 * session files nobody has reported yet (a running reviewer has no event).
 * Sorted by round, then attempt.
 */
function reviewerSlots(
  plan: ParsedPlan,
  task: PlanTask,
  taskEvents: TraceEvent[],
  sessionFiles: { id: string; file: string }[],
  fileById: Map<string, string>,
): ReviewerSlot[] {
  const slots: ReviewerSlot[] = [];

  for (const event of taskEvents) {
    if (event.kind !== "task.review") {
      continue;
    }
    const round = roundOf(event);
    if (round === null) {
      continue;
    }
    const sessionId = sessionIdOf(event);
    slots.push({
      round,
      attempt: attemptNumberOf(event) ?? 1,
      sessionId: sessionId ?? `${plan.id}.${task.id}.review${round}.a1`,
      file: sessionId === null ? null : fileById.get(sessionId) ?? null,
      event,
    });
  }

  const pattern = new RegExp(
    `^${escapeRe(plan.id)}\\.${escapeRe(task.id)}\\.review(\\d+)\\.a(\\d+)$`,
  );
  for (const item of sessionFiles) {
    const match = pattern.exec(item.id);
    if (match === null) {
      continue;
    }
    const round = Number.parseInt(match[1], 10);
    const attempt = Number.parseInt(match[2], 10);
    if (slots.some((slot) => slot.sessionId === item.id)) {
      continue;
    }
    const open = slots.find((slot) => slot.round === round && slot.file === null);
    if (open !== undefined) {
      open.file = item.file;
      open.sessionId = item.id;
      open.attempt = attempt;
      continue;
    }
    slots.push({
      round,
      attempt,
      sessionId: item.id,
      file: item.file,
      event: null,
    });
  }

  return slots.sort((a, b) => a.round - b.round || a.attempt - b.attempt);
}

function implementerState(
  summary: SessionSummary,
  slot: ImplementerSlot,
  running: boolean,
  nowMs: number,
): LaneState {
  if (summary.exists) {
    if (!summary.ended) {
      return freshness(summary, running, nowMs);
    }
    if (summary.stopReason === "error" || summary.stopReason === "aborted") {
      return "failed";
    }
    return slot.endEvent === null ? "done" : endStateOf(slot.endEvent);
  }
  if (slot.endEvent !== null) {
    return endStateOf(slot.endEvent);
  }
  if (slot.startEvent !== null && running) {
    return "live";
  }
  return "waiting";
}

function verdictOf(value: unknown): Verdict {
  if (value === "approve") {
    return "approve";
  }
  if (value === "changes") {
    return "changes";
  }
  return "unknown";
}

function findingsOf(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.length;
  }
  return null;
}

function buildReview(event: TraceEvent, summary: SessionSummary): ReviewResult {
  const data = dataOf(event);
  const verdict = verdictOf(data.verdict);
  return {
    verdict,
    findings: findingsOf(data.findings),
    failed: data.ok === false || verdict === "unknown",
    text: summary.lastText,
  };
}

function reviewerState(
  summary: SessionSummary,
  review: ReviewResult | null,
  running: boolean,
  nowMs: number,
): LaneState {
  if (summary.exists) {
    if (!summary.ended) {
      return freshness(summary, running, nowMs);
    }
    return review !== null && review.failed ? "failed" : "done";
  }
  if (review !== null) {
    return review.failed ? "failed" : "done";
  }
  return "waiting";
}

function implementerAttempt(
  slot: ImplementerSlot,
  running: boolean,
  nowMs: number,
  summarize: Summarize,
): Attempt {
  const summary = summarize(slot.file);
  const state = implementerState(summary, slot, running, nowMs);
  const startData = eventData(slot.startEvent);
  const endData = eventData(slot.endEvent);
  return {
    id: slot.sessionId,
    label: `a${slot.num}`,
    state,
    model: textOf(startData.model) ?? textOf(endData.model) ?? summary.model,
    thinking: textOf(startData.thinking) ?? textOf(endData.thinking) ?? summary.thinking,
    startedAt: summary.startedAt,
    elapsedS: elapsedSeconds(summary, state, nowMs),
    tokens: summary.tokens,
    cost: summary.cost,
    lastTool: summary.lastTool,
    error: summary.error,
    hasSession: summary.exists,
    review: null,
  };
}

function reviewerAttempt(
  slot: ReviewerSlot,
  running: boolean,
  nowMs: number,
  summarize: Summarize,
): Attempt {
  const summary = summarize(slot.file);
  const data = eventData(slot.event);
  const review = slot.event === null ? null : buildReview(slot.event, summary);
  const state = reviewerState(summary, review, running, nowMs);
  return {
    id: slot.sessionId,
    label: `r${slot.round}`,
    state,
    model: textOf(data.model) ?? summary.model,
    thinking: textOf(data.thinking) ?? summary.thinking,
    startedAt: summary.startedAt,
    elapsedS: elapsedSeconds(summary, state, nowMs),
    tokens: summary.tokens,
    cost: summary.cost,
    lastTool: summary.lastTool,
    error: summary.error,
    hasSession: summary.exists,
    review,
  };
}

function laneOf(attempts: Attempt[]): Lane {
  const newest = attempts.length === 0 ? null : attempts[attempts.length - 1];
  return {
    state: newest === null ? "waiting" : newest.state,
    attempts,
  };
}

function emptyLane(): Lane {
  return { state: "waiting", attempts: [] };
}

export function buildPlanView(
  plan: ParsedPlan,
  running: boolean,
  events: TraceEvent[],
  sessionFiles: { id: string; file: string }[],
  nowMs: number,
  summarize: Summarize = summarizeSession,
): PlanView {
  const fileById = new Map<string, string>();
  for (const item of sessionFiles) {
    if (!fileById.has(item.id)) {
      fileById.set(item.id, item.file);
    }
  }

  const eventsByTask = new Map<string, TraceEvent[]>();
  for (const event of events) {
    if (typeof event.task !== "string" || event.task === "") {
      continue;
    }
    const list = eventsByTask.get(event.task);
    if (list === undefined) {
      eventsByTask.set(event.task, [event]);
    } else {
      list.push(event);
    }
  }

  const latestEndOf = (taskId: string): TraceEvent | null => {
    let found: TraceEvent | null = null;
    for (const event of eventsByTask.get(taskId) ?? []) {
      if (event.kind === "task.end") {
        found = event;
      }
    }
    return found;
  };

  const isDoneTask = (taskId: string): boolean => {
    const end = latestEndOf(taskId);
    return end !== null && dataOf(end).state === "done";
  };

  const tasks: TaskRow[] = plan.tasks.map((task) => {
    const taskEvents = eventsByTask.get(task.id) ?? [];
    const skipped = !running && taskEvents.length === 0;
    const waitsFor = skipped ? [] : task.dependsOn.filter((id) => !isDoneTask(id));

    const implementers = skipped
      ? []
      : implementerSlots(plan, task, taskEvents, sessionFiles, fileById).map((slot) =>
          implementerAttempt(slot, running, nowMs, summarize),
        );
    const reviewers =
      skipped || task.pair === null
        ? []
        : reviewerSlots(plan, task, taskEvents, sessionFiles, fileById).map((slot) =>
            reviewerAttempt(slot, running, nowMs, summarize),
          );

    return {
      id: task.id,
      role: task.role,
      pair: task.pair,
      dependsOn: task.dependsOn,
      waitsFor,
      skipped,
      implementer: skipped ? emptyLane() : laneOf(implementers),
      reviewer: task.pair === null ? null : skipped ? emptyLane() : laneOf(reviewers),
    };
  });

  let planEnd: TraceEvent | null = null;
  for (const event of events) {
    if (event.kind === "plan.end") {
      planEnd = event;
    }
  }
  const gatePass = planEnd === null ? null : dataOf(planEnd).gate_pass;
  const gate: "pass" | "fail" | null =
    gatePass === true ? "pass" : gatePass === false ? "fail" : null;

  return {
    id: plan.id,
    trace: plan.trace,
    round: plan.round,
    state: running ? "running" : gate === "fail" ? "failed" : "done",
    gate,
    done: plan.tasks.filter((task) => isDoneTask(task.id)).length,
    total: plan.tasks.length,
    tasks,
  };
}
