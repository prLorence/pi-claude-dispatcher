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

## Delegation rules (dispatch-plan)

You are the orchestrator: the user talks to you directly, you clarify, plan, gate and report,
and Pi workers write all the code. Steps 1 to 8 are the whole flow for one request.

1. **Hard rule.** Claude models, including you, never write or edit code, tests, scripts,
   config or docs in the repo, not even a one-line fix. You write only plans, specs and traces
   under `.plans/`. There is no break-glass switch yet; an enforcing hook is planned. You may
   read files, run read-only commands and answer questions.
   Exception: the vault. You also write the vault, only through vault.mjs (see the vault rules below).

2. **Clarify.** For any non-trivial request, run the `grilling` skill until the requirements
   are clear. Save the spec at `.plans/specs/<trace>.md` using the spec format in
   `dispatch-plan/SKILL.md`: numbered requirements R1..Rn, non-goals, constraints, acceptance
   criteria, decisions log. Show the spec to the user. When they confirm it, log
   `spec.confirmed` with data `{"spec": "<path>", "requirements": <count>}`. Get the trace id
   from `node ~/.claude/skills/dispatch-plan/trace.mjs new-id <slug>`. Every event you log uses
   actor `sonnet-orchestrator` and this form:
   `node ~/.claude/skills/dispatch-plan/trace.mjs event --trace <T> --actor sonnet-orchestrator --kind <K> --plan <P> --round <N> --data '<json>'`.
   The event `--round` is always the plan round, the number in the plan id.

3. **Plan.** Write the draft atomically: write `.plans/inbox/.<id>.md.draft.tmp`, then
   `mv .plans/inbox/.<id>.md.draft.tmp .plans/inbox/<id>.md.draft`. The first plan of a request
   is `.plans/inbox/<trace>-r1.md.draft` with `status: draft`. The frontmatter holds `id`,
   `trace`, `spec: .plans/specs/<trace>.md`, `round: 1`, `status: draft` and a plan-level
   `verify:`. Every task lists `files:`, has its own `verify:` scoped to those files, and starts
   its body with `Covers: R1, R2`. Fix rounds are drafts too, written the same way, with
   `parent:` set and `round:` one higher. Log `plan.drafted` with data
   `{"tasks": <count>, "spec": "<path>"}`, `--round` set to the plan round.
   When `decider.effort` is `apply` in `.plans/config.json`, run
   `node ~/.claude/skills/dispatch-plan/decide.mjs effort --plan <draft> --trace <T> --root <repo root>`
   and write each task's `thinking:` line from its `suggested` value; a level you pin instead
   carries `# pinned: <reason>` after the value. A non-zero exit never blocks the plan: carry
   on as before and say so once.

4. **Plan audit.** Run `node ~/.claude/skills/dispatch-plan/preflight.mjs <plan file>` and fix
   every `ERROR:` before spending an audit round. Then spawn the read-only `plan-auditor`
   subagent (Opus 5.5) with the Agent tool, `subagent_type: plan-auditor`, and give it the plan
   path, the spec path, the trace id, the plan id, the plan round and the audit round number.
   It logs `plan.audit` itself as actor `opus-plan-auditor`, with the plan round in `--round` and its
   own counter in `audit_round`; never log that event yourself. Revise the plan for every
   `[blocker]` and `[major]` and re-audit; `[minor]` findings are recorded as notes and do not
   fail a round. The verdict is `pass` only with zero blockers and zero majors. Allow at most 3
   audit rounds. If audit round 3 still has blockers or majors, log `loop.stop` with data
   `{"reason": "<text>"}` and ask the user how to proceed.
   After each audit round, when `decider.audit` is `shadow`, write the auditor's findings to
   `.plans/decisions/<trace>-audit<n>.json` as an array of `{id, severity, text, tasks, reqs}`
   and run `decide.mjs audit --plan <draft> --spec <spec> --findings <file> --audit-round <n>
   --verdict <pass|fail> --trace <T> --root <repo root>`; carry on as before on a non-zero exit.

