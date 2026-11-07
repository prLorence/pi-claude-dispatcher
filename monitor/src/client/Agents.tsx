import type { AgentSession } from "../shared/types";
import { formatAgo, formatCost, formatTokens } from "./format";

export function AgentsBar(props: { sessions: AgentSession[] }) {
  const sessions = props.sessions;
  if (sessions.length === 0) return null;
  const now = sessions[0]?.mtimeMs === undefined ? null : new Date().toISOString();
  const ordered = [...sessions].sort((a, b) => b.mtimeMs - a.mtimeMs);

  return (
    <section className="agents" aria-labelledby="agents-title">
      <header className="agents-head">
        <h2 id="agents-title">Agents</h2>
        <span className="agents-count">
          <span className="live-dot" aria-hidden="true" />
          {sessions.length} running
        </span>
      </header>
      <div className="agent-grid">
        {ordered.map((session) => (
          <article
            className={`agent-card agent-${session.agent.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`}
            key={`${session.agent}-${session.id}`}
          >
            <div className="agent-top">
              <span className="agent-kind">{session.agent}</span>
              <span className="agent-live">live</span>
              <span className="agent-age">{formatAgo(new Date(session.mtimeMs).toISOString(), now)}</span>
            </div>
            <div className="agent-model">{session.model ?? "model -"}</div>
            <p className="agent-prompt">{session.prompt ?? "No prompt captured"}</p>
            <div className="agent-meta">
              <span>{formatTokens(session.tokens)} tokens</span>
              <span>{formatCost(session.cost)}</span>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
