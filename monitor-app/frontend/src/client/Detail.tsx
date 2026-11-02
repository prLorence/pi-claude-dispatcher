import type {
  AgentSession,
  Attempt,
  MonitorState,
  SessionPage,
  TaskRow,
} from "../shared/types";
import { formatCost, formatElapsed, formatTokens, stateLabel } from "./format";
import type { Selection } from "./Sidebar";
import { Transcript } from "./Transcript";

type TaskSelection = Extract<Selection, { kind: "task" }>;
type AgentSelection = Extract<Selection, { kind: "agent" }>;

interface DetailProps {
  state: MonitorState | null;
  selection: Selection | null;
  agent?: AgentSession | null;
  fetchPage?: (after: number) => Promise<SessionPage>;
}

interface FoundAttempt {
  task: TaskRow;
  attempt: Attempt;
}

function findAttempt(state: MonitorState | null, selection: TaskSelection): FoundAttempt | null {
  if (state === null) return null;
  const repo = state.repos.find((entry) => entry.name === selection.repo);
  if (repo === undefined || repo.plan === null) return null;
  if (repo.plan.id !== selection.planId) return null;
  for (const task of repo.plan.tasks) {
    const lanes = task.reviewer === null ? [task.implementer] : [task.implementer, task.reviewer];
    for (const lane of lanes) {
      const attempt = lane.attempts.find((entry) => entry.id === selection.attemptId);
      if (attempt !== undefined) return { task, attempt };
    }
  }
  return null;
}

function TaskDetail(props: { state: MonitorState | null; selection: TaskSelection }) {
  const { state, selection } = props;
  const found = findAttempt(state, selection);

  if (found === null) {
    return (
      <section className="detail">
        <p className="muted detail-empty">The selected attempt is not in the current state</p>
      </section>
    );
  }

  const { task, attempt } = found;

  return (
    <section className="detail">
      <header className="detail-head">
        <h2 className="detail-title">
          <span className="detail-task">{task.id}</span>
          <span className="detail-attempt">{attempt.label}</span>
        </h2>
        <div className="detail-meta">
          <span className="detail-role">role {task.role}</span>
          <span className="detail-model">model {attempt.model ?? "-"}</span>
          <span className="detail-thinking">thinking {attempt.thinking ?? "-"}</span>
          <span className="detail-tokens">tokens {formatTokens(attempt.tokens)}</span>
          <span className="detail-cost">cost {formatCost(attempt.cost)}</span>
          <span className="detail-state">state {stateLabel(attempt.state)}</span>
          <span className="detail-elapsed">elapsed {formatElapsed(attempt.elapsedS)}</span>
        </div>
      </header>
      <Transcript
        repo={selection.repo}
        planId={selection.planId}
        attemptId={selection.attemptId}
      />
    </section>
  );
}

function AgentDetail(props: {
  selection: AgentSelection;
  agent: AgentSession | null;
  fetchPage?: (after: number) => Promise<SessionPage>;
}) {
  const { selection, agent, fetchPage } = props;
  const title = agent === null ? selection.id : agent.title;
  const model = agent === null ? "-" : agent.model ?? "-";
  const thinking = agent === null ? "-" : agent.thinking ?? "-";
  const tokens = agent === null ? "-" : formatTokens(agent.tokens);
  const cost = agent === null ? "-" : formatCost(agent.cost);
  const state = agent === null ? "-" : agent.live ? "live" : agent.ended ? "ended" : "idle";
  const cwd = agent === null ? "-" : agent.cwd;

  return (
    <section className="detail">
      <header className="detail-head">
        <h2 className="detail-title">{title}</h2>
        <div className="detail-meta">
          <span className="detail-agent">{selection.agent}</span>
          <span className="detail-model">model {model}</span>
          <span className="detail-thinking">thinking {thinking}</span>
          <span className="detail-tokens">tokens {tokens}</span>
          <span className="detail-cost">cost {cost}</span>
          <span className="detail-state">{state}</span>
          <span className="detail-cwd">{cwd}</span>
        </div>
      </header>
      <Transcript
        repo=""
        planId=""
        attemptId={selection.id}
        fetchPage={fetchPage}
        resetKey={`${selection.agent}/${selection.group}/${selection.id}`}
      />
    </section>
  );
}

export function Detail(props: DetailProps) {
  const { state, selection, agent = null, fetchPage } = props;

  if (selection === null) {
    return (
      <section className="detail">
        <p className="muted detail-empty">Select a task or an agent session to read it here</p>
      </section>
    );
  }

  if (selection.kind === "agent") {
    return <AgentDetail selection={selection} agent={agent} fetchPage={fetchPage} />;
  }

  return <TaskDetail state={state} selection={selection} />;
}
