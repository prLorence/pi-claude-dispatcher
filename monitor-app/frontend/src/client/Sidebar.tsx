import { Fragment } from "react";
import type { AgentGroup, MonitorState } from "../shared/types";
import { AgentsList } from "./AgentsList";
import { RepoSection } from "./RepoSection";

export type Selection =
  | { kind: "task"; repo: string; planId: string; attemptId: string }
  | { kind: "agent"; agent: "omp" | "pi"; group: string; id: string };

interface SidebarProps {
  state: MonitorState | null;
  selection: Selection | null;
  expanded: Record<string, boolean>;
  onToggle: (repo: string) => void;
  onSelectTask: (repo: string, planId: string, attemptId: string) => void;
  agents?: AgentGroup[];
  onSelectAgent?: (agent: "omp" | "pi", group: string, id: string) => void;
}

function selectedAttemptId(
  selection: Selection | null,
  repo: string,
  planId: string | null,
): string | null {
  if (selection === null || selection.kind !== "task") return null;
  if (selection.repo !== repo) return null;
  if (planId === null || selection.planId !== planId) return null;
  return selection.attemptId;
}

export function Sidebar(props: SidebarProps) {
  const { state, selection, expanded, onToggle, onSelectTask } = props;
  const repos = state === null ? [] : state.repos;
  const agents = props.agents ?? [];
  const onSelectAgent = props.onSelectAgent ?? ((): void => {});
  const nowMs = state === null ? 0 : Date.parse(state.now);
  const repoNames = new Set(repos.map((repo) => repo.name));
  const otherGroups = agents.filter((group) => !repoNames.has(group.name));
  const hasSessions = (name: string): boolean =>
    agents.some((group) => group.name === name && group.sessions.length > 0);

  return (
    <aside className="sidebar" aria-label="Repos and tasks">
      {repos.map((repo) => {
        const planId = repo.plan === null ? null : repo.plan.id;
        const shown = expanded[repo.name] === undefined ? repo.active : expanded[repo.name];
        return (
          <Fragment key={repo.name}>
            <RepoSection
              repo={repo}
              expanded={shown}
              onToggle={() => onToggle(repo.name)}
              selectedId={selectedAttemptId(selection, repo.name, planId)}
              onSelect={onSelectTask}
            />
            {hasSessions(repo.name) ? (
              <div className="agents-group">
                <h3 className="agents-heading">Agents</h3>
                <AgentsList
                  groups={agents}
                  repoName={repo.name}
                  nowMs={nowMs}
                  selection={selection}
                  onSelectAgent={onSelectAgent}
                />
              </div>
            ) : null}
          </Fragment>
        );
      })}
      {otherGroups.length > 0 ? (
        <section className="other-sessions" aria-label="Other sessions">
          <h2 className="other-sessions-heading">Other sessions</h2>
          {otherGroups.map((group) => (
            <div key={group.name} className="agents-group">
              <h3 className="agents-heading">{group.name}</h3>
              <AgentsList
                groups={agents}
                repoName={group.name}
                nowMs={nowMs}
                selection={selection}
                onSelectAgent={onSelectAgent}
              />
            </div>
          ))}
        </section>
      ) : null}
    </aside>
  );
}
