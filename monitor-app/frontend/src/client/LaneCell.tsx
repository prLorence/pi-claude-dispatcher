import { useState } from "react";
import type { Attempt, DeciderTaskView, Lane, ReviewResult } from "../shared/types";
import { formatCost, formatElapsed, formatTokens, stateLabel } from "./format";

interface LaneCellProps {
  lane: Lane | null;
  kind: "implementer" | "reviewer";
  selectedId: string | null;
  onSelect: (attemptId: string) => void;
  decider?: DeciderTaskView | null;
}

function twoDecimals(value: number): string {
  return value.toFixed(2);
}

function deciderTitle(decider: DeciderTaskView): string {
  const probabilities = Object.entries(decider.probabilities)
    .map(([level, value]) => `${level} ${twoDecimals(value)}`)
    .join(", ");
  const confidence = decider.confidence === null ? "-" : twoDecimals(decider.confidence);
  const complexity = decider.complexity === null ? "-" : twoDecimals(decider.complexity);
  return `probabilities: ${probabilities === "" ? "-" : probabilities}, confidence: ${confidence}, complexity: ${complexity}`;
}

function pickAttempt(lane: Lane, label: string | null): Attempt | null {
  if (label !== null) {
    const match = lane.attempts.find((attempt) => attempt.label === label);
    if (match) return match;
  }
  if (lane.attempts.length === 0) return null;
  return lane.attempts[lane.attempts.length - 1];
}

function verdictClass(review: ReviewResult): string {
  if (review.failed) {
    return review.verdict === "changes" ? "verdict verdict-changes" : "verdict verdict-unknown";
  }
  return `verdict verdict-${review.verdict}`;
}

function verdictText(review: ReviewResult): string {
  const findings = review.findings === null ? "findings -" : `findings ${review.findings}`;
  if (review.failed) {
    return review.verdict === "changes" ? `changes, ${findings}` : `review failed, ${findings}`;
  }
  return `${review.verdict}, ${findings}`;
}

export function LaneCell(props: LaneCellProps) {
  const { lane, kind, selectedId, onSelect, decider } = props;
  const [chosen, setChosen] = useState<string | null>(null);

  const diff = decider !== null && decider !== undefined && decider.ran !== null && decider.ran !== decider.suggested;
  const badge =
    kind === "implementer" && decider !== null && decider !== undefined ? (
      <span className={diff ? "decider-badge decider-diff" : "decider-badge"} title={deciderTitle(decider)}>
        {`decider: ${decider.suggested} - ran: ${decider.ran === null ? "-" : decider.ran}`}
      </span>
    ) : null;

  if (lane === null) {
    return (
      <div className={`lane lane-${kind} lane-empty`}>
        <span className="lane-dash">-</span>
      </div>
    );
  }

  const attempt = pickAttempt(lane, chosen);

  if (attempt === null) {
    return (
      <div className={`lane lane-${kind} lane-empty`}>
        <span className="badge badge-waiting">{stateLabel("waiting")}</span>
        {badge}
      </div>
    );
  }

  const selected = selectedId !== null && selectedId === attempt.id;
  const classes = ["lane", `lane-${kind}`];
  if (selected) classes.push("selected");

  const select = (): void => {
    if (attempt.hasSession) onSelect(attempt.id);
  };

  return (
    <div
      className={classes.join(" ")}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={select}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          select();
        }
      }}
    >
      <div className="lane-head">
        <span className={`badge badge-${attempt.state}`}>{stateLabel(attempt.state)}</span>
        <span className="lane-label">{attempt.label}</span>
        {lane.attempts.length > 1 ? (
          <span className="switcher">
            {lane.attempts.map((option) => (
              <button
                key={option.id}
                type="button"
                className="switcher-button"
                aria-pressed={option.id === attempt.id}
                onClick={(event) => {
                  event.stopPropagation();
                  setChosen(option.label);
                }}
              >
                {option.label}
              </button>
            ))}
          </span>
        ) : null}
        {badge}
      </div>
      <div className="lane-meta">
        <span className="lane-model">{attempt.model === null ? "-" : attempt.model}</span>
        <span className="lane-elapsed">{formatElapsed(attempt.elapsedS)}</span>
        <span className="lane-tokens">{formatTokens(attempt.tokens)}</span>
        <span className="lane-cost">{formatCost(attempt.cost)}</span>
      </div>
      {attempt.lastTool === null ? null : <div className="last-tool">{attempt.lastTool}</div>}
      {attempt.error === null ? null : <div className="lane-error">{attempt.error}</div>}
      {attempt.review === null ? null : (
        <div className="lane-review">
          {attempt.review.failed ? (
            <span className="badge badge-failed">review failed</span>
          ) : null}
          <span className={verdictClass(attempt.review)}>{verdictText(attempt.review)}</span>
        </div>
      )}
    </div>
  );
}