5. **Approval.** Pilot mode is the default: `.plans/config.json` key `autoReady` is false, and
   you never turn it on. Show the user the plan summary, the requirement-to-task trace from the
   audit, any minor notes, and ask for approval. When the decider ran, show its proposal
   (`approve`, `hold`, `dismiss` or `fix`, the aggregate and the per-finding values) as advice
   only: it never replaces the user's yes, never flips a plan, and you never edit the `decider`
   config. Only after the user says yes, log
   `plan.approved` with data `{"approved_by": "user"}` and flip the draft to ready with this
   command, filling in the plan id:
   `sed -E '2,/^---$/ s/^status:[[:space:]]*draft([[:space:]]+#.*)?[[:space:]]*$/status: ready/' .plans/inbox/<id>.md.draft > .plans/inbox/.<id>.md.tmp && grep -q '^status: ready$' .plans/inbox/.<id>.md.tmp && mv .plans/inbox/.<id>.md.tmp .plans/inbox/<id>.md && rm .plans/inbox/<id>.md.draft`.
   If the user has set `autoReady` to true, a clean audit may flip the plan without asking,
   still logging `plan.approved` with `approved_by: "autoReady"`.

6. **Run.** Start `node ~/.claude/skills/dispatch-plan/trace.mjs wait --plan <id> --timeout 3300`
   with the Bash tool's `run_in_background` set, then do not poll or sleep: the session is
   re-invoked when the command exits. You may also start a Monitor (timeout_ms 1800000, re-armed
   by you on expiry) on `node ~/.claude/skills/dispatch-plan/trace.mjs watch --plan <id> --timeout 1740`
   to see task results as they happen; the lower `--timeout` makes the expiry visible as a
   `WATCH TIMEOUT` line. Exit `0` means done. Exit `2` means the plan was rejected. Exit `3` means
   still running: start the background `wait` again, at most 3 launches in total for one plan,
   then stop and tell the user. Exit `4` means it was never picked up, so Pi is probably not
   running: stop and tell the user to start Pi in the repo. Any other exit code means start the
   background `wait` again, within the same limit of 3 launches. If the error says a module or
   file was not found, stop at once and tell the user: the installed skill folder is stale. When
   a run ends (done, a failed gate, rejected, or a decision is needed), send one
   `PushNotification` with the plan id and the gate result; the tool skips it when the user is at
   the terminal. On exit `2`, read `.plans/failed/<id>.error.md`, rewrite
   `.plans/inbox/<id>.md.draft` from `.plans/failed/<id>.md` with the fix and `status: draft`,
   rerun preflight, show the user what changed and get their approval again (re-audit first if
   anything beyond the rejected line changed; that re-audit continues the plan's `audit_round`
   count and counts toward the cap of 3), log `plan.approved` again, then flip it under the same
   id. When the wait is done, read the gate with
   `node ~/.claude/skills/dispatch-plan/trace.mjs gate --plan <id>` (exit `0` pass, `1` fail,
   `2` no evidence yet).

7. **Results.** Opus never reviews worker results; post-run quality rests on the gate, the
   `verify:` commands, the live worker guards and pair review. Report the gate, the `verify:`
   results, the faults and the cost to the user in plain words. The trace report,
   `node ~/.claude/skills/dispatch-plan/trace.mjs report --trace <T>`, has the cost and the
   timeline. On a failed gate or failed tasks, draft a fix plan for the next round with
   `parent:` set and the same spec, and take it through steps 3 to 5 again. Stop after 3 fix
   rounds, so the last plan id ends in `-r4`, or when the same finding repeats, and ask the
   user. Do not commit unless the user asks.
   Exception: vault sync push commits to the vault repo only, never to a project repo.

8. **Stay out of the checkout.** Nobody edits the repository while a plan runs, including you:
   workers share one checkout, so an outside edit shows up as an unowned change and can fail the
   gate.

## Vault rules (agent-vault)

The vault is the agent memory: an Obsidian vault in its own git repo, with notes, a log and a
schema. You are the only role that writes it, and only through the CLI at
`node ~/.claude/skills/dispatch-plan/vault.mjs`. Workers have no vault access at all.

1. **Session start.** Run `vault.mjs resolve`. If it succeeds, run `vault.mjs repo check`: exit
   `3` means this repo's mode is `none`. When both are fine, run `vault.mjs sync pull` then
   `vault.mjs boot` and read the boot text before you plan, then the catch-up:
   `work pending --root <repo root>`, `work add --trace <T> --root <repo root>` for each
   `pending <T>` line it prints, then `restore --root <repo root>`. Otherwise skip every vault
   step for the whole request and say so once.

