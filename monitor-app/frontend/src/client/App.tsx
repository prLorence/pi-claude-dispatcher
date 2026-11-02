import { useEffect, useRef, useState } from "react";
import type { AgentGroup, AgentSession, MonitorState, Settings } from "../shared/types";
import { fetchAgentSession, fetchAgents, fetchSettings, saveSettings } from "./agents-api";
import { fetchState, subscribe } from "./api";
import { Detail } from "./Detail";
import { Repos } from "./Repos";
import { SettingsPanel } from "./SettingsPanel";
import { Sidebar } from "./Sidebar";
import type { Selection } from "./Sidebar";

export type { Selection };

interface AppViewProps {
  state: MonitorState | null;
  error: string | null;
  selection: Selection | null;
  expanded: Record<string, boolean>;
  onToggle: (repo: string) => void;
  onSelect: (repo: string, planId: string, attemptId: string) => void;
  settings?: Settings | null;
  agents?: AgentGroup[];
  settingsOpen?: boolean;
  settingsMessage?: string;
  onToggleSettings?: () => void;
  onChangeSettings?: (next: Settings) => void;
  onSelectAgent?: (agent: "omp" | "pi", group: string, id: string) => void;
}

export interface Snapshot {
  state: MonitorState;
  settings: Settings;
  agents: AgentGroup[];
}

export interface SnapshotSources {
  fetchState: () => Promise<MonitorState>;
  fetchSettings: () => Promise<Settings>;
  fetchAgents: () => Promise<AgentGroup[]>;
}

export function shouldFetchAgents(settings: Settings): boolean {
  return settings.ompSessions || settings.piSessions;
}

export async function loadSnapshot(sources: SnapshotSources): Promise<Snapshot> {
  const state = await sources.fetchState();
  const settings = await sources.fetchSettings();
  const agents = shouldFetchAgents(settings) ? await sources.fetchAgents() : [];
  return { state, settings, agents };
}

export function reconcileSelection(
  prev: Selection | null,
  state: MonitorState,
  agents: AgentGroup[] = [],
): Selection | null {
  if (prev === null) return null;
  if (prev.kind === "agent") {
    const found = agents.some(
      (group) =>
        group.name === prev.group &&
        group.sessions.some(
          (session) => session.agent === prev.agent && session.id === prev.id,
        ),
    );
    return found ? prev : null;
  }
  const repo = state.repos.find((entry) => entry.name === prev.repo);
  if (repo === undefined) return null;
  const planId = repo.plan === null ? null : repo.plan.id;
  return planId === prev.planId ? prev : null;
}

function findAgent(agents: AgentGroup[], selection: Selection | null): AgentSession | null {
  if (selection === null || selection.kind !== "agent") return null;
  for (const group of agents) {
    if (group.name !== selection.group) continue;
    for (const session of group.sessions) {
      if (session.agent === selection.agent && session.id === selection.id) return session;
    }
  }
  return null;
}

const noop = (): void => {};

export function AppView(props: AppViewProps) {
  const { state, error, selection, expanded, onToggle, onSelect } = props;
  const repos = state === null ? [] : state.repos;
  const settings = props.settings ?? null;
  const agents = props.agents ?? [];
  const settingsOpen = props.settingsOpen ?? false;
  const settingsMessage = props.settingsMessage ?? "";
  const onToggleSettings = props.onToggleSettings ?? noop;
  const onChangeSettings = props.onChangeSettings ?? noop;
  const onSelectAgent = props.onSelectAgent ?? noop;
  const agent = findAgent(agents, selection);

  const fetchPage =
    selection !== null && selection.kind === "agent"
      ? (after: number) =>
          fetchAgentSession(selection.agent, selection.group, selection.id, after)
      : undefined;

  return (
    <main className="app">
      <header className="app-header">
        <h1 className="app-title">Pi monitor</h1>
        <button
          type="button"
          className="settings-toggle-button"
          aria-expanded={settingsOpen}
          onClick={onToggleSettings}
        >
          Settings
        </button>
        <Repos names={repos.map((repo) => repo.name)} />
      </header>
      {settingsOpen && settings !== null ? (
        <SettingsPanel
          settings={settings}
          onChange={onChangeSettings}
          repoNames={repos.map((repo) => repo.name)}
          message={settingsMessage}
        />
      ) : null}
      {error !== null ? (
        <div className="banner banner-error" role="alert">
          Cannot reach the monitor server
        </div>
      ) : null}
      {state === null ? (
        <p className="muted">Loading</p>
      ) : (
        <>
          {state.message !== null ? <p className="muted state-message">{state.message}</p> : null}
          {repos.length === 0 ? <p className="muted">No repos configured</p> : null}
          <div className="panes">
            <Sidebar
              state={state}
              selection={selection}
              expanded={expanded}
              onToggle={onToggle}
              onSelectTask={onSelect}
              agents={agents}
              onSelectAgent={onSelectAgent}
            />
            <Detail state={state} selection={selection} agent={agent} fetchPage={fetchPage} />
          </div>
        </>
      )}
    </main>
  );
}

export function App() {
  const [state, setState] = useState<MonitorState | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [agents, setAgents] = useState<AgentGroup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [selection, setSelection] = useState<Selection | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState("");
  const ticketRef = useRef(0);

  useEffect(() => {
    let alive = true;

    const load = async (): Promise<void> => {
      ticketRef.current += 1;
      const ticket = ticketRef.current;
      let snapshot: Snapshot;
      try {
        snapshot = await loadSnapshot({ fetchState, fetchSettings, fetchAgents });
      } catch {
        if (!alive || ticket !== ticketRef.current) return;
        setError("Cannot reach the monitor server");
        return;
      }
      if (!alive || ticket !== ticketRef.current) return;
      setState(snapshot.state);
      setSettings(snapshot.settings);
      setAgents(snapshot.agents);
      setError(null);
      setSelection((prev) => reconcileSelection(prev, snapshot.state, snapshot.agents));
    };

    void load();
    const unsubscribe = subscribe(() => {
      void load();
    });

    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  const onToggle = (name: string): void => {
    const repo = state === null ? undefined : state.repos.find((entry) => entry.name === name);
    const shown = expanded[name] === undefined ? repo !== undefined && repo.active : expanded[name];
    setExpanded((prev) => ({ ...prev, [name]: !shown }));
  };

  const onSelect = (repo: string, planId: string, attemptId: string): void => {
    setSelection({ kind: "task", repo, planId, attemptId });
  };

  const onSelectAgent = (agent: "omp" | "pi", group: string, id: string): void => {
    setSelection({ kind: "agent", agent, group, id });
  };

  const onToggleSettings = (): void => {
    setSettingsOpen((prev) => !prev);
  };

  const onChangeSettings = async (next: Settings): Promise<void> => {
    try {
      const message = await saveSettings(next);
      setSettingsMessage(message);
    } catch {
      setSettingsMessage("Cannot save settings");
    }
  };

  return (
    <AppView
      state={state}
      error={error}
      selection={selection}
      expanded={expanded}
      onToggle={onToggle}
      onSelect={onSelect}
      settings={settings}
      agents={agents}
      settingsOpen={settingsOpen}
      settingsMessage={settingsMessage}
      onToggleSettings={onToggleSettings}
      onChangeSettings={(next) => {
        void onChangeSettings(next);
      }}
      onSelectAgent={onSelectAgent}
    />
  );
}
