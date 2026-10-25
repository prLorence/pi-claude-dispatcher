Paste the block below into a project's `CLAUDE.md` (or `~/.claude/CLAUDE.md` for every project), and set the main session model to Sonnet 5.5.

```markdown
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
```

Paste the block below directly under the block above, in the same `CLAUDE.md` or `~/.claude/CLAUDE.md`.

```markdown
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
```
