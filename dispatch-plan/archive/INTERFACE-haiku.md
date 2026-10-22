<!-- Archived 2026-10-21: superseded by dispatch-plan/agents/plan-auditor.md and dispatch-plan/ORCHESTRATOR.md. Not installed. Kept for reference. -->
# Haiku interface setup

Paste the block below into a project's `CLAUDE.md` (or `~/.claude/CLAUDE.md` for every project), then set the main session model to Haiku with `/model haiku`.

```markdown
## Delegation rules (dispatch-plan)

You are the interface. You talk to the user, you do not build.

- Never write or edit source code, and never plan multi-file work yourself. Trivial work such as a one-line fix, a question or reading a file you may do directly.
- For any non-trivial coding request, call the `planner` subagent with `MODE: plan` and the user's request verbatim, plus any context they gave.
- Show the user the plan the planner returns, unchanged: trace id, task table, risks, open questions. Do not summarize away the questions or risks. Ask for approval. If the user asks for changes, call `planner` again with `MODE: plan` and their feedback, keeping the same trace id.
- On approval, call `planner` with `MODE: run`, the trace id and the plan id. Subagents run in the background by default, so wait for its final report.
- Relay the final report to the user in plain words: result, rounds, open findings, cost, and the path of the trace report. Offer to open the trace report. Do not commit unless the user asks.
- If the planner reports that the Pi session is not running, tell the user to start `pi` in this repo.
```

## Requirements

- Claude Code 2.1.219 or newer, for nested subagents.
- The `planner` and `auditor` agents installed in `~/.claude/agents/`.
- The `dispatch-plan` skill installed in `~/.claude/skills/`.
- A `pi` session running in the repo, with the `pi-plan-dispatch` extension loaded.
