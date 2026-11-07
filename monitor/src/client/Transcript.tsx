import { useEffect, useRef, useState } from "react";
import type { Entry } from "../shared/types";
import { fetchSession, subscribe } from "./api";
import { highlightCode, languageFromPath, splitFences } from "./code";

const FOLLOW_SLACK = 24;

function summaryFor(entry: Entry): string {
  if (entry.kind === "user") return "task prompt";
  if (entry.kind === "thinking") return "thinking";
  return entry.kind;
}

function CodeBlock(props: { code: string; language?: string | null; preClassName?: string }) {
  const highlighted = highlightCode(props.code, props.language);
  return (
    <pre className={props.preClassName}>
      <code
        className={highlighted.language === null ? "hljs" : `hljs language-${highlighted.language}`}
        dangerouslySetInnerHTML={{ __html: highlighted.html }}
      />
    </pre>
  );
}

function RichText(props: { text: string }) {
  const parts = splitFences(props.text);
  if (parts.length === 1 && parts[0].code === null) {
    return <p>{props.text}</p>;
  }
  return (
    <div className="rich-text">
      {parts.map((part, index) =>
        part.code === null ? (
          <p className="entry-text" key={`text-${index}`}>
            {part.text}
          </p>
        ) : (
          <CodeBlock code={part.code.code} language={part.code.language} key={`code-${index}`} />
        ),
      )}
    </div>
  );
}

function argsLanguage(args: string): string | null {
  const trimmed = args.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "json";
  return languageFromPath(args);
}

function EntryBlock(props: { entry: Entry }) {
  const entry = props.entry;

  if (entry.collapsed) {
    return (
      <details className={`entry entry-${entry.kind}`}>
        <summary>{summaryFor(entry)}</summary>
        <RichText text={entry.text} />
      </details>
    );
  }

  switch (entry.kind) {
    case "assistant":
      return (
        <div className="entry entry-assistant">
          <RichText text={entry.text} />
        </div>
      );
    case "user":
    case "thinking":
      return (
        <div className={`entry entry-${entry.kind}`}>
          <RichText text={entry.text} />
        </div>
      );
    case "tool_call": {
      const name = entry.tool ? entry.tool.name : entry.text;
      const args = entry.tool ? entry.tool.args : "";
      return (
        <div className="entry entry-tool_call">
          <span className="tool-name">{name}</span>
          {args ? <CodeBlock code={args} language={argsLanguage(args)} preClassName="tool-args" /> : null}
        </div>
      );
    }
    case "tool_result":
      return (
        <div className="entry entry-tool_result">
          <CodeBlock
            code={entry.text}
            language={entry.tool ? languageFromPath(entry.tool.args) : null}
            preClassName={entry.isError ? "error" : undefined}
          />
        </div>
      );
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

export function Transcript(props: { repo: string; planId: string; attemptId: string | null }) {
  const repo = props.repo;
  const planId = props.planId;
  const attemptId = props.attemptId;
  const [entries, setEntries] = useState<Entry[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [following, setFollowing] = useState(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const followingRef = useRef(true);

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
        page = await fetchSession(repo, planId, attemptId, after);
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
  }, [repo, planId, attemptId]);

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
          <div className="transcript-empty">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
              <path d="M5 6.5h14M5 12h9M5 17.5h11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <span>Select a lane to read its transcript</span>
          </div>
        ) : status === "error" ? (
          <p className="muted">Session not available</p>
        ) : (
          <TranscriptView entries={entries} title={attemptId} />
        )}
      </div>
    </div>
  );
}
