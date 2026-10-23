import type { MonitorState } from "../shared/types.ts";
import { buildPlanView } from "./lanes.ts";
import { listSessionFiles } from "./sessions.ts";
import { readTraceEvents, selectPlan } from "./plans.ts";

export function readState(plansDir: string, nowMs: number = Date.now()): MonitorState {
  const now = new Date(nowMs).toISOString();
  try {
    const selected = selectPlan(plansDir);
    if (selected.plan === null) {
      return { plan: null, message: selected.message, now };
    }

    const events = readTraceEvents(plansDir, selected.plan.trace, selected.plan.id);
    const sessionFiles = listSessionFiles(plansDir, selected.plan.id);
    const plan = buildPlanView(
      selected.plan,
      selected.running,
      events,
      sessionFiles,
      nowMs,
    );
    return { plan, message: null, now };
  } catch {
    return { plan: null, message: "Could not read the plans folder", now };
  }
}