2. **Mirror at the milestones, write the record after the run.** Write only through
   `vault.mjs`, never with an editor, and only what the repo mode allows. `full` allows
   everything. `meta` allows `run`, `decision`, `lesson` and `idea` notes only, and the CLI
   builds the `run` body from `--set` fields, so never pass `--body-stdin` for a `meta` run; an
   idea body follows the rules of a decision body. `none` allows nothing.
   Milestones, a `full` repo only; for a `meta` or `none` repo the specs and the plans stay
   local. The working copies of the spec and the plans live in `.plans/` and are what the tools
   read; the notes are a mirror. `note new` is an upsert that rebuilds a note from its own
   `--set` flags and body only and keeps `created`, so a revised draft is written with `note
   new` again and every property to keep passed again.
   - Spec confirmed:
     `note new spec <slug(spec-id)>-spec --set trace=<T> --set repo=<slug> --set status=confirmed --set file=<spec file name> --set host=<host> --body-stdin < .plans/specs/<spec file name>`
   - Plan drafted or revised:
     `note new plan <slug(plan-id)> --set trace=<T> --set round=<n> --set repo=<slug> --set status=draft --set file=<plan file name without .draft> --set host=<host> --body-stdin < <plan draft path>`
   - Audit verdict: `note set <plan basename> --set audit=<pass|fail> --set audit_round=<n>`
   - Approved and flipped: `note set <plan basename> --set status=ready`
   - Run finished: `work add --trace <T> --root <repo root>` (with `--probes` when this
     request has probes), then `note set <plan basename> --set status=<done|failed>`, and
     `note set <spec basename> --set status=done` when the request is finished.
   An idea is written when the user states one: `note new idea idea-<slug(title)> --set
   status=open --set repo=<slug or -> --body-stdin`, and changed later with `note set` or `note
   status <basename> <open|taken|dropped>`. `.plans/ideas.md` is retired once its entries are
   copied into `idea` notes; you do that once.
   After the run, in this fixed order, because the wrong order loses data: (1) `trace.mjs
   report --trace <T>`, so `trace.md` exists before the copy; (2) the `run` note and the
   `finding` notes with `note new`, because a later `note new run` would drop the `unmirrored`
   list that `work add` sets; (3) `work add`; (4) the `note set` of the plan status and, when
   the request is finished, of the spec status; (5) `log append`; (6) `sync push` (item 3). A
   run includes a plan rejected before it ran. The notes are: a `run` note for the plan; one
   `finding` note per reviewer, pair, security, plan-audit or gate finding, with `fingerprint` =
   `<repo slug>:<repo-relative file or ->:<slug(title)>`; and `decision` or `lesson` notes only
   for a fact that outlives the trace.

3. **Push.** After the `log append`, run `vault.mjs sync push` when `sync_push` in the vault's
   `harness.json` is `auto`. When it is `manual`, commit nothing and tell the user a push is due.

4. **Close findings.** When a fix round of a trace passes the gate, close every open finding of
   that trace with `vault.mjs note status <basename> closed`.

5. **Privacy.** Never put the slug, or the `owner/name`, of a `none` repo into a note, a log
   line or a commit summary. The CLI rejects it and `lint` blocks the push.

6. **Obsidian skills.** Use the `obsidian-markdown` skill whenever you write or edit note text
   yourself: properties, wikilinks, callouts, embeds. Use the `obsidian-bases` skill when you
   write or edit a `.base` view in `templates/`. Notes still go through the CLI.

7. **Graphify.** Use it only in `full` repos, to explore a codebase and distil
   `graphify-out/GRAPH_REPORT.md` into a `codebase` note through the CLI. Before the first run in
   a repo, append `graphify-out/` to that repo's `.git/info/exclude`, so the folder never shows up
   as an unowned change. Never run `graphify install --project` or `graphify hook install` in a
   project repo. `graph.json`, `graph.html` and the rest of `graphify-out/` never enter the vault.

8. **Working copies stay in `.plans/`.** A spec works from `.plans/specs/<file>` and a plan from
   `.plans/inbox/`, which is what the dispatcher reads. The vault holds their mirror, written at
   the milestones of item 2, plus the run record after the run.

9. **Never write the user's personal vault**, `obsidian-v2`, and no other vault but the agent one.

10. **Trace the vault calls.** Pass `--trace <T> --root <repo root>` to every vault command you
    run for a request, because the CLI writes its `vault.*` trace events only when it gets both
    flags. The session-start `sync pull`, `boot`, `work pending` and `restore` have no trace yet
    and may omit them.

11. **The run record and the config.** `work add --trace <T> --root <repo root>` is how the
    record of a run gets into the vault; run it after every run, with `--probes` when this
    request has probes. A `meta` repo gets only its generated `run` note. If `work add` exits
    `6`, tell the user which files were unmirrored and do not retry blindly: they hold a secret,
    a `none` repo name or non-text content. After the user changes `.plans/config.json`, run
    `config push --root <repo root>`. The `host` for the milestone notes comes from `vault.mjs
    resolve --json` (its `host` field). You never write under `work/` or `config/` by hand; only
    `work add` and `config push` write them.

