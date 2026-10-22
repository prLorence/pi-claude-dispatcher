# pi-plan-dispatch (Phase 1)

A Pi extension that watches `.plans/inbox/` in your repo. When the orchestrator flips a plan to ready there, the extension fans the tasks out to headless Pi workers (DeepSeek V4.1 Flash on OpenCode Go by default), records what actually happened, and writes the results back as files. Post-run quality rests on the gate, the `verify:` commands, the live guards and pair review. Opus checks the plan before any worker runs and never reviews the results.

Two Claude-side roles, the orchestrator and the plan reviewer, plus the Pi workers; one trace per user request (worker roles such as `review` and `security` are separate; `review` and every read-only role other than `security` is only a `pair:` reviewer, never a task role; see [docs/roles.md](../docs/roles.md)):

```text
Sonnet 5.5 (Claude Code, main session and orchestrator) --user request + grilling--> .plans/specs/<trace>.md
orchestrator --writes--> .plans/inbox/<id>.md.draft --plan audit--> plan-auditor subagent (Opus 5.5, read-only)
plan-auditor --returns--> verdict and findings --revise--> audit round 2..3
orchestrator --shows plan + audit result--> user --approval--> orchestrator --flips--> .plans/inbox/<id>.md (status: ready)
Pi + this extension --runs tasks--> pi -p workers (DeepSeek V4.1 Flash)
Pi --writes--> .plans/done/<id>/ (reports, prompts, evidence.json)
orchestrator --gate + trace report--> user
all roles --append events--> .plans/traces/<trace>.jsonl
```

The files are the hand-off: `.plans/inbox/` carries plans in, `.plans/done/<id>/` carries results out, and `.plans/traces/<trace>.jsonl` is the shared record of the whole request.

## Install

```bash
# 1. Pi with your OpenCode Go key
pi            # then /login and pick OpenCode Go, or set the key per Pi's providers docs

# 2. The extension: pick one
pi install ./pi-plan-dispatch                        # as a package
cp -r pi-plan-dispatch ~/.pi/agent/extensions/       # or as a global extension

# 3. The Claude Code skill, orchestrator rules, trace and preflight CLIs
mkdir -p ~/.claude/skills/dispatch-plan && cp dispatch-plan/SKILL.md dispatch-plan/ORCHESTRATOR.md dispatch-plan/trace.mjs dispatch-plan/preflight.mjs dispatch-plan/config-init.mjs ~/.claude/skills/dispatch-plan/

# 4. The plan-auditor subagent, and removal of the superseded agents
mkdir -p ~/.claude/agents && cp dispatch-plan/agents/plan-auditor.md ~/.claude/agents/
rm -f ~/.claude/agents/planner.md ~/.claude/agents/auditor.md

# 5. The orchestrator rules
# paste the block from dispatch-plan/ORCHESTRATOR.md into CLAUDE.md or ~/.claude/CLAUDE.md
```

Add `.plans/` to your `.gitignore`.

Reload or restart Pi after updating the extension: a running Pi keeps the old code in memory.

The install copies the CLIs to `~/.claude/skills/dispatch-plan/`, and the orchestrator and the `plan-auditor` call them there: `trace.mjs` for events, waits and reports, `preflight.mjs` for the plan check. Refresh the installed copies after pulling changes; a missing module means a stale install.

## Use

1. Open Pi in the repo and leave it running. The footer shows `plans: watching`.
2. In Claude Code the main session is the orchestrator (Sonnet 5.5). Ask it for the work; for anything non-trivial it clarifies with the `grilling` skill and saves a spec at `.plans/specs/<trace>.md` with numbered requirements.
3. The orchestrator writes `.plans/inbox/<trace>-r1.md.draft` (a temp file moved into place, `status: draft`) with a `Covers:` line in every task, and logs `plan.drafted`.
4. It runs `node ~/.claude/skills/dispatch-plan/preflight.mjs <plan file>` and fixes every `ERROR:`, then spawns the read-only `plan-auditor` subagent (Opus 5.5) with the plan path, spec path, trace id, plan id, plan round and audit round. The auditor returns a verdict with severity-tagged findings and logs `plan.audit` itself.
5. The orchestrator revises the plan for every blocker and major and re-audits, at most 3 audit rounds. Minors are notes and do not fail a round.
6. It shows you the plan, the requirement-to-task trace and the audit result, then asks for approval. Only after you say yes does it log `plan.approved` and flip the draft to `status: ready` with the flip command in `dispatch-plan/SKILL.md`. Pilot mode is the default: `autoReady` in `.plans/config.json` is false, and the orchestrator never enables it.
7. The Pi window shows the tasks running. When the plan finishes the orchestrator checks the gate, reads the changed files and the `verify:` output, and reports the result to you.
8. On a failed gate it drafts a fix plan (`<trace>-r2`, `parent:` set, the same spec), which goes through the same preflight, plan audit and approval. It stops after 3 fix rounds, so the last plan id ends in `-r4`, or when the same finding repeats, and reports the open findings.
9. It renders the trace report and returns the final report, including the trace report path. Nobody commits unless you ask.

