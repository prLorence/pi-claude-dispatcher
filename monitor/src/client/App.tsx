import { useEffect, useRef, useState } from "react";
import type { MonitorState } from "../shared/types";
import { fetchState, subscribe } from "./api";
import { Board } from "./Board";
import { Transcript } from "./Transcript";

interface AppViewProps {
  state: MonitorState | null;
  error: string | null;
  selectedId: string | null;
  onSelect: (planId: string, attemptId: string) => void;
}

export function AppView(props: AppViewProps) {
  const { state, error, selectedId, onSelect } = props;
  const plan = state === null ? null : state.plan;

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
      ) : plan === null ? (
        <p className="muted">{state.message ?? "No plan to show"}</p>
      ) : (
        <>
          <Board plan={plan} selectedId={selectedId} onSelect={onSelect} />
          <Transcript planId={plan.id} attemptId={selectedId} />
        </>
      )}
    </main>
  );
}

interface Selection {
  planId: string;
  attemptId: string;
}

export function App() {
  const [state, setState] = useState<MonitorState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const ticketRef = useRef(0);
  const planRef = useRef<string | null>(null);

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
      const planId = next.plan === null ? null : next.plan.id;
      if (planId !== planRef.current) {
        planRef.current = planId;
        setSelection(null);
      }
      setState(next);
      setError(null);
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

  const onSelect = (planId: string, attemptId: string): void => {
    setSelection({ planId, attemptId });
  };

  const selectedId =
    selection !== null && state !== null && state.plan !== null && state.plan.id === selection.planId
      ? selection.attemptId
      : null;

  return <AppView state={state} error={error} selectedId={selectedId} onSelect={onSelect} />;
}
