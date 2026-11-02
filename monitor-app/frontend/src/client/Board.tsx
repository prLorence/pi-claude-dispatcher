import type { Attempt, DeciderAuditView, DeciderTaskView, Lane, PlanView } from "../shared/types";
import { formatCost, formatElapsed, formatTokens, stateLabel } from "./format";
import { DeciderBadge, deciderTitle, verdictClass, verdictText } from "./LaneCell";

interface BoardProps {
  plan: PlanView;
  selectedId: string | null;
  onSelect: (planId: string, attemptId: string) => void;
}

type LaneKind = "implementer" | "reviewer";

function gateText(plan: PlanView): string {
  return plan.gate === null ? "gate -" : `gate ${plan.gate}`;
}

function Audit({ audit }: { audit: DeciderAuditView }) {
  return (
    <span className="plan-audit">
      {`decider audit: ${audit.proposal} (${audit.aggregate.toFixed(2)})`}
      <details>
        <summary>findings</summary>
        <ul>
          {audit.findings.map((finding) => (
            <li key={finding.id}>{`${finding.id} ${finding.severity} ${finding.p.toFixed(2)}`}</li>
          ))}
        </ul>
      </details>
    </span>
  );
}

function attemptTitle(attempt: Attempt): string {
  const parts = [
    `model ${attempt.model === null ? "-" : attempt.model}`,
    `thinking ${attempt.thinking === null ? "-" : attempt.thinking}`,
    `${formatElapsed(attempt.elapsedS)} elapsed`,
    `${formatTokens(attempt.tokens)} tokens`,
    formatCost(attempt.cost),
  ];
  if (attempt.lastTool !== null) parts.push(`last tool ${attempt.lastTool}`);
  if (attempt.error !== null) parts.push(`error ${attempt.error}`);
  if (attempt.review !== null) parts.push(verdictText(attempt.review));
  return parts.join(", ");
}

function AttemptFacts({ attempt }: { attempt: Attempt }) {
  return (
    <div className="attempt-facts">
      <span className="attempt-label">{attempt.label}</span>
      <span className={`badge badge-${attempt.state}`}>{stateLabel(attempt.state)}</span>
      <span className="lane-model">{attempt.model === null ? "-" : attempt.model}</span>
      <span className="lane-thinking">{attempt.thinking === null ? "-" : attempt.thinking}</span>
      <span className="lane-elapsed">{formatElapsed(attempt.elapsedS)}</span>
      <span className="lane-tokens">{formatTokens(attempt.tokens)}</span>
      <span className="lane-cost">{formatCost(attempt.cost)}</span>
      <span className="last-tool">{attempt.lastTool === null ? "-" : attempt.lastTool}</span>
      {attempt.error === null ? null : <span className="lane-error">{attempt.error}</span>}
      {attempt.review === null ? null : (
        <span className="lane-review">
          {attempt.review.failed ? (
            <span className="badge badge-failed">review failed</span>
          ) : null}
          <span className={verdictClass(attempt.review)}>{verdictText(attempt.review)}</span>
        </span>
      )}
    </div>
  );
}

interface AttemptButtonProps {
  attempt: Attempt;
  kind: LaneKind;
  selected: boolean;
  onSelect: (attemptId: string) => void;
}

function AttemptButton(props: AttemptButtonProps) {
  const { attempt, kind, selected, onSelect } = props;
  const classes = ["attempt-button", `attempt-${kind}`, `attempt-${attempt.state}`];
  if (selected) classes.push("selected");

  return (
    <button
      type="button"
      className={classes.join(" ")}
      aria-current={selected ? "true" : undefined}
      aria-pressed={selected}
      title={attemptTitle(attempt)}
      onClick={() => {
        if (attempt.hasSession) onSelect(attempt.id);
      }}
    >
      <span className={`badge badge-${attempt.state}`}>{stateLabel(attempt.state)}</span>
      <span className="attempt-label">{attempt.label}</span>
    </button>
  );
}

interface LaneAttemptsProps {
  lane: Lane | null;
  kind: LaneKind;
  selectedId: string | null;
  onSelect: (attemptId: string) => void;
  decider: DeciderTaskView | null;
}

function LaneAttempts(props: LaneAttemptsProps) {
  const { lane, kind, selectedId, onSelect, decider } = props;
  const badge = kind === "implementer" && decider !== null ? <DeciderBadge decider={decider} /> : null;

  if (lane === null) {
    return (
      <div className={`lane lane-${kind} lane-empty`}>
        <span className="lane-dash">-</span>
      </div>
    );
  }

  if (lane.attempts.length === 0) {
    return (
      <div className={`lane lane-${kind} lane-empty`}>
        <span className="badge badge-waiting">{stateLabel("waiting")}</span>
        {badge}
      </div>
    );
  }

  return (
    <div className={`lane lane-${kind}`}>
      <div className="attempts">
        {lane.attempts.map((attempt) => (
          <AttemptButton
            key={attempt.id}
            attempt={attempt}
            kind={kind}
            selected={selectedId !== null && selectedId === attempt.id}
            onSelect={onSelect}
          />
        ))}
      </div>
      {badge}
    </div>
  );
}

export function Board(props: BoardProps) {
  const { plan, selectedId, onSelect } = props;

  return (
    <section className="board">
      <header className="plan-header">
        <span className="plan-id">{plan.id}</span>
        <span className="plan-state">{plan.state}</span>
        <span className="plan-count">
          {plan.done}/{plan.total} tasks
        </span>
        <span className="plan-gate">{gateText(plan)}</span>
        {plan.audit === null ? null : <Audit audit={plan.audit} />}
      </header>
      {plan.tasks.map((task) => {
        const select = (attemptId: string): void => {
          onSelect(plan.id, attemptId);
        };
        const implementer = task.implementer.attempts;
        const reviewer = task.reviewer === null ? [] : task.reviewer.attempts;
        const hasFacts = implementer.length + reviewer.length > 0 || task.decider !== null;

        return (
          <div className="task-row" key={task.id}>
            <div className="task-name">
              <span className="task-id">{task.id}</span>
              <span className="task-role">{task.role}</span>
              {task.waitsFor.length > 0 ? (
                <span className="task-waits">waits for {task.waitsFor.join(", ")}</span>
              ) : null}
              {task.skipped ? <span className="badge badge-skipped">skipped</span> : null}
            </div>
            <LaneAttempts
              lane={task.implementer}
              kind="implementer"
              selectedId={selectedId}
              onSelect={select}
              decider={task.decider}
            />
            <LaneAttempts
              lane={task.reviewer}
              kind="reviewer"
              selectedId={selectedId}
              onSelect={select}
              decider={null}
            />
            {hasFacts ? (
              <details className="task-details">
                <summary>attempt details</summary>
                {task.decider === null ? null : (
                  <p className="decider-detail" title={deciderTitle(task.decider)}>
                    {`decider: ${task.decider.suggested} - ran: ${task.decider.ran === null ? "-" : task.decider.ran}`}
                  </p>
                )}
                {implementer.map((attempt) => (
                  <AttemptFacts key={attempt.id} attempt={attempt} />
                ))}
                {reviewer.map((attempt) => (
                  <AttemptFacts key={attempt.id} attempt={attempt} />
                ))}
              </details>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}