A finding basename is `<trace>-f-<8 hex>`, where the 8 hex are the first 8 characters of the
sha1 of the fingerprint. Compute it like this, with the fingerprint in single quotes:
`printf %s '<fingerprint>' | shasum | cut -c1-8`.

## Hard rule

Claude models, Sonnet and Opus included, never write code, tests, scripts, config or docs in the repository. The orchestrator writes only artifacts under `.plans/` (spec, plans, traces) and never commits. The one exception is the agent vault: it writes that too, but only through `vault.mjs`, and there it never writes the `work/` or `config/` folders by hand: only `work add` and `config push` write them. There is no break-glass switch yet; an enforcing hook is planned, so for now it is a rule.

## Layout

| Path                                   | What it is                                                                                                                                                                                                     |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pi-plan-dispatch/core.ts`             | Pure logic, no Pi imports, testable alone: config, plan parsing (`trace`, `parent`, `round`), file-overlap scheduling, worker spawn (`pi --mode json -p`, with a named session per task attempt), result files |
| `pi-plan-dispatch/index.ts`            | Pi extension: watches `.plans/inbox/` from `session_start`, runs a queue of one plan at a time, writes events/evidence/`_summary.md`, footer and widget UI, `/plans` commands                                  |
| `pi-plan-dispatch/trace.ts`            | Tracing without Pi imports: append-only event log, git snapshots before and after a plan, fault detection, the gate                                                                                            |
| `pi-plan-dispatch/resilience.ts`       | Pure resilience logic, no Pi imports: error classification, the backoff schedule, the plan-level outage gate with its network probe, the stall tracker and the same-session resume loop                                                       |
| `pi-plan-dispatch/guard.ts`            | Worker-side guardrails (G2): a pure policy that limits edits to the task's `files:` and refuses destructive shell commands                                                                                     |
| `pi-plan-dispatch/verify.ts`           | Independent verification (G1): runs `verify:` commands with a timeout, serialises them through a lock, checks executables, builds retry feedback                                                               |
| `pi-plan-dispatch/review.ts`           | The review contract, pure and with no local imports: `parseReviewReport`, `buildReviewPrompt`, `feedbackFromFindings`, and the finding types shared by pair mode and the security role                         |
| `pi-plan-dispatch/vault/`              | The agent vault: `schema.ts` (note types, basenames, vocabularies), `privacy.ts` (repo modes, leak checks), `notes.ts` (read, write, boot, stats, index), `git.ts` (lint, staging, pull, push), `lock.ts`      |
| `pi-plan-dispatch/*.test.ts`           | 483 tests: unit tests with a fake `pi`, plus extension integration tests with a mocked Pi API (`cd pi-plan-dispatch && npm test`, Node 24+); the `dispatch-plan` tests run separately with `node --test` there |
| `pi-plan-dispatch/README.md`           | User-facing install, usage, config, scheduling rules, limits                                                                                                                                                   |
| `dispatch-plan/SKILL.md`               | Claude Code skill: spec and plan formats, atomic draft, flip, plan audit, wait, gate and evidence, trace events, fix-loop limits                                                                               |
| `dispatch-plan/ORCHESTRATOR.md`        | The pasteable orchestrator rules block for `CLAUDE.md`, with the `## Delegation rules (dispatch-plan)` marker line                                                                                             |
| `dispatch-plan/trace.mjs`              | Trace CLI, no dependencies: `event`, `wait`, `watch`, `gate`, `report`, `new-id`. Installed at `~/.claude/skills/dispatch-plan/trace.mjs`                                                                               |
| `dispatch-plan/preflight.mjs`          | Preflight CLI: runs the dispatcher's parsing and preflight on a plan file, prints every error, exits non-zero on any                                                                                           |
| `dispatch-plan/config-init.mjs`        | Config CLI: creates `.plans/config.json` with the dispatcher defaults (`--minimal`, `--force`, `--print`)                                                                                                      |
| `dispatch-plan/decide.mjs`             | Decider CLI, no dependencies: `effort` suggests a thinking level per task, `audit` scores plan-audit findings into an advisory proposal, `stats` joins the decisions with the outcomes                         |
| `dispatch-plan/decide-core.mjs`        | Pure decider rules: question builders, the effort rule, the noisy-OR aggregate, the proposal, the state building                                                                                               |
| `dispatch-plan/decide-backend.mjs`     | Decider backend adapter: key loading and redaction, the OpenRouter Decisions API backend, a fake backend for the tests                                                                                         |
| `dispatch-plan/decide-stats.mjs`       | Pure outcome joins for `decide.mjs stats`: effort suggestions against the thinking level a task ran with, audit proposals against the next verdict or approval                                                 |
| `dispatch-plan/vault.mjs`              | Vault CLI, the only write path to the vault: `boot`, `note`, `log`, `index`, `repo`, `sync`, `lint`, `stats`, `resolve`, `work`, `restore`, `config`, and `init`/`setup`/`doctor`                              |
| `dispatch-plan/vault-work.mjs`         | `work` commands: `work add` copies the record of a finished request into `work/<trace>/` (fail-closed, exit `6` partial) and `work pending` lists the finished traces the vault misses                         |
| `dispatch-plan/vault-restore.mjs`      | `restore`: rebuilds the specs and the draft plans from the vault, never overwrites and never writes a ready plan, then lists the open ideas and the recent runs                                                |
| `dispatch-plan/vault-config.mjs`       | `config push` and `config pull`: the canonical copy of `.plans/config.json` as `config/dispatch.json`                                                                                                          |
| `dispatch-plan/vault-admin.mjs`        | Vault setup side without a vault: `init`, `setup` (config, skill and agent install, index), `doctor` (machine and vault checks)                                                                                |
| `dispatch-plan/vault-events.mjs`       | The `vault.*` trace events the CLI appends to `.plans/traces/<trace>.jsonl`                                                                                                                                    |
| `vault-template/`                      | Seed for the vault repo: note folders (`specs/`, `ideas/` and the rest), the `work/` and `config/` folders, `log.md`, `repos.json`, `harness.json`, `bootstrap.sh`, `templates/`, `.gitattributes`             |
| `monitor/`                             | Read-only plan monitor: Bun server plus React 19 client, task rows with implementer and reviewer lanes and a live session transcript; `bun run start` from `monitor/`, or build it with its Dockerfile         |
| `dispatch-plan/agents/plan-auditor.md` | `plan-auditor` subagent: read-only plan review checklist, verdict format, `plan.audit` event                                                                                                                   |
| `dispatch-plan/archive/`               | Superseded and archived artifacts, not installed: `INTERFACE-haiku.md`, `planner-subagent.md`, `result-auditor.md`                                                                                             |
| `docs/roles.md`                        | The worker role model: default roles and models, config, pair mode, security and QA, report formats, the pilot protocol                                                                                        |
| `docs/decider.md`                      | The decider contract: the checked API shape, the config, the exit codes and the privacy gate; the endpoint is alpha                                                                                            |
| `docs/vault.md`                        | The agent vault: note types (with `spec` and `idea`), the `work/` and `config/` folders, repo modes, the CLI contract and exit codes, who may write, sync and conflicts, Graphify, non-goals                   |
| `docs/architecture.md`                 | Architecture diagrams: components and data flow, with built and planned parts, and one request in order                                                                                                        |

Targets `@earendil-works/pi-coding-agent >=1.3.0`. Extensions load through jiti, so there's no build step.

## Settled decisions

- Phased delivery. Phase 1 is a Pi extension, and it's built. Phase 2 is a standalone worker so no Pi window has to stay open. Start Phase 2 only after Phase 1 is proven on the Mac, and confirm its scope with the user first.
- Isolation uses file-overlap scheduling in one shared checkout, not a git worktree per task.
- Workers run with `PI_PLAN_DISPATCH_WORKER=1` and must never start their own watcher.
- Pi exits 0 on errors like "No API key found", so a worker with no assistant output counts as failed. Keep that check.
- The user approves the plan in the main session. Sonnet is the orchestrator, so there is no approval round trip through another model; it shows the plan where the user can ask for changes. Every draft, round 1 and fix rounds, is a `.plans/inbox/<id>.md.draft` file with `status: draft`; the dispatcher reads only `*.md`, so only a flipped plan is picked up. The user is the last gate in pilot mode: the `.plans/config.json` key `autoReady` is false by default, and the orchestrator never enables it.
- Plan audit replaces result audit. Opus 5.5 runs as the read-only `plan-auditor` subagent before a plan is flipped to ready: it reviews the plan against the spec and the repo, returns severity-tagged findings and logs `plan.audit` itself. Verdict `pass` means zero blockers and zero majors; minors are notes. At most 3 audit rounds, then the orchestrator stops and asks the user. Opus never audits worker results.
- Decision models (proof of concept). A hosted decider (`dispatch-plan/decide.mjs`, the OpenRouter Decisions API behind a backend adapter) suggests a thinking level per task, which the orchestrator applies in the plan, and scores plan-audit findings into an advisory proposal (`approve`, `hold`, `dismiss` or `fix`).
  Shadow only: it never replaces the user's yes and never flips a plan. Only `full` repos send text, the key is in a 0600 file and never in a worker's environment, and both modes are `off` until the user sets `decider` in `.plans/config.json`, which the orchestrator never edits.
  A decider failure never blocks a plan.
- Fix rounds stop after 3 fix rounds, so the last plan id ends in `-r4`, or when the same finding repeats. The orchestrator logs `loop.stop` with the reason and reports the open findings. A failing gate goes back to planning with the evidence, never forward to a review.
- The gate is necessary, not sufficient. It passes only when every task is done and there are zero error faults; a dry run never passes. The plan audit checks the plan before it runs; the gate, the `verify:` commands, the live guards and pair review check the result.
- The orchestrator writes only under `.plans/` (specs, inbox, done, traces) and to the vault through `vault.mjs`. It never edits source and never commits to a project repo, and besides the plan audit it spawns no other agent. In the vault it never writes `work/` or `config/` by hand; only `work add` and `config push` do. `vault.mjs sync push` commits to the vault repo only (A1).
- Work in the vault. Specs, plans and ideas are mirrored into the vault at the milestones of the vault rules (`spec`, `plan` and `idea` notes), and the local files under `.plans/` stay the working copies. `work add` copies the record of a run, a `full` repo only, and never the prompts or the Pi sessions. `restore` rebuilds the drafts on a new machine and never writes a ready plan. The copy fails closed: a file holding a secret, a `none` repo name or non-text content is not copied, `work add` exits `6` and the run note records it. The canonical copy of the dispatcher config is `config/dispatch.json`. The plan queue and in-flight resume are still Phase 2.
- The vault is a separate git repo, cloned next to the harness, and the only memory that crosses machines. Its `sync_push` key in `harness.json` is `auto` or `manual` (A2): `auto` pushes at the end of a request, `manual` leaves the push to the user. A new machine runs the vault's `bootstrap.sh`, which clones the harness and runs `vault setup`.
- `graphify-out/` is appended to a project repo's `.git/info/exclude` before the first Graphify run (A3), so the dispatcher's snapshots do not see it. Graphify is used only in `full` repos, and its report becomes a `codebase` note through the CLI.
- Workers have no vault access (A5). The dispatcher removes `AGENT_VAULT` and sets `PI_PLAN_DISPATCH_WORKER=1` for workers and `verify:` commands, passes the vault realpath to the guard in `PI_PLAN_DISPATCH_VAULT`, and preflight rejects a `files:` entry that leaves the repo through a symlink. A worker's shell can still reach any path the OS allows; the sync staging rule and the range lint are the backstop.
- Obsolete artifacts are archived, not deleted. The superseded `planner` and `auditor` agents and the old Haiku interface rules live in `dispatch-plan/archive/` with a header note saying they are not installed; the active agents folder holds only `plan-auditor.md`.
- Traces are local files, `.plans/traces/<trace>.jsonl`. OpenTelemetry export is deferred.
- Workers' claims are not trusted. The dispatcher, not the worker, runs a task's or the plan's `verify:` command with `sh -c` in the repo root. Exit 0 verifies the attempt; a failure or timeout retries the task with the output as feedback, or fails it, and a failing plan-level check fails the gate. Verification runs one at a time through a shared lock.
- Actions are blocked live inside workers (G2). A `tool_call` handler built from `PI_PLAN_DISPATCH_GUARD` limits edit-like tools to the task's `files:` and always denies paths outside the repo, under `.git/` or under `.plans/`, and blocks destructive shell commands (`git commit|push|reset --hard|clean|checkout --|stash|rebase|merge|tag|branch -D`, `rm -rf`/`rm -fr`, `npm publish`, `gh pr create|merge`, `sudo`, downloads piped into a shell). A blocked call starts with `BLOCKED by pi-plan-dispatch:` and the dispatcher counts it as a `blocked_action` warning. Shell writes (redirects, `sed -i`, `tee`) cannot be blocked reliably; the git evidence and gate catch them.
- Plans are preflighted before any worker starts (G4). Absolute or `..` `files:` entries, entries under `.git/` or `.plans/`, more than `maxFilesPerTask` files, a body over `maxTaskChars`, or an unknown `verify:` executable reject the plan to `.plans/failed/` with an `.error.md` and a `plan.rejected` event.
- Editing a file that existed before the plan without reading it first raises an `edit_unread_file` warning (G3). New files are exempt.
- Roles are config-based. Plans name a role (`implement` by default), never a model; `.plans/config.json` maps each role to a model, thinking level, read-only flag and prompt. Resolution is task `model:`/`thinking:` line, then the task's role, then the plan frontmatter, then the config defaults. An empty thinking level passes no `--thinking` flag. A user config entry overrides only the fields it sets.
- Pair mode is review before done. After an implementer task succeeds and its `verify:` passes, its `pair:` role runs as a read-only reviewer. `approve` ends the task; `changes` re-runs the implementer with the findings, counted on a separate `pairRound` so `retries` are not consumed. When rounds (1-3, default 2) or `maxRunsPerTask` (default 8, implementer plus reviewer runs) run out with findings open, the task stays done and `pair_unresolved` records them for the orchestrator's report. A reviewer crash or an unparseable report is `review_unparsed`, never a task failure. The whole loop is inside the task's lifecycle, so dependents wait. Dry runs skip it.
- Security findings feed the gate by severity: `security_finding` is an error for high, a warning for medium and info for low, and an unlabelled finding counts as medium. Read-only tasks change nothing by design, so the implementer report checks do not apply; a read-only task that edits anything raises a `readonly_violation` error. `role: qa` is an ordinary implementer task with the QA model and prompt.
- Resilience (Phase 2 stage 1a). A transient error (a provider or network drop, not `verification failed`, a timeout, a bad key or `aborted`) backs off on `backoffSeconds` and resumes the same Pi session, outside `retries` and `maxRunsPerTask`; real failures take the old path unchanged. The first transient error also opens a plan-level outage pause that blocks new tasks and every resume until a probe of `probeUrls` answers, giving up after `outagePauseMinutes` and logging `outage.start` and `outage.end`. A stall watchdog kills a worker that prints nothing for `stallMinutes` (3, `0` off) but never one with a tool call in flight, and its `stalled: no output` error is transient. Reviewers resume the same way. Known limit: the probe uses plain `fetch`, so an outage that only takes a local proxy down can close the gate early, and the resumes then use their own `transientRetries` limit.

## Traceability

One trace is one user request across all rounds. Plans link through frontmatter: `trace:` is shared by every plan of the request (defaults to the plan id), `parent:` names the previous plan on a fix round, `round:` counts from 1. Plan ids are `<trace>-r1`, `<trace>-r2`, and so on.

- Events: `.plans/traces/<trace>.jsonl`, one JSON line per event, actors `sonnet-orchestrator`, `opus-plan-auditor`, `pi-dispatch`, `worker`, `vault`, `user`. `task.start` carries the task's `role`; `task.review` records a pair or security review (`round`, `reviewer_role`, `model`, `verdict`, `findings`, `cost`, `tokens`, `session_id`).
- The orchestrator writes `spec.confirmed`, `plan.drafted`, `plan.approved` and `loop.stop`; the `plan-auditor` writes `plan.audit` (`verdict`, `audit_round`, `blockers`, `majors`, `minors`, `summary`), and nobody else does; the extension writes the rest. The event-level `round` is always the plan round, and the audit counter lives in `audit_round`. `audit.verdict` is legacy: the result audit it recorded no longer exists, so nothing writes it, but the report still renders old traces.
- Per plan results: `.plans/done/<plan>/` holds `plan.md`, `_summary.md` (gate line and fault list), one `<task>.md` report and one `<task>.prompt.md` per task that started (a skipped task has a report but no prompt file), a `<task>.verify.md` and/or `plan.verify.md` when a `verify:` command ran, and `evidence.json` (changed files, faults, gate, plus `pairs` and `reviews`).
- Three evidence sources, in decreasing trust: Pi's tool-call stream (which tool edited which path, per task), the git snapshot before and after the plan (what actually changed, per plan), and the worker's own report.

`trace.mjs report --trace <T>` renders the timeline to stdout and `.plans/traces/<T>.md`, including a **Plan audit** table (round, verdict, blockers, majors, minors) and a **Models** table (model, roles, tasks, reviews, tokens, cost, error and warn faults) built from `task.start`, `task.end`, `task.review` and `fault` events; the orchestrator quotes its headline in the final report.

## Status (Phase 1)

- **The agent vault is built:** the CLI (`dispatch-plan/vault.mjs` with the `work`, `restore` and `config` modules beside it), the note schema and repo modes (`pi-plan-dispatch/vault/`), the seed (`vault-template/`), the `vault.*` trace events and the worker isolation are in place and covered by tests. See [docs/vault.md](docs/vault.md).
- **The vault work rules are built and tested:** the `spec` and `idea` note types, the `work/` and `config/` folders, `work add`, `work pending`, `restore`, `config push`, `config pull`, the boot sections `unfinished requests`, `open ideas` and `recent runs`, exit code `6` and the fail-closed copy, and the vault blocks of the orchestrator rules.
- **Verified in a Linux sandbox:** strict `tsc`, the core unit tests with a fake `pi`, and live TUI tests in tmux.
- **Tested against real Pi for the tool stream and the live guard:** a real worker run in the audit verified the `tool_execution_*` event names against Pi's actual JSON stream, and the live guard works end to end in a real worker. The tracing, fault detection and gate code is otherwise covered by unit and integration tests with a mocked Pi API and a fake worker.
- **Written, not yet used end to end:** the `plan-auditor` agent, the orchestrator rules block and the updated skill.
- **Not verified yet:**
  - a real DeepSeek/OpenCode Go run
  - macOS `fs.watch` behaviour
  - the agents and skill driven by real Claude Code
  - LSP extensions reaching workers
  - real cost reporting
  - a real worker run with the worker isolation
  - the new vault commands (`work add`, `work pending`, `restore`, `config push`, `config pull`) against the real vault
- **Suggested next step:** refresh the installed copies (`mkdir -p ~/.claude/skills/dispatch-plan && cp dispatch-plan/SKILL.md dispatch-plan/ORCHESTRATOR.md dispatch-plan/trace.mjs dispatch-plan/preflight.mjs dispatch-plan/config-init.mjs dispatch-plan/vault.mjs dispatch-plan/vault-work.mjs dispatch-plan/vault-restore.mjs dispatch-plan/vault-config.mjs dispatch-plan/decide.mjs dispatch-plan/decide-core.mjs dispatch-plan/decide-backend.mjs dispatch-plan/decide-stats.mjs ~/.claude/skills/dispatch-plan/` and `mkdir -p ~/.claude/agents && cp dispatch-plan/agents/plan-auditor.md ~/.claude/agents/`; anyone who installed an earlier version also runs `rm -f ~/.claude/agents/planner.md ~/.claude/agents/auditor.md`; `node dispatch-plan/vault.mjs setup --force` writes every file of `dispatch-plan/` and the agents for you), paste the block from `dispatch-plan/ORCHESTRATOR.md` into `CLAUDE.md`, install the extension, and log Pi into OpenCode Go. Run a tiny plan with `/plans dry on`, then one small real task with `/plans dry off`.

## Open questions

- Phase 2 scope, including the agent-vault plan queue: plans as vault notes with a claim state machine and a vault watch, designed against the standalone runner.
- Pair mode is a hypothesis. No measurements exist yet: run the same tasks solo and as pairs and compare worker cost, gate pass rate, rounds to pass and faults per model with the Models table of `trace.mjs report` (see `docs/roles.md`).
- Parallel best-of-two (run two implementers on one task and keep the better result) needs git worktrees or another isolation scheme; the shared checkout cannot host it.
- Live agent-to-agent conversation between the orchestrator and the Pi workers needs an RPC or message channel; today the hand-off is files only.
- No fallback model when a provider fails: moving a role is a manual config edit, which matters when a free model's period ends. A transient failure now resumes the same session and an outage pauses the plan, but a provider that is down for longer than `outagePauseMinutes`, or one that answers with a permanent error, still fails the tasks it touches.
- Crash resume of a whole plan (Pi restarted or killed mid-run) is the next spec of this stage; today only a single worker run is resumed, and a plan left in `running/` has to be re-dropped to rerun.
- ~~Whether the gstack and pstack architecture skills should be preloaded into the plan reviewer.~~ Resolved: the `plan-auditor` preloads `codebase-design`, `domain-modeling` and `tdd` through its `skills:` list.
- Per-task git worktrees for parallel tasks, as a Phase 2 candidate against the shared-checkout rule.
- OpenTelemetry export of the trace events.
- An `agent:` per-task field to map tasks to the `dev-fe`, `dev-be` and `qa` Pi agents.
- Optional: install a community orchestration skill (`claude-pi`, `pi-cc-plugin`) after reading its source.
- ~~How to set up the OpenCode Go key in Pi.~~ Resolved: pi has a built-in `opencode-go` provider; key lives in `~/.pi/agent/auth.json`, models smoke-tested. See [docs/pi-migration.md](docs/pi-migration.md).
- Whether other OpenCode Go models should also serve as workers.
