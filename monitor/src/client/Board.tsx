import type { PlanView } from "../shared/types";
import { LaneCell } from "./LaneCell";

interface BoardProps {
  plan: PlanView;
  selectedId: string | null;
  onSelect: (planId: string, attemptId: string) => void;
}

function gateText(plan: PlanView): string {
  return plan.gate === null ? "gate -" : `gate ${plan.gate}`;
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
      </header>
      {plan.tasks.map((task) => (
        <div className="task-row" key={task.id}>
          <div className="task-name">
            <span className="task-id">{task.id}</span>
            <span className="task-role">{task.role}</span>
            {task.waitsFor.length > 0 ? (
              <span className="task-waits">waits for {task.waitsFor.join(", ")}</span>
            ) : null}
            {task.skipped ? <span className="badge badge-skipped">skipped</span> : null}
          </div>
          <LaneCell
            lane={task.implementer}
            kind="implementer"
            selectedId={selectedId}
            onSelect={(attemptId) => onSelect(plan.id, attemptId)}
          />
          <LaneCell
            lane={task.reviewer}
            kind="reviewer"
            selectedId={selectedId}
            onSelect={(attemptId) => onSelect(plan.id, attemptId)}
          />
        </div>
      ))}
    </section>
  );
}
