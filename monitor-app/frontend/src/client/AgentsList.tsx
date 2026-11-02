import type { AgentGroup, AgentSession } from "../shared/types";
import { formatCost, formatElapsed } from "./format";
import type { Selection } from "./Sidebar";

interface AgentsListProps {
  groups: AgentGroup[];
  repoName: string;
  nowMs: number;
  selection: Selection | null;
  onSelectAgent: (agent: "omp" | "pi", group: string, id: string) => void;
}

function isSelected(selection: Selection | null, session: AgentSession): boolean {
  if (selection === null || selection.kind !== "agent") return false;
  return (
    selection.agent === session.agent &&
    selection.group === session.group &&
    selection.id === session.id
  );
}

function age(session: AgentSession, nowMs: number): string {
  const seconds = (nowMs - session.mtimeMs) / 1000;
  return `${formatElapsed(seconds)} ago`;
}

export function AgentsList(props: AgentsListProps) {
  const { groups, repoName, nowMs, selection, onSelectAgent } = props;
  const sessions = groups
    .filter((group) => group.name === repoName)
    .flatMap((group) => group.sessions);

  if (sessions.length === 0) {
    return <p className="muted agents-empty">No agent sessions</p>;
  }

  return (
    <div className="agents-list">
      {sessions.map((session) => {
        const selected = isSelected(selection, session);
        const classes = ["agent-row", `agent-row-${session.agent}`];
        if (selected) classes.push("agent-row-selected");
        return (
          <button
            key={`${session.agent}/${session.group}/${session.id}`}
            type="button"
            className={classes.join(" ")}
            aria-current={selected ? "true" : undefined}
            onClick={() => {
              onSelectAgent(session.agent as "omp" | "pi", session.group, session.id);
            }}
          >
            <span className={`agent-badge agent-badge-${session.agent}`}>{session.agent}</span>
            <span className="agent-title">{session.title}</span>
            <span className="agent-model">{session.model ?? "-"}</span>
            {session.live ? <span className="agent-live">live</span> : null}
            <span className="agent-cost">{formatCost(session.cost)}</span>
            <span className="agent-age">{age(session, nowMs)}</span>
          </button>
        );
      })}
    </div>
  );
}
