import { useEffect, useRef, useState } from "react";
import type { AgentsState, MonitorState } from "../shared/types";
import { fetchAgents, fetchState, subscribe } from "./api";
import { formatClock } from "./format";
import { RepoSection } from "./RepoSection";
import { Transcript } from "./Transcript";
import { AgentsBar } from "./Agents";

interface Selection {
  repo: string;
  planId: string;
  attemptId: string;
}

interface AppViewProps {
  state: MonitorState | null;
  error: string | null;
  selection: Selection | null;
  expanded: Record<string, boolean>;
  agents?: AgentsState | null;
  embedded?: boolean;
  onToggle: (repo: string) => void;
  onSelect: (repo: string, planId: string, attemptId: string) => void;
}

export function isEmbedded(search: string): boolean {
  return new URLSearchParams(search).get("embed") === "1";
}

function selectedIdFor(
  repoName: string,
  planId: string | null,
  selection: Selection | null,
): string | null {
  if (selection === null) return null;
  if (selection.repo !== repoName) return null;
  if (selection.planId !== planId) return null;
  return selection.attemptId;
}

export function AppView(props: AppViewProps) {
  const { state, error, selection, expanded, agents = null, embedded = false, onToggle, onSelect } = props;
  const repos = state === null ? [] : state.repos;
  const active = repos.filter((repo) => repo.active).length;
  const tasks = repos.reduce((sum, repo) => sum + (repo.plan === null ? 0 : repo.plan.total), 0);
  const updated = state === null ? "-" : formatClock(state.now);
  const preview = active === 0 ? repos.find((repo) => repo.plan !== null)?.name ?? null : null;
  const liveAgents =
    agents === null
      ? []
      : agents.groups.flatMap((group) => group.sessions).filter((session) => session.live);

  return (
    <main className={embedded ? "app app-embed" : "app"}>
      <header className="app-bar">
        <div className="app-heading">
          <h1 className="app-title">Plan monitor</h1>
          <p className="app-sub">Live plan activity, attempts and verdicts.</p>
        </div>
        {state === null ? null : (
          <div className="app-stats" aria-label="Monitor summary">
            <span className="stat">
              <strong>{repos.length}</strong> projects
            </span>
            <span className={active > 0 ? "stat stat-live" : "stat"}>
              <span className={active > 0 ? "live-dot" : "idle-dot"} aria-hidden="true" />
              <strong>{active}</strong> running
            </span>
            <span className="stat">
              <strong>{tasks}</strong> tasks
            </span>
            <span className="stat stat-updated">updated {updated}</span>
          </div>
        )}
      </header>

      {error !== null ? (
        <div className="banner banner-error" role="alert">
          <div>
            <strong>Cannot reach the monitor server.</strong> The last snapshot could not be refreshed.
          </div>
          <button type="button" className="banner-link" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      ) : null}

      {state === null ? (
        error === null ? <div className="loading" role="status" aria-live="polite" aria-busy="true">
          <span className="sr-only">Loading monitor</span>
          <div className="skeleton skeleton-wide" />
          <div className="skeleton-row">
            <div className="skeleton" />
            <div className="skeleton" />
          </div>
        </div> : null
      ) : (
        <>
          {state.message !== null ? <p className="state-message">{state.message}</p> : null}
          <AgentsBar sessions={liveAgents} />

          {repos.length === 0 ? (
            <section className="empty-state empty-repos" aria-labelledby="no-repos-title">
              <div className="empty-mark" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none">
                  <path d="M4 6.5h6l1.5 2H20v9H4z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
                  <path d="M8 12.5h8M8 15h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </div>
              <div>
                <h2 id="no-repos-title">No repos configured</h2>
                <p>Add a git project from the Projects panel. Its plans, lanes and attempts will show up here.</p>
              </div>
            </section>
          ) : (
            <div className="repo-list">
              {repos.map((repo) => {
                const planId = repo.plan === null ? null : repo.plan.id;
                const shown = expanded[repo.name];
                return (
                  <RepoSection
                    key={repo.name}
                    repo={repo}
                    expanded={shown === undefined ? repo.active || repo.name === preview : shown}
                    now={state.now}
                    onToggle={() => onToggle(repo.name)}
                    selectedId={selectedIdFor(repo.name, planId, selection)}
                    onSelect={onSelect}
                  />
                );
              })}
            </div>
          )}

          {repos.length === 0 ? null : (
            <Transcript
              repo={selection === null ? repos[0].name : selection.repo}
              planId={selection === null ? "" : selection.planId}
              attemptId={selection === null ? null : selection.attemptId}
            />
          )}
        </>
      )}
    </main>
  );
}

export function App() {
  const [state, setState] = useState<MonitorState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [selection, setSelection] = useState<Selection | null>(null);
  const [agents, setAgents] = useState<AgentsState | null>(null);
  const ticketRef = useRef(0);
  const params = typeof window === "undefined" ? null : new URLSearchParams(window.location.search);
  const embedded = params !== null && isEmbedded(window.location.search);
  const theme = params?.get("theme") ?? null;

  useEffect(() => {
    const dark =
      theme === "dark" ||
      (theme !== "light" && typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("theme-dark", dark);
    document.body.classList.toggle("embed", embedded);
    return () => {
      document.documentElement.classList.remove("theme-dark");
      document.body.classList.remove("embed");
    };
  }, [embedded, theme]);

  useEffect(() => {
    let alive = true;
    const loadAgents = async (): Promise<void> => {
      try {
        const next = await fetchAgents();
        if (alive) setAgents(next);
      } catch {
        // The board is still useful when the agent scan is unavailable.
      }
    };
    void loadAgents();
    const timer = setInterval(loadAgents, 5_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let alive = true;

    const load = async (): Promise<void> => {
      ticketRef.current += 1;
      const ticket = ticketRef.current;
      let next: MonitorState;
      try {
        next = await fetchState();
      } catch {
        if (!alive || ticket !== ticketRef.current) return;
        setError("Cannot reach the monitor server");
        return;
      }
      if (!alive || ticket !== ticketRef.current) return;
      setState(next);
      setError(null);
      setSelection((prev) => {
        if (prev === null) return null;
        const repo = next.repos.find((entry) => entry.name === prev.repo);
        if (repo === undefined) return null;
        const planId = repo.plan === null ? null : repo.plan.id;
        if (planId !== prev.planId) return null;
        const tasks = repo.plan === null ? [] : repo.plan.tasks;
        const present = tasks.some((task) =>
          [task.implementer, task.reviewer].some((lane) =>
            lane === null ? false : lane.attempts.some((attempt) => attempt.id === prev.attemptId),
          ),
        );
        return present ? prev : null;
      });
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
    setSelection({ repo, planId, attemptId });
  };

  return (
    <AppView
      state={state}
      error={error}
      selection={selection}
      expanded={expanded}
      agents={agents}
      embedded={embedded}
      onToggle={onToggle}
      onSelect={onSelect}
    />
  );
}
