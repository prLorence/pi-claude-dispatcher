# Pi Harness: pi-plan-dispatch

Full history, decisions and open questions: [docs/pi-harness-context.md](docs/pi-harness-context.md). Read it before changing the design.

## Goal

Get rid of the manual back-and-forth between CLI tools.

Claude Code is the single interface: Sonnet 5.5 is the main session and the orchestrator, and the user talks to it directly. Three roles (revised 2026-10-21; an earlier design had Haiku as the interface, a Sonnet `planner` subagent and an Opus result auditor, and those agents are archived):

1. **Sonnet 5.5, orchestrator.** The main session in Claude Code. It clarifies the request with the `grilling` skill into a saved spec under `.plans/specs/`, writes the plan from that spec, runs the plan audit, gets the user's approval, waits for the workers and reports the gate. It never writes code.
2. **Opus 5.5, `plan-auditor` subagent** (`model: opus`). Read-only reviewer, spawned by the orchestrator before a plan is flipped to ready. It reviews the plan against the spec and the repository and returns severity-tagged findings and a verdict. It never audits worker results and doesn't implement.
3. **OpenCode Go, implementation.** Provider for `deepseek-v4.1-flash` and other models. Headless Pi workers, run by the `pi-plan-dispatch` extension, implement the tasks.

Hand-off is files under `.plans/`: specs and plans in, results out, one trace per request.

This is "Option 2" from the design discussion. Sonnet and Opus stay in Claude Code on the user's subscription, so it avoids the unofficial `pi-claude-bridge` and its billing gray zone. Don't route Claude models through Pi.

## Hard rule

Claude models, Sonnet and Opus included, never write code, tests, scripts, config or docs in the repository. The orchestrator writes only artifacts under `.plans/` (spec, plans, traces) and never commits. There is no break-glass switch yet; an enforcing hook is planned, so for now it is a rule.

## Layout

| Path | What it is |
|---|---|
| `pi-plan-dispatch/core.ts` | Pure logic, no Pi imports, testable alone: config, plan parsing (`trace`, `parent`, `round`), file-overlap scheduling, worker spawn (`pi --mode json -p`, with a named session per task attempt), result files |
| `pi-plan-dispatch/index.ts` | Pi extension: watches `.plans/inbox/` from `session_start`, runs a queue of one plan at a time, writes events/evidence/`_summary.md`, footer and widget UI, `/plans` commands |
| `pi-plan-dispatch/trace.ts` | Tracing without Pi imports: append-only event log, git snapshots before and after a plan, fault detection, the gate |
| `pi-plan-dispatch/guard.ts` | Worker-side guardrails (G2): a pure policy that limits edits to the task's `files:` and refuses destructive shell commands |
| `pi-plan-dispatch/verify.ts` | Independent verification (G1): runs `verify:` commands with a timeout, serialises them through a lock, checks executables, builds retry feedback |
| `pi-plan-dispatch/review.ts` | The review contract, pure and with no local imports: `parseReviewReport`, `buildReviewPrompt`, `feedbackFromFindings`, and the finding types shared by pair mode and the security role |
| `pi-plan-dispatch/*.test.ts` | 161 tests: unit tests with a fake `pi`, plus extension integration tests with a mocked Pi API (`cd pi-plan-dispatch && npm test`, Node 24+) |
| `pi-plan-dispatch/README.md` | User-facing install, usage, config, scheduling rules, limits |
| `dispatch-plan/SKILL.md` | Claude Code skill: spec and plan formats, atomic draft, flip, plan audit, wait, gate and evidence, trace events, fix-loop limits |
| `dispatch-plan/ORCHESTRATOR.md` | The pasteable orchestrator rules block for `CLAUDE.md`, with the `## Delegation rules (dispatch-plan)` marker line |
| `dispatch-plan/trace.mjs` | Trace CLI, no dependencies: `event`, `wait`, `gate`, `report`, `new-id`. Installed at `~/.claude/skills/dispatch-plan/trace.mjs` |
| `dispatch-plan/preflight.mjs` | Preflight CLI: runs the dispatcher's parsing and preflight on a plan file, prints every error, exits non-zero on any |
| `dispatch-plan/config-init.mjs` | Config CLI: creates `.plans/config.json` with the dispatcher defaults (`--minimal`, `--force`, `--print`) |
| `dispatch-plan/agents/plan-auditor.md` | `plan-auditor` subagent: read-only plan review checklist, verdict format, `plan.audit` event |
| `dispatch-plan/archive/` | Superseded and archived artifacts, not installed: `INTERFACE-haiku.md`, `planner-subagent.md`, `result-auditor.md` |
| `docs/roles.md` | The worker role model: default roles and models, config, pair mode, security and QA, report formats, the pilot protocol |
| `docs/architecture.md` | Architecture diagrams: components and data flow, with built and planned parts, and one request in order |

Targets `@earendil-works/pi-coding-agent >=1.3.0`. Extensions load through jiti, so there's no build step.

## Settled decisions

