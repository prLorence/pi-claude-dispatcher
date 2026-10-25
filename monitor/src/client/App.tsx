import { useEffect, useRef, useState } from "react";
import type { MonitorState } from "../shared/types";
import { fetchState, subscribe } from "./api";
import { RepoSection } from "./RepoSection";
import { Transcript } from "./Transcript";

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
  onToggle: (repo: string) => void;
  onSelect: (repo: string, planId: string, attemptId: string) => void;
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
  const { state, error, selection, expanded, onToggle, onSelect } = props;
  const repos = state === null ? [] : state.repos;

  return (
    <main className="app">
      <h1 className="app-title">Pi monitor</h1>
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
          {repos.map((repo) => {
            const planId = repo.plan === null ? null : repo.plan.id;
            const shown = expanded[repo.name];
            return (
              <RepoSection
                key={repo.name}
                repo={repo}
                expanded={shown === undefined ? repo.active : shown}
                onToggle={() => onToggle(repo.name)}
                selectedId={selectedIdFor(repo.name, planId, selection)}
                onSelect={onSelect}
              />
            );
          })}
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
  const ticketRef = useRef(0);

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
        return planId === prev.planId ? prev : null;
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
      onToggle={onToggle}
      onSelect={onSelect}
    />
  );
}
