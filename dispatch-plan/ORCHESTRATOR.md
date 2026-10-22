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

5. **Approval.** Pilot mode is the default: `.plans/config.json` key `autoReady` is false, and
   you never turn it on. Show the user the plan summary, the requirement-to-task trace from the
   audit, any minor notes, and ask for approval. Only after the user says yes, log
   `plan.approved` with data `{"approved_by": "user"}` and flip the draft to ready with this
   command, filling in the plan id:
   `sed -E '2,/^---$/ s/^status:[[:space:]]*draft([[:space:]]+#.*)?[[:space:]]*$/status: ready/' .plans/inbox/<id>.md.draft > .plans/inbox/.<id>.md.tmp && grep -q '^status: ready$' .plans/inbox/.<id>.md.tmp && mv .plans/inbox/.<id>.md.tmp .plans/inbox/<id>.md && rm .plans/inbox/<id>.md.draft`.
   If the user has set `autoReady` to true, a clean audit may flip the plan without asking,
   still logging `plan.approved` with `approved_by: "autoReady"`.

6. **Run.** Wait with `node ~/.claude/skills/dispatch-plan/trace.mjs wait --plan <id> --timeout 540`,
   run with the Bash tool timeout set to 600000 ms (the default 120000 ms would kill it early).
   Exit `0` means done. Exit `2` means the plan was rejected. Exit `3` means still running: call
   `wait` again. Exit `4` means it was never picked up, so Pi is probably not running: stop and
   tell the user to start Pi in the repo. Any other exit code means call `wait` again, at most 6
   calls in total for one plan; if the 6th call still exits `3`, stop and tell the user. If the
   error says a module or file was not found, stop at once and tell the user: the installed skill
   folder is stale. On exit `2`, read `.plans/failed/<id>.error.md`, rewrite
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
   `vault.mjs boot` and read the boot text before you plan. Otherwise skip every vault step for
   the whole request and say so once.

2. **Write after the run, never before.** A run includes a plan rejected before it ran. Write
   only through `vault.mjs`, never with an editor, and only what the repo mode allows. `full`
   allows everything. `meta` allows `run`, `decision` and `lesson` notes only, and the CLI builds
   the `run` body from `--set` fields, so never pass `--body-stdin` for a `meta` run. `none`
   allows nothing. The notes are: a `run` note for the plan; for a `full` repo a `plan` note
   holding the plan text; one `finding` note per reviewer, pair, security, plan-audit or gate
   finding, with `fingerprint` = `<repo slug>:<repo-relative file or ->:<slug(title)>`; and
   `decision` or `lesson` notes only for a fact that outlives the trace. Then `log append`.

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

8. **Plans stay in `.plans/`.** A plan is not stored in the vault before it runs; plans keep
   using `.plans/inbox/`. The vault gets the `plan` note after the run, in a `full` repo only.

9. **Never write the user's personal vault**, `obsidian-v2`, and no other vault but the agent one.

10. **Trace the vault calls.** Pass `--trace <T> --root <repo root>` to every vault command you
    run for a request, because the CLI writes its `vault.*` trace events only when it gets both
    flags. The session-start `sync pull` and `boot` have no trace yet and may omit them.

A finding basename is `<trace>-f-<8 hex>`, where the 8 hex are the first 8 characters of the
sha1 of the fingerprint. Compute it like this, with the fingerprint in single quotes:
`printf %s '<fingerprint>' | shasum | cut -c1-8`.
```
