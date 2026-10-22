---
name: dispatch-plan
description: Reference for handing implementation work to Pi workers via .plans/, with a saved spec, a read-only plan audit by Opus, the user's approval and a gate.
---

# dispatch-plan

Sonnet 5.5 is the main session and the orchestrator: the user talks to it directly. It clarifies the request with the `grilling` skill into a saved spec, writes the plan from that spec, has Opus review the plan, gets the user's approval and reports the results. Opus 5.5 runs as the read-only `plan-auditor` subagent and reviews plans only; Opus never reviews worker results. Pi workers (DeepSeek V4.1 Flash on OpenCode Go, run by the `pi-plan-dispatch` extension) implement everything. Post-run quality rests on the dispatcher's gate, the `verify:` commands, the live worker guards and pair review.

The pasteable rules for the orchestrator are in `dispatch-plan/ORCHESTRATOR.md`; the audit checklist and output format are in `dispatch-plan/agents/plan-auditor.md`. This file holds the plan and spec formats, the audit and approval steps, and the commands. Dispatch work that splits into tasks that each touch a known, small set of files. The orchestrator never writes code: a tiny job, or one that needs judgment across the whole codebase, still goes out as a plan, and a one-task plan is fine. The orchestrator only reads files, runs read-only commands and answers questions.

## 1. Plan format

```markdown
---
id: <trace>-r1
trace: <trace>
spec: .plans/specs/<trace>.md
round: 1
status: draft
max_parallel: 3
verify: npm test
---
<Shared context every worker needs: goal, conventions, key types/interfaces,
commands to run tests. Workers see ONLY this plus their own task. Be explicit.>

## task: <task-id>
files: path/one.ts, path/two.test.ts
depends_on: []
role: implement
verify: node --test path/two.test.ts
pair: review            # optional: read-only review before the task is done
Covers: R1, R3.
<Instructions. Name the exact function signatures, behaviour, edge cases,
and the test command to run. Write it for a capable but context-free engineer.>

## task: <another-id>
files: src/other/
depends_on: [<task-id>]
Covers: R2.
...
```

- `id`: `<trace>-r1` for the first plan of a request, `<trace>-r2` up to `<trace>-r4` for fix rounds.
- `trace:`: shared by every plan of one user request, defaults to the plan id. Create it with `node ~/.claude/skills/dispatch-plan/trace.mjs new-id <slug>`.
- `spec:`: the saved spec for the request (section 2). The plan parser ignores frontmatter keys it does not read, so `spec:` changes nothing for the dispatcher; it is there for the orchestrator, the `plan-auditor` and the reader.
- `parent:` absent on round 1, the previous plan id on a fix round; `round:` is `1` for the first plan, `+1` per fix round. Together they link the rounds.
- `Covers:` is the first body line of every task, for example `Covers: R1, R2.` It names the spec requirements the task implements. It is not a task metadata key, so it is ordinary instruction text the worker reads; the parser does not check it, the `plan-auditor` does.
- `files:` lists every path the task may edit. A directory (`src/other/`) covers everything under it. Tasks whose files overlap never run at the same time. A task with no `files:` runs alone, so always list files.
- `depends_on:` holds task ids that must finish first. If a dependency fails, its dependents are skipped.
- `verify:` is a shell command the dispatcher runs, never the worker. A task-level one runs after the attempt reports success; exit 0 verifies it, non-zero or a timeout fails the attempt (retried with the output as feedback when `retries` allow). Scope it to that task's own files, for example a single test file, so a parallel worker's half-finished edits cannot break it. Write one per task.
- The plan-level `verify:` runs once after every task is done, so it can be the integration check (`npm test`). A failing plan-level check adds a `verify_failed` error fault and fails the gate.
- `role:` picks the job: `implement` by default; add a `qa` task after implementation for features, and a `security` task after all implementation tasks for anything touching input handling, auth, secrets, files, network or shell. Only `security` can be a read-only task role; `review` and any other read-only role are only `pair:` reviewers. Roles and their models are in `docs/roles.md`.
- `pair: review` on a risky implementation task runs a read-only reviewer before the task counts as done. It roughly doubles worker spend on that task, which is small next to an audit round; `pair_rounds:` (1-3) bounds it.
- Never write model names in plans unless you are overriding on purpose. `.plans/config.json` maps roles to models; the per-task overrides `model:` and `thinking:` (for example `thinking: high`) exist for that deliberate exception.
- Preflight rejects the plan before any worker starts when a `files:` entry is absolute, contains a `..` segment, or points inside `.git/` or `.plans/`; a task lists more than `maxFilesPerTask` files (10); a task body is longer than `maxTaskChars` chars (8000); or a `verify:` executable cannot be found. Keep tasks small: split rather than widen.
- Put shared interfaces in the plan context, or in an early task others depend on, so parallel workers agree. Workers don't commit; the user commits, and only when they asked.

