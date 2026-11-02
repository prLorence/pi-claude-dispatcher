import { useEffect, useRef, useState } from "react";
import type { Entry, SessionPage } from "../shared/types";
import { fetchSession, subscribe } from "./api";
import { AssistantText, CodeView, DiffView } from "./CodeView";

const FOLLOW_SLACK = 24;

function codeViewFor(entry: Entry) {
  const code = entry.code;
  if (!code) return null;
  return code.kind === "diff" ? <DiffView block={code} /> : <CodeView block={code} />;
}

function summaryFor(entry: Entry): string {
  if (entry.kind === "user") return "task prompt";
  if (entry.kind === "thinking") return "thinking";
  return entry.kind;
}

function EntryBlock(props: { entry: Entry }) {
  const entry = props.entry;

  if (entry.collapsed) {
    return (
      <details className={`entry entry-${entry.kind}`}>
        <summary>{summaryFor(entry)}</summary>
        <p>{entry.text}</p>
      </details>
    );
  }

  switch (entry.kind) {
    case "assistant":
      return (
        <div className="entry entry-assistant">
          <AssistantText text={entry.text} />
        </div>
      );
    case "user":
    case "thinking":
      return (
        <div className={`entry entry-${entry.kind}`}>
          <p>{entry.text}</p>
        </div>
      );
    case "tool_call": {
      const name = entry.tool ? entry.tool.name : entry.text;
      const args = entry.tool ? entry.tool.args : "";
      const code = codeViewFor(entry);
      return (
        <div className="entry entry-tool_call">
          <span className="tool-name">{name}</span>
          {code ?? (args ? <span className="tool-args">{args}</span> : null)}
        </div>
      );
    }
    case "tool_result": {
      const code = codeViewFor(entry);
      if (code) {
        return (
          <div className="entry entry-tool_result">
            {entry.tool ? <span className="tool-name">{entry.tool.name}</span> : null}
            {code}
          </div>
        );
      }
      return (
        <div className="entry entry-tool_result">
          <pre className={entry.isError ? "error" : undefined}>{entry.text}</pre>
        </div>
      );
    }
    case "note":
      return <div className="entry entry-note muted">{entry.text}</div>;
    default:
      return null;
  }
}

export function TranscriptView(props: { entries: Entry[]; title: string }) {
  return (
    <div className="transcript-view">
      <div className="transcript-head">{props.title}</div>
      {props.entries.length === 0 ? (
        <p className="muted">No output yet</p>
      ) : (
        props.entries.map((entry) => <EntryBlock key={entry.line} entry={entry} />)
      )}
    </div>
  );
}

type Status = "idle" | "loading" | "ready" | "error";

export function transcriptLoadKey(props: {
  repo: string;
  planId: string;
  attemptId: string | null;
  resetKey?: string;
}): string {
  return `${props.repo}|${props.planId}|${props.attemptId}|${props.resetKey ?? ""}`;
}

export function Transcript(props: {
  repo: string;
  planId: string;
  attemptId: string | null;
  fetchPage?: (after: number) => Promise<SessionPage>;
  resetKey?: string;
}) {
  const repo = props.repo;
  const planId = props.planId;
  const attemptId = props.attemptId;
  const [entries, setEntries] = useState<Entry[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [following, setFollowing] = useState(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const followingRef = useRef(true);
  const fetchPageRef = useRef(props.fetchPage);
  fetchPageRef.current = props.fetchPage;
  const loadKey = transcriptLoadKey({ repo, planId, attemptId, resetKey: props.resetKey });

  useEffect(() => {
    followingRef.current = true;
    setFollowing(true);
    setEntries([]);
    setStatus(attemptId === null ? "idle" : "loading");

    if (attemptId === null) {
      return;
    }

    let cancelled = false;
    let busy = false;
    let again = false;
    let next = 0;
    const seen = new Set<number>();

    const fetchOnce = async (): Promise<void> => {
      const after = next;
      let page;
      try {
        const fetchPage = fetchPageRef.current;
        page = fetchPage
          ? await fetchPage(after)
          : await fetchSession(repo, planId, attemptId, after);
      } catch {
        if (!cancelled) setStatus("error");
        return;
      }
      if (cancelled) return;
      const fresh = page.entries.filter((entry) => {
        if (seen.has(entry.line)) return false;
        seen.add(entry.line);
        return true;
      });
      if (typeof page.next === "number" && page.next > next) next = page.next;
      if (fresh.length > 0) {
        setEntries((prev) => [...prev, ...fresh]);
      }
      setStatus("ready");
    };

    const load = async (): Promise<void> => {
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      try {
        do {
          again = false;
          await fetchOnce();
        } while (again && !cancelled);
      } finally {
        busy = false;
      }
    };

    void load();
    const unsubscribe = subscribe(() => {
      void load();
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadKey]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && followingRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [entries]);

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK;
    followingRef.current = atBottom;
    setFollowing(atBottom);
  };

  const jumpToLatest = (): void => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    followingRef.current = true;
    setFollowing(true);
  };

  const showJump = attemptId !== null && status === "ready" && !following;

  return (
    <div className="transcript-wrap">
      {showJump ? (
        <button type="button" className="jump-latest" onClick={jumpToLatest}>
          Jump to latest
        </button>
      ) : null}
      <div className="transcript" ref={scrollRef} onScroll={onScroll}>
        {attemptId === null ? (
          <p className="muted">Select a lane to read its transcript</p>
        ) : status === "error" ? (
          <p className="muted">Session not available</p>
        ) : (
          <TranscriptView entries={entries} title={attemptId} />
        )}
      </div>
    </div>
  );
}
