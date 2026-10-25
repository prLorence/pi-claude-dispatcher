import type { MonitorState, RepoView } from "../shared/types.ts";
import { applyDecider } from "./decider.ts";
import { buildPlanView } from "./lanes.ts";
import { readTraceEvents, selectPlan, type TraceEvent } from "./plans.ts";
import type { RepoConfig } from "./repos.ts";
import { listSessionFiles } from "./sessions.ts";

function tsOf(event: TraceEvent | undefined): string | null {
  if (event === undefined || typeof event.ts !== "string") {
    return null;
  }
  return Number.isFinite(Date.parse(event.ts)) ? event.ts : null;
}

function emptyRepo(name: string, message: string | null): RepoView {
  return {
    name,
    active: false,
    plan: null,
    message,
    startedAt: null,
    lastActivity: null,
  };
}

export function readRepo(repo: RepoConfig, nowMs: number): RepoView {
  try {
    const selected = selectPlan(repo.dir);
    if (selected.plan === null) {
      return emptyRepo(repo.name, selected.message);
    }

    const events = readTraceEvents(repo.dir, selected.plan.trace, selected.plan.id);
    const sessionFiles = listSessionFiles(repo.dir, selected.plan.id);
    const view = buildPlanView(
      selected.plan,
      selected.running,
      events,
      sessionFiles,
      nowMs,
    );
    const plan = applyDecider(view, events);

    return {
      name: repo.name,
      active: selected.running && plan !== null,
      plan,
      message: selected.message,
      startedAt: tsOf(events[0]),
      lastActivity: tsOf(events[events.length - 1]),
    };
  } catch {
    return emptyRepo(repo.name, "Could not read the plans folder");
  }
}

/** Compare two ISO timestamps; a null sorts last and a tie keeps the input order. */
function byTimeDesc(a: string | null, b: string | null): number {
  if (a === null && b === null) {
    return 0;
  }
  if (a === null) {
    return 1;
  }
  if (b === null) {
    return -1;
  }
  return Date.parse(b) - Date.parse(a);
}

export function readState(
  repos: RepoConfig[],
  nowMs: number = Date.now(),
  message: string | null = null,
): MonitorState {
  const now = new Date(nowMs).toISOString();
  const views = repos.map((repo) => readRepo(repo, nowMs));
  const active = views.filter((repo) => repo.active);
  const idle = views.filter((repo) => !repo.active);
  active.sort((a, b) => byTimeDesc(a.startedAt, b.startedAt));
  idle.sort((a, b) => byTimeDesc(a.lastActivity, b.lastActivity));
  return { repos: [...active, ...idle], message, now };
}