## 2. Spec

The orchestrator clarifies the request with the `grilling` skill until the requirements are stable, then saves the spec at `.plans/specs/<trace>.md`. One spec serves every plan of the request, fix rounds included; the plan's `spec:` key points at it, and every task starts its body with `Covers: R1, R2.`

```markdown
# Spec: <title>

Trace: <trace>. Date: <date>.

## Goal
<one paragraph: what changes and why>

## Requirements
- R1. <testable requirement>
- R2. <testable requirement>

## Non-goals
- <what is out of scope on purpose>

## Constraints
- <hard limits: files that must not change, formats, compatibility>

## Acceptance criteria
- <how a reader can tell the result is right>

## Decisions (user, <date>)
1. <decision and its reason>

## Open items (not blocking this spec)
- <question still open, or none>
```

Number the requirements R1 to Rn and keep the numbers stable: plans, audit findings and the trace table refer to them by number. When the user confirms the spec, the orchestrator logs `spec.confirmed` (data `{"spec": "<path>", "requirements": <count>}`).

## 3. Draft it atomically

Every draft is a `.md.draft` file with `status: draft`, round 1 and fix rounds alike. The dispatcher reads only `*.md` files, so a draft is never picked up while it is being written, audited or approved.

Write `.plans/inbox/.<id>.md.draft.tmp` first, then move it:

```bash
mkdir -p .plans/inbox && mv .plans/inbox/.<id>.md.draft.tmp .plans/inbox/<id>.md.draft
```

The flip command in section 5 is the only way to make a plan ready. After writing a draft, the orchestrator logs `plan.drafted` with data `{"tasks": <count>, "spec": "<path>"}`.

## 4. Plan audit

No plan runs before it is audited. Run the preflight CLI first and fix every `ERROR:` before spending an audit round; it runs the dispatcher's own parsing and preflight, so its errors are real rejections, not opinions:

```bash
node ~/.claude/skills/dispatch-plan/preflight.mjs <plan file>
```

Then spawn the read-only `plan-auditor` subagent (Opus 5.5) with the Agent tool, `subagent_type: plan-auditor`, and give it the plan path, the spec path, the trace id, the plan id, the plan round and the audit round number. Its checklist and output format are in `dispatch-plan/agents/plan-auditor.md`.

- `[blocker]`: the plan would fail to run, would produce wrong results, loses data, or breaks a hard rule.
- `[major]`: a real defect with a workaround or a narrow trigger, or an ambiguity that will make a worker guess.
- `[minor]`: wording, cosmetic or style. Minors are recorded as notes and do not fail the round.

Verdict `pass` means zero blockers and zero majors. Revise the plan for every blocker and major and send it back for another audit round, at most 3 audit rounds. If audit round 3 still has blockers or majors, stop, log `loop.stop` with data `{"reason": "<text>"}` and ask the user how to proceed. Only the `plan-auditor` logs `plan.audit`, once per round, as actor `opus-plan-auditor`; the orchestrator must not log it again, or the Plan audit table in the trace report gets duplicate rows.

## 5. Approval

