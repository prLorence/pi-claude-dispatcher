import type { PlanView, RepoView } from "../shared/types";
import { Board } from "./Board";
import { formatAgo } from "./format";

interface RepoSectionProps {
  repo: RepoView;
  expanded: boolean;
  now?: string;
  onToggle: () => void;
  selectedId: string | null;
  onSelect: (repo: string, planId: string, attemptId: string) => void;
}

function gateText(plan: PlanView): string {
  return plan.gate === null ? "gate -" : `gate ${plan.gate}`;
}

function stateText(plan: PlanView): string {
  return plan.state;
}

function EmptyRepo({ repo }: { repo: RepoView }) {
  const message = repo.message ?? "No plan yet";
  const teaches = repo.message !== null && !/cannot|error|unreadable|not found|missing/i.test(message);
  return (
    <section className="repo-section repo-idle repo-empty">
      <header className="repo-header">
        <h2 className="repo-name">{repo.name}</h2>
        <span className="repo-badge">no plan</span>
      </header>
      {teaches ? (
        <div className="repo-empty-body">
          <div className="empty-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none">
              <path d="M5 4.5h9l5 5V19.5H5z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
              <path d="M14 4.5v5h5M8 13h8M8 16h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </div>
          <div>
            <h3>No plan has run yet</h3>
            <p>
              When a plan starts in <code>.plans/inbox</code>, its task lanes, attempts and live transcript
              appear here. This board is read-only.
            </p>
          </div>
        </div>
      ) : (
        <p className="repo-message">{message}</p>
      )}
    </section>
  );
}

export function RepoSection(props: RepoSectionProps) {
  const { repo, expanded, now = null, onToggle, selectedId, onSelect } = props;
  const plan = repo.plan;

  if (plan === null) return <EmptyRepo repo={repo} />;

  const select = (planId: string, attemptId: string): void => {
    onSelect(repo.name, planId, attemptId);
  };

  if (repo.active) {
    return (
      <section className="repo-section repo-active">
        <header className="repo-header">
          <h2 className="repo-name">{repo.name}</h2>
          <span className="repo-live">active</span>
        </header>
        <Board plan={plan} selectedId={selectedId} onSelect={select} />
      </section>
    );
  }

  return (
    <section className="repo-section repo-idle">
      <button type="button" className="repo-strip" aria-expanded={expanded} onClick={onToggle}>
        <span className="repo-strip-name">{repo.name}</span>
        <span className="repo-strip-plan" title={plan.id}>{plan.id}</span>
        <span className={`repo-strip-state repo-state-${plan.state}`}>{stateText(plan)}</span>
        <span className={plan.gate === "fail" ? "repo-strip-gate gate-fail" : plan.gate === "pass" ? "repo-strip-gate gate-pass" : "repo-strip-gate"}>{gateText(plan)}</span>
        <span className="repo-strip-activity">{formatAgo(repo.lastActivity, now)}</span>
        <span className="repo-strip-chevron" aria-hidden="true" />
      </button>
      {expanded ? <Board plan={plan} selectedId={selectedId} onSelect={select} /> : null}
    </section>
  );
}