- Phased delivery. Phase 1 is a Pi extension, and it's built. Phase 2 is a standalone worker so no Pi window has to stay open. Start Phase 2 only after Phase 1 is proven on the Mac, and confirm its scope with the user first.
- Isolation uses file-overlap scheduling in one shared checkout, not a git worktree per task.
- Workers run with `PI_PLAN_DISPATCH_WORKER=1` and must never start their own watcher.
- Pi exits 0 on errors like "No API key found", so a worker with no assistant output counts as failed. Keep that check.
- The user approves the plan in the main session. Sonnet is the orchestrator, so there is no approval round trip through another model; it shows the plan where the user can ask for changes. Every draft, round 1 and fix rounds, is a `.plans/inbox/<id>.md.draft` file with `status: draft`; the dispatcher reads only `*.md`, so only a flipped plan is picked up. The user is the last gate in pilot mode: the `.plans/config.json` key `autoReady` is false by default, and the orchestrator never enables it.
- Plan audit replaces result audit. Opus 5.5 runs as the read-only `plan-auditor` subagent before a plan is flipped to ready: it reviews the plan against the spec and the repo, returns severity-tagged findings and logs `plan.audit` itself. Verdict `pass` means zero blockers and zero majors; minors are notes. At most 3 audit rounds, then the orchestrator stops and asks the user. Opus never audits worker results.
- Fix rounds stop after 3 fix rounds, so the last plan id ends in `-r4`, or when the same finding repeats. The orchestrator logs `loop.stop` with the reason and reports the open findings. A failing gate goes back to planning with the evidence, never forward to a review.
- The gate is necessary, not sufficient. It passes only when every task is done and there are zero error faults; a dry run never passes. The plan audit checks the plan before it runs; the gate, the `verify:` commands, the live guards and pair review check the result.
- The orchestrator writes only under `.plans/` (specs, inbox, done, traces). It never edits source and never commits, and besides the plan audit it spawns no other agent.
- Obsolete artifacts are archived, not deleted. The superseded `planner` and `auditor` agents and the old Haiku interface rules live in `dispatch-plan/archive/` with a header note saying they are not installed; the active agents folder holds only `plan-auditor.md`.
- Traces are local files, `.plans/traces/<trace>.jsonl`. OpenTelemetry export is deferred.
- Workers' claims are not trusted. The dispatcher, not the worker, runs a task's or the plan's `verify:` command with `sh -c` in the repo root. Exit 0 verifies the attempt; a failure or timeout retries the task with the output as feedback, or fails it, and a failing plan-level check fails the gate. Verification runs one at a time through a shared lock.
- Actions are blocked live inside workers (G2). A `tool_call` handler built from `PI_PLAN_DISPATCH_GUARD` limits edit-like tools to the task's `files:` and always denies paths outside the repo, under `.git/` or under `.plans/`, and blocks destructive shell commands (`git commit|push|reset --hard|clean|checkout --|stash|rebase|merge|tag|branch -D`, `rm -rf`/`rm -fr`, `npm publish`, `gh pr create|merge`, `sudo`, downloads piped into a shell). A blocked call starts with `BLOCKED by pi-plan-dispatch:` and the dispatcher counts it as a `blocked_action` warning. Shell writes (redirects, `sed -i`, `tee`) cannot be blocked reliably; the git evidence and gate catch them.
- Plans are preflighted before any worker starts (G4). Absolute or `..` `files:` entries, entries under `.git/` or `.plans/`, more than `maxFilesPerTask` files, a body over `maxTaskChars`, or an unknown `verify:` executable reject the plan to `.plans/failed/` with an `.error.md` and a `plan.rejected` event.
- Editing a file that existed before the plan without reading it first raises an `edit_unread_file` warning (G3). New files are exempt.
- Roles are config-based. Plans name a role (`implement` by default), never a model; `.plans/config.json` maps each role to a model, thinking level, read-only flag and prompt. Resolution is task `model:`/`thinking:` line, then the task's role, then the plan frontmatter, then the config defaults. An empty thinking level passes no `--thinking` flag. A user config entry overrides only the fields it sets.
- Pair mode is review before done. After an implementer task succeeds and its `verify:` passes, its `pair:` role runs as a read-only reviewer. `approve` ends the task; `changes` re-runs the implementer with the findings, counted on a separate `pairRound` so `retries` are not consumed. When rounds (1-3, default 2) or `maxRunsPerTask` (default 8, implementer plus reviewer runs) run out with findings open, the task stays done and `pair_unresolved` records them for the orchestrator's report. A reviewer crash or an unparseable report is `review_unparsed`, never a task failure. The whole loop is inside the task's lifecycle, so dependents wait. Dry runs skip it.
- Security findings feed the gate by severity: `security_finding` is an error for high, a warning for medium and info for low, and an unlabelled finding counts as medium. Read-only tasks change nothing by design, so the implementer report checks do not apply; a read-only task that edits anything raises a `readonly_violation` error. `role: qa` is an ordinary implementer task with the QA model and prompt.

## Traceability