The `plan-auditor` runs as a subagent in the background and returns everything in its final report, so the orchestrator has all it needs; you cannot talk to it mid-run.

Commands inside Pi:

| Command | What it does |
|---|---|
| `/plans` | Status: running plan, queue, worker settings |
| `/plans dry on` / `off` | Simulate workers (no model calls), handy for testing |
| `/plans stop` | Abort the running plan |
| `/plans scan` | Re-scan the inbox now |
| `/plans roles` | List each role's model, thinking level and read-only flag |
| `/plans roles test` | Run a tiny real call for every model the roles use |
| `pi --plans-dry-run` | Start in dry-run mode |

## Config: `.plans/config.json` (optional, per repo)

```json
{
  "model": "opencode-go/deepseek-v4.1-flash",
  "thinking": "low",
  "maxParallel": 3,
  "timeoutMinutes": 20,
  "retries": 1,
  "tools": [],
  "dryRun": false,
  "verifyTimeoutMinutes": 10,
  "workerGuards": true,
  "maxFilesPerTask": 10,
  "maxTaskChars": 8000,
  "maxRunsPerTask": 8,
  "roles": {
    "review": { "model": "opencode-go/minimax-m3.1-flash-free", "thinking": "low" },
    "security": { "model": "opencode-go/glm-5.3-flash", "thinking": "high" }
  }
}
```

| Key | Default | Meaning |
|---|---|---|
| `model` | `opencode-go/deepseek-v4.1-flash` | Worker model |
| `thinking` | `low` | DeepSeek V4.1 Flash only supports `low`, `high` and `max` |
| `maxParallel` | `3` | Tasks running at once |
| `timeoutMinutes` | `20` | Kill a worker after this long |
| `retries` | `1` | Extra attempts after a failed one |
| `tools` | `[]` | Empty means Pi's defaults plus your installed extensions, such as lsp-pi |
| `dryRun` | `false` | Simulate workers, no model calls |
| `verifyTimeoutMinutes` | `10` | Kill a `verify:` command after this long (`0` = no timeout) |
| `workerGuards` | `true` | Register the live `tool_call` guard inside workers (G2) |
| `persistSessions` | `true` | Save each task attempt's Pi session under `.plans/sessions/<plan>/`; `false` makes workers ephemeral |
| `maxFilesPerTask` | `10` | Preflight rejects a task listing more files |
| `maxTaskChars` | `8000` | Preflight rejects a longer task body |
| `maxRunsPerTask` | `8` | Cap on worker runs per task: implementer plus pair reviewer runs |
| `roles` | see [docs/roles.md](../docs/roles.md) | Map of role name to model, thinking, read-only flag and prompt. A user entry overrides only the fields it sets |

A plan's frontmatter, or an individual task, can override `model` and `thinking`.
A task may name a `role:` (default `implement`), and risky tasks can add a pair
reviewer with `pair:` and `pair_rounds:`. See [docs/roles.md](../docs/roles.md) for
the four default roles, their models and prices, pair mode, and the security and QA
roles.

`node ~/.claude/skills/dispatch-plan/config-init.mjs` writes this file with the
dispatcher's defaults: `--minimal` writes only the review role and `autoReady`,
`--force` replaces an existing file after a `.bak-<timestamp>` copy, and `--print`
shows the JSON without writing it.

With `persistSessions` on, each task attempt keeps its Pi session, so its conversation
can be reopened. Re-running the same plan id renames the old session files to
`.prev-<timestamp>` instead of continuing them, so a re-run never appends to the old
conversation. Setting `persistSessions` to `false` makes workers ephemeral.

## How scheduling works

- Plans run one at a time, oldest first. Only plans with `status: ready` are picked up.
- A task starts when its `depends_on` tasks are done and none of its `files:` overlap with a running task. A directory covers everything under it.
- A task without `files:` runs alone.
- A task with `pair:` runs a read-only reviewer after a successful, verified attempt. The pair loop stays inside the task's lifecycle, so its dependents wait for it.
- Failed tasks retry `retries` times. If a task still fails, its dependents are skipped.
- A malformed plan (unknown dependency, cycle, no tasks) moves to `.plans/failed/` with an `.error.md` explaining why.
- Workers run with `PI_PLAN_DISPATCH_WORKER=1`, so they never start their own watcher.