Pilot mode is the default: the `.plans/config.json` key `autoReady` is false, and the orchestrator never turns it on. Show the user the plan summary, the requirement-to-task trace the audit returned and any minor notes, then ask for approval.

Only after the user says yes, the orchestrator logs `plan.approved` with data `{"approved_by": "user"}` and flips the draft:

```bash
sed -E '2,/^---$/ s/^status:[[:space:]]*draft([[:space:]]+#.*)?[[:space:]]*$/status: ready/' .plans/inbox/<id>.md.draft > .plans/inbox/.<id>.md.tmp && grep -q '^status: ready$' .plans/inbox/.<id>.md.tmp && mv .plans/inbox/.<id>.md.tmp .plans/inbox/<id>.md && rm .plans/inbox/<id>.md.draft
```

The `sed` edits only the frontmatter, from line 2 to the closing `---`, so a `status: draft` line in a task body is never touched; the `grep` stops the flip when no `status: ready` line resulted, and the draft survives. If the user sets `autoReady` to true, a clean audit may flip the plan without asking, still logging `plan.approved` with `approved_by: "autoReady"`. Only the user enables that key.

`node ~/.claude/skills/dispatch-plan/config-init.mjs` writes `.plans/config.json` with the dispatcher's defaults; `--minimal` writes only the review role, `--force` replaces an existing file, `--print` shows the JSON without writing. Run it before the first plan in a repo.

## 6. Wait

Run this from the repo root, in the foreground. It blocks up to 9 minutes, so run it with the Bash tool's `timeout` set to `600000` ms. The Bash tool default is `120000` ms and would kill the call at 2 minutes, losing the exit code; `600000` is only the maximum. If the caller cannot set a timeout, pass `--timeout 100` instead:

```bash
node ~/.claude/skills/dispatch-plan/trace.mjs wait --plan <id> --timeout 540
```

On exit `0` it prints the summary and a `GATE PASS|FAIL` line. Read the exit code:

- `0`: done. Read the gate (section 7) and report the result to the user.
- `2`: the plan was rejected, which is a format error. Read `.plans/failed/<id>.error.md`, rewrite `.plans/inbox/<id>.md.draft` from `.plans/failed/<id>.md` with the fix and `status: draft`, rerun preflight, get the user's approval again, log `plan.approved` again, re-audit if more than the rejected line changed (that re-audit counts toward the `audit_round` cap of 3), then flip it under the same id. The extension deletes the stale rejection files when it accepts the plan, so nothing has to be removed by hand; `wait` also ignores a rejection older than the wait while the plan is queued or running.
- `3`: still running. Call `wait` again, at most 6 calls in total for one plan. If the 6th call still exits `3`, stop and tell the user.
- `4`: never picked up, so the Pi session with `pi-plan-dispatch` is probably not running. Stop and tell the user.
- Any other exit code: call `wait` again, at most 6 calls in total for one plan. If the error says a module or file was not found, stop at once and tell the user: the installed skill folder is stale (section 9).

## 7. Gate and evidence

Every finished plan leaves `.plans/done/<id>/` with `plan.md`, `_summary.md` (gate line plus fault list), one `<task>.md` report per task, one `<task>.prompt.md` holding the exact prompt the worker received (written only when the task starts, so a skipped task has a report but no prompt file), a `<task>.verify.md` and/or `plan.verify.md` when a `verify:` command ran (command, exit code or timeout, duration, output tail), and `evidence.json`.

`evidence.json` holds `plan`, `trace`, `round`, `parent`, `changed` (files that actually changed, from a git snapshot before and after the plan), `faults`, `verify`, and `gate` (`pass`, `reasons`, `counts`, `tasks`, `evidence`). Evidence has two sources: Pi's tool-call stream (which tool edited which path, per task) and the git snapshot (what changed in the checkout, per plan). The worker's report is the third and least trusted source. Run `node ~/.claude/skills/dispatch-plan/trace.mjs gate --plan <id>` to print the gate, faults and changed files; it exits `0` pass, `1` fail, `2` no evidence yet.

