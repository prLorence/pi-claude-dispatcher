import type { MonitorState, SessionPage } from "../shared/types";

export async function fetchState(): Promise<MonitorState> {
  const res = await fetch("/api/state");
  if (!res.ok) {
    throw new Error(`GET /api/state failed with ${res.status}`);
  }
  return (await res.json()) as MonitorState;
}

export async function fetchSession(
  repo: string,
  plan: string,
  id: string,
  after: number,
): Promise<SessionPage> {
  const url = `/api/session/${encodeURIComponent(repo)}/${encodeURIComponent(plan)}/${encodeURIComponent(id)}?after=${after}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GET ${url} failed with ${res.status}`);
  }
  return (await res.json()) as SessionPage;
}

export function subscribe(onChange: () => void): () => void {
  const events = new EventSource("/api/events");
  let timer: ReturnType<typeof setInterval> | null = null;

  const startPolling = (): void => {
    if (timer !== null) return;
    timer = setInterval(onChange, 3000);
  };

  const stopPolling = (): void => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  };

  events.addEventListener("hello", () => onChange());
  events.addEventListener("change", () => onChange());
  events.onopen = () => stopPolling();
  events.onerror = () => startPolling();

  return () => {
    stopPolling();
    events.close();
  };
}
