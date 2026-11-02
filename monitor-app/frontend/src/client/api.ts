import type { MonitorState, SessionPage } from "../shared/types";
import { Session, State } from "../../wailsjs/go/main/App";
import { EventsOn } from "../../wailsjs/runtime/runtime";

export async function fetchState(): Promise<MonitorState> {
  const state = await State();
  // SAFETY: the Go binding returns the same JSON shape as MonitorState; the generated
  // model classes only type optional fields more loosely, so the cast is shape-only.
  return state as unknown as MonitorState;
}

export async function fetchSession(
  repo: string,
  plan: string,
  id: string,
  after: number,
): Promise<SessionPage> {
  const page = await Session(repo, plan, id, after);
  // SAFETY: the Go binding returns the same JSON shape as SessionPage; the generated
  // model classes only type optional fields more loosely, so the cast is shape-only.
  return page as unknown as SessionPage;
}

export function subscribe(onChange: () => void): () => void {
  return EventsOn("change", () => onChange());
}