| Severity | Codes |
|---|---|
| error | `task_failed`, `out_of_scope_edit` (edited outside its `files:`), `unowned_change` (a file changed that no task owns, unless some task has no `files:`), `verify_failed` (a `verify:` command failed or timed out, per task or for the plan), `readonly_violation` (a read-only task edited something; the window around its own run or its pair reviewer's run blames a changed file unless a task running concurrently owns it), `security_finding` at high severity |
| warn | `task_skipped`, `report_malformed`, `claimed_not_changed`, `unreported_change`, `no_op_done`, `tests_not_run`, `blocked_action` (the live guard blocked a tool call), `edit_unread_file` (edited a pre-existing file without reading it), `pair_unresolved` (pair rounds ended with findings open, or an `issues` verdict ended the loop), `review_unparsed` (a reviewer returned no readable verdict), `security_finding` at medium severity |
| info | `retried`, `security_finding` at low severity |

The gate passes only when every task is done and there are zero error faults. A dry run never passes. The gate is necessary, not sufficient: read the changed files, the `verify:` output and the task reports before reporting to the user, and report the faults in plain words.

## 8. Trace

One trace is one user request across all rounds; every event appends to `.plans/traces/<trace>.jsonl`. Actors: `sonnet-orchestrator`, `opus-plan-auditor`, `pi-dispatch`, `worker`, `user`.

```bash
node ~/.claude/skills/dispatch-plan/trace.mjs event --trace <T> --actor <A> \
  --kind <K> --plan <P> --round <N> --data '{"k":"v"}'
```

The event-level `--round` is always the plan round, the number in the plan id. The audit round counter lives in `plan.audit` data as `audit_round`, never in `--round`.

- The extension writes `plan.received`, `plan.rejected` (its trace is the plan's `trace:` value when readable, else the file name), `task.start` (data gains the task's `role`), `task.end`, `task.verify` (data with the command, exit code, timeout flag, duration and output tail; the plan-level check has `scope: "plan"`), `task.review` (a pair or security review: `round`, `reviewer_role`, `model`, `verdict`, `findings`, `session_id`; a pair reviewer adds `cost` and `tokens`, a security task has them on its `task.end` instead), `fault`, `gate` and `plan.end`. Do not duplicate them.
- The orchestrator writes, as actor `sonnet-orchestrator`: `spec.confirmed` (data `{"spec": "<path>", "requirements": <count>}`), `plan.drafted` (data `{"tasks": <count>, "spec": "<path>"}`), `plan.approved` (data `{"approved_by": "user"|"autoReady"}`) and `loop.stop` (data `{"reason": "<text>"}`).
- The `plan-auditor` writes, as actor `opus-plan-auditor`: `plan.audit` (data `{"verdict": "pass"|"fail", "audit_round": <1..3>, "blockers": <n>, "majors": <n>, "minors": <n>, "summary": "<one line>"}`). Nobody else writes it.
- `audit.verdict` is legacy: the result audit it recorded no longer exists. Nothing writes it; the report still renders old traces that contain it.

Run `node ~/.claude/skills/dispatch-plan/trace.mjs report --trace <T>` to render a Markdown timeline to stdout and write `.plans/traces/<T>.md`. Its Plan audit table lists the audit rounds, and its Models table breaks down tokens, cost and faults per model and role. Quote its headline in the final report.

## 9. Fix plans and limits

- A failed gate goes back to planning with the evidence, never forward to a review. Draft the next fix plan from the gate evidence and its faults: id `<trace>-r<n+1>`, the same `trace:` and `spec:`, `parent:` the previous plan id, `round: <n+1>`, `status: draft`. Fix tasks come from the failed gate and its faults.
- A fix draft goes through the same steps as round 1: preflight, plan audit, the user's approval and the flip. Reuse the spec and update it if the fix changes a requirement.
- Stop after 3 fix rounds, so the last plan id ends in `-r4`, or when the same finding repeats. Log `loop.stop` with the reason and report the open findings to the user instead of looping: the plan or the task split is probably wrong.
- A rejected plan (bad `files:`, over the `maxFilesPerTask` 10 or `maxTaskChars` 8000 limits, unknown `verify:` executable) is a preflight problem, not a review failure: read `.plans/failed/<id>.error.md` and follow the exit-`2` steps in section 6.
- Write a task-level `verify:` per task and one plan-level integration `verify:`. Nobody commits unless the user asked.

## 10. Vault

The vault is the agent memory: an Obsidian vault in its own git repo, cloned next to this repo, holding notes and a log that outlive one machine. The orchestrator is the only role that writes it, and only through the CLI at `node ~/.claude/skills/dispatch-plan/vault.mjs`; its commands, schema and privacy modes are in `docs/vault.md`. A repo's mode is `full` (all note types), `meta` (`run`, `decision`, `lesson` and `idea` only) or `none` (nothing); pass `--trace <T> --root <repo root>` to every vault command so the CLI writes its trace events. Workers have no vault access: the dispatcher drops `AGENT_VAULT` from their environment and sets `PI_PLAN_DISPATCH_WORKER=1`, which makes the CLI refuse every command, and the guard denies tool paths inside the vault. The vault's events reach the timeline as actor `vault`: `vault.boot`, `vault.write`, `vault.sync`, `vault.unavailable`, `vault.denied`, `vault.work`, `vault.restore` and `vault.config`. The long write rules live in the orchestrator block in `dispatch-plan/ORCHESTRATOR.md`.

In a `full` repo the working specs and plans are mirrored into notes at five milestones: spec confirmed writes the `spec` note with status `confirmed`; a drafted or revised plan writes the `plan` note with status `draft` and its `file`; each audit verdict is one `note set` of `audit` and `audit_round`; approval and the flip set the plan status `ready`; a finished run sets it `done` or `failed`, and the spec `done` when the request is finished. The working copies stay in `.plans/`, and `.plans/ideas.md` is retired once its entries are copied into `idea` notes.

The record of a finished request goes to `work/<trace>/` (the trace without its `vault` lines, the rendered report, the per-plan summaries, `evidence.json`, the verify outputs and the task reports, plus `probes/` with `--probes`): `work add --trace <T> --root <repo root> [--probes]` copies it, `work pending --root <repo root>` lists the finished requests the vault misses, and `restore --root <repo root>` rebuilds the specs and draft plans of the repo, then lists its open ideas and the last 3 run digests. `config push --root <repo root>` and `config pull --root <repo root> [--force]` move `.plans/config.json` through `config/dispatch.json`. `work/` and `config/` are written only by the CLI, never by hand.

The copy fails closed: a file that is not UTF-8 text, that matches a secret pattern or that names a `none` repo is not copied, is printed as `unmirrored <path>: <reason>`, and leaves the exit code `6` (partial) while the rest is copied. `work add` in a `meta` repo copies nothing and exits `0`; in a `none` repo it exits `3`.

### Install

```bash
mkdir -p ~/.claude/skills/dispatch-plan && cp dispatch-plan/SKILL.md dispatch-plan/ORCHESTRATOR.md dispatch-plan/trace.mjs dispatch-plan/preflight.mjs dispatch-plan/config-init.mjs dispatch-plan/vault.mjs dispatch-plan/vault-admin.mjs dispatch-plan/vault-events.mjs dispatch-plan/vault-work.mjs dispatch-plan/vault-restore.mjs dispatch-plan/vault-config.mjs ~/.claude/skills/dispatch-plan/
mkdir -p ~/.claude/agents && cp dispatch-plan/agents/plan-auditor.md ~/.claude/agents/
rm -f ~/.claude/agents/planner.md ~/.claude/agents/auditor.md
```

Copy the runtime files by name; the `dispatch-plan/` folder also holds `archive/` and the tests, which must not be installed. The `rm -f` line removes the two superseded agent files from an earlier install. The installed copies are what `~/.claude/skills/dispatch-plan/trace.mjs` and `preflight.mjs` resolve to, so refresh them after pulling changes; a missing module means a stale install.