One trace is one user request across all rounds. Plans link through frontmatter: `trace:` is shared by every plan of the request (defaults to the plan id), `parent:` names the previous plan on a fix round, `round:` counts from 1. Plan ids are `<trace>-r1`, `<trace>-r2`, and so on.

- Events: `.plans/traces/<trace>.jsonl`, one JSON line per event, actors `sonnet-orchestrator`, `opus-plan-auditor`, `pi-dispatch`, `worker`, `user`. `task.start` carries the task's `role`; `task.review` records a pair or security review (`round`, `reviewer_role`, `model`, `verdict`, `findings`, `cost`, `tokens`, `session_id`).
- The orchestrator writes `spec.confirmed`, `plan.drafted`, `plan.approved` and `loop.stop`; the `plan-auditor` writes `plan.audit` (`verdict`, `audit_round`, `blockers`, `majors`, `minors`, `summary`), and nobody else does; the extension writes the rest. The event-level `round` is always the plan round, and the audit counter lives in `audit_round`. `audit.verdict` is legacy: the result audit it recorded no longer exists, so nothing writes it, but the report still renders old traces.
- Per plan results: `.plans/done/<plan>/` holds `plan.md`, `_summary.md` (gate line and fault list), one `<task>.md` report and one `<task>.prompt.md` per task that started (a skipped task has a report but no prompt file), a `<task>.verify.md` and/or `plan.verify.md` when a `verify:` command ran, and `evidence.json` (changed files, faults, gate, plus `pairs` and `reviews`).
- Three evidence sources, in decreasing trust: Pi's tool-call stream (which tool edited which path, per task), the git snapshot before and after the plan (what actually changed, per plan), and the worker's own report.

`trace.mjs report --trace <T>` renders the timeline to stdout and `.plans/traces/<T>.md`, including a **Plan audit** table (round, verdict, blockers, majors, minors) and a **Models** table (model, roles, tasks, reviews, tokens, cost, error and warn faults) built from `task.start`, `task.end`, `task.review` and `fault` events; the orchestrator quotes its headline in the final report.

## Status (Phase 1)

- **Verified in a Linux sandbox:** strict `tsc`, the core unit tests with a fake `pi`, and live TUI tests in tmux.
- **Tested against real Pi for the tool stream and the live guard:** a real worker run in the audit verified the `tool_execution_*` event names against Pi's actual JSON stream, and the live guard works end to end in a real worker. The tracing, fault detection and gate code is otherwise covered by unit and integration tests with a mocked Pi API and a fake worker.
- **Written, not yet used end to end:** the `plan-auditor` agent, the orchestrator rules block and the updated skill.
- **Not verified yet:**
  - a real DeepSeek/OpenCode Go run
  - macOS `fs.watch` behaviour
  - the agents and skill driven by real Claude Code
  - LSP extensions reaching workers
  - real cost reporting
- **Suggested next step:** refresh the installed copies (`mkdir -p ~/.claude/skills/dispatch-plan && cp dispatch-plan/SKILL.md dispatch-plan/ORCHESTRATOR.md dispatch-plan/trace.mjs dispatch-plan/preflight.mjs dispatch-plan/config-init.mjs ~/.claude/skills/dispatch-plan/` and `mkdir -p ~/.claude/agents && cp dispatch-plan/agents/plan-auditor.md ~/.claude/agents/`; anyone who installed an earlier version also runs `rm -f ~/.claude/agents/planner.md ~/.claude/agents/auditor.md`), paste the block from `dispatch-plan/ORCHESTRATOR.md` into `CLAUDE.md`, install the extension, and log Pi into OpenCode Go. Run a tiny plan with `/plans dry on`, then one small real task with `/plans dry off`.

## Open questions

- Phase 2 scope.
- Pair mode is a hypothesis. No measurements exist yet: run the same tasks solo and as pairs and compare worker cost, gate pass rate, rounds to pass and faults per model with the Models table of `trace.mjs report` (see `docs/roles.md`).
- Parallel best-of-two (run two implementers on one task and keep the better result) needs git worktrees or another isolation scheme; the shared checkout cannot host it.
- Live agent-to-agent conversation between the orchestrator and the Pi workers needs an RPC or message channel; today the hand-off is files only.
- No fallback model when a provider fails: moving a role is a manual config edit, which matters when a free model's period ends.
- ~~Whether the gstack and pstack architecture skills should be preloaded into the plan reviewer.~~ Resolved: the `plan-auditor` preloads `codebase-design`, `domain-modeling` and `tdd` through its `skills:` list.
- Per-task git worktrees for parallel tasks, as a Phase 2 candidate against the shared-checkout rule.
- OpenTelemetry export of the trace events.
- An `agent:` per-task field to map tasks to the `dev-fe`, `dev-be` and `qa` Pi agents.
- Optional: install a community orchestration skill (`claude-pi`, `pi-cc-plugin`) after reading its source.
- ~~How to set up the OpenCode Go key in Pi.~~ Resolved: pi has a built-in `opencode-go` provider; key lives in `~/.pi/agent/auth.json`, models smoke-tested. See [docs/pi-migration.md](docs/pi-migration.md).
- Whether other OpenCode Go models should also serve as workers.