## Guardrails

Workers are cheap models and their claims are not trusted. Four guardrails check them independently.

### G1: independent verification

A task may carry a leading metadata line `verify: <shell command>`, and the plan frontmatter may have `verify:` too (an integration check run once after every task is done). The dispatcher, not the worker, runs the command with `sh -c` in the repo root right after a worker reports success. Exit 0 means the attempt is verified.

A non-zero exit or a timeout means the attempt failed. If `retries` allow, the task is retried and the failure output is given to the worker in its next prompt under "Your previous attempt failed verification". Otherwise the task fails and its dependents are skipped. A failing plan-level `verify:` adds a plan-level `verify_failed` fault and fails the gate. Commands run one at a time through a shared lock, because tasks share one checkout. Each run writes `<task>.verify.md` or `plan.verify.md` with the command, outcome and output tail, and logs a `task.verify` event. `verifyTimeoutMinutes` (default 10, `0` = no timeout) bounds a run.

### G2: live blocking

The extension, when it runs inside a worker (`PI_PLAN_DISPATCH_WORKER=1`), registers a `tool_call` handler. Its policy arrives in `PI_PLAN_DISPATCH_GUARD` as JSON `{"files": [...], "bash": true}`.

- Edit-like tools (name matching edit, write or patch) may only touch paths inside the task's `files:`. A directory entry covers everything under it.
- Anything outside the repo, inside `.git/` or inside `.plans/` is always denied.
- Shell commands are blocked for `git commit`, `push`, `reset --hard`, `clean`, `checkout --`, `checkout .`, `stash`, `rebase`, `merge`, `tag` and `branch -D`; `rm -rf` and `rm -fr` on any target; `npm publish`; `gh pr create|merge`; `sudo`; and `curl`/`wget` piped into a shell.
- A blocked call returns a reason starting with `BLOCKED by pi-plan-dispatch:` and tells the worker what to do instead, usually to list the need under NEEDS. The dispatcher counts blocked results and raises a `blocked_action` warning.

Set `workerGuards: false` to turn this off. Guards apply only to workers started by the dispatcher; a Pi session you start yourself is unaffected.

Shell writes cannot be policed by the live guard: it sees the command, not what the command writes.

Known gap: the guard denies a read-only role the obvious shell writes (a `>` redirect to a file, `tee`, `sed -i`, `mv`, `cp`, `touch`, `rm` and similar), and the command check skips wrapper commands (`env`, `xargs`, `nohup`, `command`, `exec`, `nice`, `stdbuf`, `time`, `timeout`) so `env tee out.txt` and `xargs tee out.txt` are still denied. It remains best-effort: writes hidden in `sh -c`, a script, `python -c`, `node -e`, `git apply`, `truncate`, `xargs rm` or `find -delete` get through. The dirty-file window around each pair reviewer run and around a security task's own run is the real backstop: a file changed in that window is blamed on the read-only worker unless a task running concurrently owns it. So a write to a finished task's file or to a file no task owns is still caught, while a parallel task editing its own files is spared.

For implementers the git snapshot records a shell write, but the gate does not catch one: `out_of_scope_edit` comes only from tool calls, and `unowned_change` only from files no task owns. A shell write into a file another task owns therefore raises no error fault, so only reviewing the diff catches that case.

### G3: suspicious behaviour

A worker that edits a file which already existed before the plan (anything in `git ls-files`) without first reading it, or mentioning the path in a bash command, raises an `edit_unread_file` warning. New files are exempt.

### G4: plan preflight

Before any worker starts, the extension rejects the plan, moves it to `.plans/failed/` with an `.error.md` and emits `plan.rejected` when:

- a `files:` entry is absolute, contains a `..` segment, or points inside `.git/` or `.plans/`;
- a task lists more than `maxFilesPerTask` files (default 10);
- a task body is longer than `maxTaskChars` characters (default 8000);
- a `verify:` executable cannot be found.

## Plan format notes

A task may add `verify: <shell command>` after its other metadata; the rest of the line is the raw command, so `#` is not a comment there. The plan frontmatter may add the same `verify:` line for one integration check after all tasks. Write verify commands scoped to the task's own files, so a parallel worker's half-finished edits cannot break them.

Plan frontmatter has four optional fields that link the rounds of one request and the spec:

- **`trace`:** shared by every plan of one user request. Defaults to the plan id.
- **`spec`:** the saved spec for the request, `.plans/specs/<trace>.md`. The parser ignores it; it is there for the orchestrator, the `plan-auditor` and the reader.
- **`parent`:** the plan id this one follows up. Set on fix rounds.
- **`round`:** `1` for the first plan, `+1` per fix round.

Plan ids for a request are `<trace>-r1`, `<trace>-r2`, and so on. A fix plan keeps `trace`, sets `parent` to the previous plan id, and sets `round` to the next number.

## Tracing and the gate

One trace is one user request across all rounds. Every role appends events to `.plans/traces/<trace>.jsonl`, and `trace.mjs report` renders that file as a Markdown timeline with a rounds table, a plan-audit table, the faults, a models table, and every event in order.

- **Actors:** `sonnet-orchestrator`, `opus-plan-auditor`, `pi-dispatch`, `worker`, `user`.
- **Events from the extension:** `plan.received`, `plan.rejected`, `task.start` (data gains the task's `role`), `task.end`, `task.verify`, `task.review` (data: `round`, `reviewer_role`, `model`, `verdict`, `findings`, `session_id`; a pair reviewer adds `cost` and `tokens`, a security task has them on its `task.end` instead), `fault`, `gate`, `plan.end`. A rejected plan's event goes to its `trace:` value when that is readable, else to the file name.
- **Events from the orchestrator:** `spec.confirmed` (data: `spec`, `requirements`), `plan.drafted` (data: `tasks`, `spec`), `plan.approved` (data: `approved_by`), `loop.stop` (data: `reason`).
- **Events from the plan-auditor:** `plan.audit` (data: `verdict`, `audit_round`, `blockers`, `majors`, `minors`, `summary`). Nobody else writes it.
- **`audit.verdict` is legacy:** the result audit it recorded no longer exists. Nothing writes it, but the report still renders old traces.

The **Models** table in `trace.mjs report` groups runs by model, with roles, tasks,
reviews, tokens, cost and error and warn fault counts, so worker and reviewer spend can
be compared per model. Reviewer tokens appear only there and on the `task.review` event;
reviewer cost is added to the reviewed task's cost.

When the extension accepts a plan it deletes `.plans/failed/<id>.md` and `.plans/failed/<id>.error.md` for that id. To retry a rejected plan, fix it, write it again as `.plans/inbox/<id>.md.draft` and take it through the plan audit and approval again under the same id; there is nothing to delete by hand.

Per plan, the extension saves these in `.plans/done/<plan>/`:

| File | What it is |
|---|---|
| `plan.md` | The plan as it ran |
| `_summary.md` | Cost, tasks, a gate line, and the fault list |
| `<task>.md` | One worker report per task |
| `<task>.prompt.md` | The exact prompt the worker received. Only written for tasks that started, so a skipped task has a report but no prompt file. |
| `<task>.verify.md` | The task's `verify:` result: command, exit code or timeout, duration, output tail. Written only when the task had a `verify:` and the attempt reported success. |
| `plan.verify.md` | The plan-level `verify:` result, same shape. Runs once after every task is done. |
| `evidence.json` | Changed files, faults, gate, verification, pair results and reviewer reports |

Evidence comes from two independent sources, plus the least trusted third:

1. Pi's tool-call stream: which tool edited which path, read from `tool_execution_start` and `tool_execution_end`.
2. A git snapshot before and after the plan: which files actually changed in the checkout.
3. The worker's own report.

### Fault codes

| Code | Severity | Meaning |
|---|---|---|
| `task_failed` | error | The task failed after its retries. |
| `out_of_scope_edit` | error | A worker edited a path outside its `files:`. |
| `unowned_change` | error | A file changed that no task owns. Not raised when some task has no `files:`. |
| `task_skipped` | warn | The task never ran: a dependency failed, the plan was stopped, or it could not be scheduled. |
| `report_malformed` | warn | The report is missing STATUS, CHANGED, TESTS, NOTES or NEEDS. |
| `claimed_not_changed` | warn | The report lists a file as changed that no edit or git change shows. |
| `unreported_change` | warn | A file changed but is not in the task's CHANGED list. |
| `no_op_done` | warn | Marked done, but no edit tool call and no change in its files. |
| `tests_not_run` | warn | The task names tests or checks, but TESTS reports none. |
| `verify_failed` | error | A `verify:` command failed or timed out, for a task or for the plan. |
| `blocked_action` | warn | A worker's tool call was blocked by the live guard. |
| `edit_unread_file` | warn | A worker edited a file that existed before the plan without reading it first. |
| `security_finding` | error / warn / info | A security review finding: high is an error, medium a warning, low info. |
| `pair_unresolved` | warn | Pair rounds ran out, or `maxRunsPerTask` was reached, with findings still open, or an `issues` verdict ended the loop. |
| `review_unparsed` | warn | A pair or security reviewer returned no readable verdict, so the review did not count. |
| `readonly_violation` | error | A read-only task edited something. The guard denies edit tools and obvious shell writes; the window around its own run or its pair reviewer's run catches what it misses, blaming a changed file unless a task running concurrently owns it. |
| `retried` | info | The task succeeded after one or more failed attempts. A pair re-run does not count as a retry. |

### The gate

The gate passes only when every task is done and there are zero error faults. Warnings and info do not block it. A dry run never passes.

The gate is necessary, not sufficient. It says the tasks finished and nothing tripped an error fault. Read the changed files, the `verify:` output and the task reports before reporting to the user; the plan audit checked the plan, not the result.

### `trace.mjs`

All commands run from the repo root, or take `--root <repo>`:

```bash
node ~/.claude/skills/dispatch-plan/trace.mjs new-id [slug]
node ~/.claude/skills/dispatch-plan/trace.mjs event --trace T --actor A --kind K --plan P --round N --data '{"k":"v"}'
node ~/.claude/skills/dispatch-plan/trace.mjs wait --plan P [--timeout 540]
node ~/.claude/skills/dispatch-plan/trace.mjs gate --plan P
node ~/.claude/skills/dispatch-plan/trace.mjs report --trace T
```

- **`new-id [slug]`:** prints a trace id, `yyyymmdd-hhmm-slug`.
- **`event`:** appends one event to `.plans/traces/<trace>.jsonl`.
- **`wait --plan P`:** blocks up to 9 minutes by default. Exits `0` when the plan is done (prints the summary plus a `GATE PASS|FAIL` line), `2` when the plan was rejected, `3` when it is still running (call it again), `4` when it was never picked up (the Pi session is probably not running). The Claude Code Bash tool times out at 120000 ms (2 minutes) unless you raise it, so run this with the Bash tool's `timeout` set to `600000`, or pass `--timeout 100` when you cannot set a timeout. Otherwise the call is killed at 2 minutes and the exit code is lost.
- **`gate --plan P`:** prints the evidence. Exits `0` pass, `1` fail, `2` no evidence yet.
- **`report --trace T`:** prints Markdown and writes `.plans/traces/<T>.md`, including the Models table.

Example:

```bash
node ~/.claude/skills/dispatch-plan/trace.mjs report --trace 20261020-2138-checkout-polish
# prints the rounds table, the faults and the full timeline, and writes
# .plans/traces/20261020-2138-checkout-polish.md
```

## Folders

```
.plans/inbox/            plan drafts: write a temp file, move it to <id>.md.draft; the flip makes <id>.md
.plans/running/          plan currently executing
.plans/done/<id>/        plan.md, _summary.md, <task>.md, <task>.prompt.md, <task>.verify.md, evidence.json
.plans/failed/           rejected plans + reason
.plans/traces/<trace>.jsonl   event log for one user request
.plans/traces/<trace>.md      rendered report for that request
```

## Known limits (Phase 1)

- Pi must be open in that repo. Phase 2 (the standalone worker) removes this.
- Workers share one checkout. File-overlap scheduling prevents edit collisions, but parallel test runs or builds can still interfere with each other.
- A plan left in `running/` after a crash isn't resumed. Move it back to `inbox/` to rerun the whole plan.
- Workers are told to stay inside their files, and the live guard blocks out-of-scope edits and destructive shell commands inside worker processes. For read-only roles it also denies obvious shell writes (redirects to files, `tee`, `sed -i`, `mv`, `cp`, `touch`, `rm`), but that is best-effort; the window around a pair reviewer's or security task's run is the backstop, raising `readonly_violation` for a changed file unless a task running concurrently owns it. For implementers the gate flags an `out_of_scope_edit` or `unowned_change`. Review `git diff` as well.
- With parallel tasks, git evidence is per plan, not per task. The tool-call stream is per task.
- Nobody should edit files in the checkout while a plan runs. Those edits show up as `unowned_change`, or as a `readonly_violation` when they fall in a read-only worker's window.
- The tool-call path detection reads the `path`, `file_path`, `filePath` and `file` arguments, and treats tools whose name contains edit, write or patch as writers. Edits made through a shell command are only visible in the git evidence.
- Pi events for tool calls are read from `tool_execution_start` and `tool_execution_end`.

## Tests

```bash
cd pi-plan-dispatch && npm test
```

The script runs `node --test --test-force-exit`, so the process exits when the tests finish even if an extension's watcher is still open. Needs Node 24+.
