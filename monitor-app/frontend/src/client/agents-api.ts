import type { AgentGroup, SessionPage, Settings } from "../shared/types";
import * as Bindings from "../../wailsjs/go/main/App";

export async function fetchSettings(): Promise<Settings> {
  const value = await Bindings.Settings();
  // SAFETY: the Go binding returns the same JSON shape as Settings; the generated
  // model class only types the fields more loosely, so the cast is shape-only.
  return value as unknown as Settings;
}

export async function saveSettings(settings: Settings): Promise<string> {
  return Bindings.SetSettings(
    // SAFETY: the generated class takes the same fields as Settings; the binding
    // only reads the JSON shape.
    settings as unknown as Parameters<typeof Bindings.SetSettings>[0],
  );
}

export async function fetchAgents(): Promise<AgentGroup[]> {
  const groups = await Bindings.Agents();
  // SAFETY: the Go binding returns the same JSON shape as AgentGroup[]; the
  // generated model classes only type the fields more loosely, so the cast is
  // shape-only.
  return groups as unknown as AgentGroup[];
}

export async function fetchAgentSession(
  agent: string,
  group: string,
  id: string,
  after: number,
): Promise<SessionPage> {
  const page = await Bindings.AgentSession(agent, group, id, after);
  // SAFETY: the Go binding returns the same JSON shape as SessionPage; the
  // generated model classes only type optional fields more loosely, so the cast
  // is shape-only.
  return page as unknown as SessionPage;
}
