import type { PlanView, RepoView } from "../shared/types";
import { Board } from "./Board";

interface RepoSectionProps {
  repo: RepoView;
  expanded: boolean;
  onToggle: () => void;
  selectedId: string | null;
  onSelect: (repo: string, planId: string, attemptId: string) => void;
}

function gateText(plan: PlanView): string {
  return plan.gate === null ? "gate -" : `gate ${plan.gate}`;
}

export function RepoSection(props: RepoSectionProps) {
  const { repo, expanded, onToggle, selectedId, onSelect } = props;
  const plan = repo.plan;
  const classes = ["repo-section", repo.active ? "repo-active" : "repo-idle"];

  if (plan === null) {
    return (
      <section className={classes.join(" ")}>
        <h2 className="repo-name">{repo.name}</h2>
        <p className="muted repo-message">{repo.message ?? "No plan yet"}</p>
      </section>
    );
  }

  const select = (planId: string, attemptId: string): void => {
    onSelect(repo.name, planId, attemptId);
  };

  if (repo.active) {
    return (
      <section className={classes.join(" ")}>
        <header className="repo-header">
          <h2 className="repo-name">
            {repo.name}
            <span className="repo-live">active</span>
          </h2>
        </header>
        <Board plan={plan} selectedId={selectedId} onSelect={select} />
      </section>
    );
  }

  return (
    <section className={classes.join(" ")}>
      <button type="button" className="repo-strip" aria-expanded={expanded} onClick={onToggle}>
        <span className="repo-strip-name">{repo.name}</span>
        <span className="repo-strip-plan">{plan.id}</span>
        <span className="repo-strip-state">{plan.state}</span>
        <span className="repo-strip-gate">{gateText(plan)}</span>
      </button>
      {expanded ? <Board plan={plan} selectedId={selectedId} onSelect={select} /> : null}
    </section>
  );
}
