# The agent vault

The agent vault is the harness memory: one Obsidian vault, in its own git repo, holding notes that outlive one repository and one machine. It is the only memory the agents keep outside `.plans/`, and the only files they share across checkouts.

The orchestrator is the only role that writes it, and only through `dispatch-plan/vault.mjs`. The `plan-auditor` runs `vault.mjs boot` and reads. Pi workers have no vault access at all. The write rules for each role live in `dispatch-plan/ORCHESTRATOR.md` (marker `## Vault rules (agent-vault)`) and in `dispatch-plan/agents/plan-auditor.md`.

## Why a vault

- **Portable memory.** A repo's `.plans/` dies with the checkout. The vault holds what outlives one request: decisions, lessons, open findings, a project's shape and a log of what happened on which machine.
- **A git repo of its own.** The vault is a separate private repo, cloned next to the harness (default `~/Documents/repos/agent-vault`). A new machine clones it and the agents resume with the same context.
- **Notes and the run record.** The vault holds Markdown notes, the log, the generated index, `repos.json`, `harness.json`, the run record under `work/` (summaries, evidence, worker reports and traces) and the dispatcher config. Still no source, no prompts, no Pi sessions, no credentials.
- **One write path.** Every agent write goes through the CLI, which enforces the schema, the per-repo privacy allowlist, the vault lock and the sync rules, and emits trace events.

The implementation is `pi-plan-dispatch/vault/` (schema, privacy, notes, git, lock). The CLIs are `dispatch-plan/vault.mjs`, `dispatch-plan/vault-admin.mjs`, `dispatch-plan/vault-work.mjs`, `dispatch-plan/vault-restore.mjs` and `dispatch-plan/vault-config.mjs`, plain Node with no dependencies.

## Layout

| Path | What it is |
|---|---|
| `plans/`, `runs/`, `findings/`, `decisions/`, `lessons/`, `projects/`, `codebases/`, `specs/`, `ideas/` | One folder per note type |
| `work/`, `config/` | Not note folders: the copied run record per request, and the dispatcher config |
| `log.md` | Append-only log, one line per entry |
| `index.md` | Generated list of every note; gitignored |
| `repos.json` | Per-repo modes, plus host aliases |
| `harness.json` | `schema`, `boot_budget_tokens`, `min_node`, `sync_push` |
| `CLAUDE.md`, `README.md`, `bootstrap.sh` | Vault instructions and the new-machine entry point |
| `templates/` | Note templates and Obsidian Bases views |
| `.gitattributes` | `log.md merge=union` and `work/**/*.jsonl merge=union` |

`vault init` (that is, `vault.mjs init`) copies this layout from `vault-template/` into a new folder, runs `git init -b main`, commits, and adds `origin` when `--remote` is given.

## Note types

Every note is a Markdown file with YAML frontmatter and a slug basename: lowercase words joined by single dashes, at most 60 characters per slug part. All notes carry `type`, `created` and `updated`.

| Type | Folder | Basename | Extra required properties |
|---|---|---|---|
| `plan` | `plans/` | `<slug(plan id)>` | `trace`, `round`, `repo`, `status` |
| `run` | `runs/` | `<slug(plan id)>-run` | `trace`, `repo`, `status`, `gate`, optional `plan` |
| `finding` | `findings/` | `<trace>-f-<8 hex>` | `trace`, `repo`, `severity`, `fingerprint`, `source`, `status` |
| `decision` | `decisions/` | `decision-<slug(project)>-<slug(title)>` | `project`, `repo` |
| `lesson` | `lessons/` | `lesson-<slug(project)>-<slug(title)>` | `project`, `repo` |
| `project` | `projects/` | `project-<slug(name)>` | `repos` (a list) |
| `codebase` | `codebases/` | `codebase-<slug(owner)>-<slug(name)>` | `repo`, `commit`, `graphify_version` |
| `spec` | `specs/` | `<slug(spec id)>-spec` | `trace`, `repo`, `status`, `file` |
| `idea` | `ideas/` | `idea-<slug(title)>` | `status`, `repo` |

A `plan` note also takes optional `file` (a plain `.md` file name), `audit` (`pass` or `fail`), `audit_round` (a whole number from 1) and `host`; a `spec` note takes optional `host`. Plan notes are written as drafts and updated at each milestone.

A finding's 8 hex characters are the first 8 of the sha1 of its `fingerprint`; the CLI checks that they match. The vocabulary is fixed:

| Property | Allowed values |
|---|---|
| plan `status` | `draft`, `ready`, `done`, `failed` |
| run `status` | `done`, `failed` |
| spec `status` | `draft`, `confirmed`, `done` |
| idea `status` | `open`, `taken`, `dropped` |
| plan `audit` | `pass`, `fail` |
| plan `audit_round` | a whole number from 1 |
| run `gate` | `pass`, `fail` |
| finding `status` | `open`, `closed` |
| finding `severity` | `blocker`, `major`, `minor`, `error`, `warn`, `info` |
| finding `source` | `plan-audit`, `auditor`, `pair`, `security`, `gate` |

A note's `repo` is a slug like `github.com/owner/name`, built from the repo's `origin` URL; `-` is allowed only on `decision`, `lesson` and `idea` (a general idea, held to the `meta` body rules).

## Repo modes

`repos.json` maps each repo slug to a mode. A repo that is not listed, or `repos.json` being unreadable, counts as `none`.

| Mode | Allows |
|---|---|
| `none` | Nothing, and the slug may not appear anywhere in the vault |
| `meta` | `run`, `decision`, `lesson` and `idea` notes only; a run body is generated from its fields, the other bodies carry no fenced code and no tracked file names |
| `full` | Every note type, `spec` and `plan` included |

`vault.mjs repo allow <slug-or-uri> --mode <full\|meta\|none>` is the only way to change a mode. It accepts a slug or an origin URL, and applies the `aliases` map to host names. `repo list` prints `<slug>\t<mode>`; `repo check` prints the current checkout's mode and exits 3 when it is `none`.

## The CLI contract

```
node ~/.claude/skills/dispatch-plan/vault.mjs <command> [arguments] [flags]
```

| Command | What it does | Writes |
|---|---|---|
| `resolve` | Prints the vault path, host and remote | |
| `boot [--repo <slug>] [--budget <tokens>]` | Prints the text an agent boots with | |
| `lint [--range]` | Checks the vault; exit 1 on any error | |
| `stats [--repo <slug> \| --all]` | Note counts, boot tokens, finding repeat rate and the `work:` size line | |
| `note new <type> <basename> [--set k=v]... [--body-stdin]` | Creates a note | yes |
| `note set <basename> [--set k=v]... [--body-stdin]` | Merges properties, or replaces the body | yes |
| `note status <basename> <open\|closed\|taken\|dropped>` | Sets a finding's status (open, closed) or an idea's (open, taken, dropped) | yes |
| `note rm <basename>` | Removes a note | yes |
| `log append --repo <slug\|-> [--trace <id>] <text...>` | Appends one log line | yes |
| `index rebuild` | Rewrites `index.md` | yes |
| `repo allow <slug-or-uri> --mode <mode>` | Sets a repo's mode | yes |
| `repo list`, `repo check` | Reads the modes | |
| `sync pull` | Pulls with rebase and autostash, then rebuilds the index | yes |
| `sync push [--summary <text>]` | Lints, commits the managed files, pulls and pushes | yes |
| `work add --trace <id> --root <repo> [--probes]` | Copies a finished request into `work/<trace>/` | yes |
| `work pending --root <repo>` | Lists finished requests the vault misses or holds an older copy of | |
| `restore --root <repo>` | Rebuilds the repo's specs and draft plans from the vault | |
| `config push --root <repo>` | Copies `.plans/config.json` into the vault | yes |
| `config pull --root <repo> [--force]` | Writes `.plans/config.json` from the vault | |
| `init [--path <dir>] [--remote <url>]` | Creates a vault from the template | |
| `setup [--path <dir>] [--force]` | Writes the config, creates the new folders, installs the skill and agents, pulls the dispatcher config, rebuilds the index, runs `doctor` | |
| `doctor` | Checks the machine and the vault; exit 0 only when every required check passes | |

Flags accepted anywhere: `--vault <path>`, `--trace <id>`, `--root <repo>`, `--json`. A missing `--vault` falls back to discovery, below.

Exit codes:

| Code | Meaning |
|---|---|
| 0 | Done |
| 1 | Failure: lint errors, no remote, missing config, an unfinished request (`work add`), a missing local config (`config push`), or a failed `doctor` check |
| 2 | Rejected: schema or privacy violation, bad argument, a worker calling the CLI, a newer vault schema, or a rebase in progress |
| 3 | The repo's mode is `none` (`repo check`, and `work add` for a `none` or unlisted repo) |
| 4 | The vault is locked by another writer |
| 5 | Sync conflict or a rejected push; the tree is left as it was |
| 6 | Partial: `work add` copied the rest but some files were unmirrored |
| 64 | Usage error: unknown command, unknown flag, or a wrong argument count |

`boot` prints `CLAUDE.md` first, then the project note, the repo's open findings, three sections (`=== unfinished requests ===`, one line per `spec` note of the repo with status `draft` or `confirmed` as `<spec> | plan <basename> <status> audit <verdict> round <n> | host <host>`, or `no plan yet`; `=== open ideas ===`, the basenames of the open ideas of the repo and the general ones; `=== recent runs ===`, the last 3 runs as `<basename> | <gate> | <updated>`), with an empty section left out, the last 20 log lines and the generated index, all inside the token budget (`harness.json` `boot_budget_tokens`, default 4000, about 4 characters per token). `CLAUDE.md` is outside the budget; the rest is dropped from the end and the text ends with `[truncated: <n> items]`. `stats` reports the boot size, so the budget can be seen before it is hit.

Write commands take a lock file in the vault's `.git/` (`agent-vault.lock`) so two writers never interleave; a busy lock is exit 4. The lock's wait time can be raised with `AGENT_VAULT_LOCK_WAIT_MS`.

Among the new commands only `work add` and `config push` write the vault, so only they take the lock, refuse during a rebase and on a newer schema, and check that the target stays inside the vault. `work pending`, `restore` and `config pull` only read the vault and write under the repo's `.plans/`, so they take no lock.

### Discovery

The vault path is `$AGENT_VAULT` when it is set and non-empty, otherwise the `path` in `~/.config/agent-vault/config.json`. `vault.mjs resolve` prints what was picked.

The CLI's `findVault` (`pi-plan-dispatch/vault/notes.ts`) does not check that the folder exists. The dispatcher's `findVaultPath` (`pi-plan-dispatch/core.ts`) requires an existing directory and returns its realpath, and falls back to `AGENT_VAULT`-less discovery when it is missing. So an `AGENT_VAULT` that names a missing folder makes the two pick different vaults: the CLI talks to that path, the dispatcher guards the configured one.

## The run record

`work add --trace <T> --root <repo root> [--probes]` copies the record of a finished request into `work/<T>/`. It is for a `full` repo only, and it is idempotent: a file with identical content is skipped and a changed file is replaced.

- `trace.jsonl` is the local trace without the lines whose actor is `vault`. `work add` appends its own `vault.work` event to the local trace after the copy, so a copy that kept those lines would never equal the local file. Every other line stays as it was.
- `trace.md` is the rendered report.
- `<plan-id>/` holds every file of that plan's folder in `.plans/done/<plan-id>/` or `.plans/failed/<plan-id>/`, except `plan.md` and every `*.prompt.md`: in practice `_summary.md`, `evidence.json`, `plan.verify.md` when a plan-level check ran, one `<task>.md` report per task and `<task>.verify.md` when a task check ran.
- `probes/` holds the request's files from `.plans/tools/` (names `probe-*`, `ref-*`, `make-ref-*` and `probes.sha256`, plus the files of a `ref-*` folder), only when `--probes` is given.

`work add` reads only `.plans/traces/`, `.plans/done/<plan-id>/`, `.plans/failed/<plan-id>/` and, with `--probes`, `.plans/tools/`. Prompts, `plan.md`, Pi sessions and everything else under `.plans/` never enter the vault.

The copy fails closed. Every file is read as UTF-8 text and checked for secret patterns and for the name of a `none` repo before it is copied. A file that fails is not copied; `work add` prints `unmirrored <path>: <reason>` for it, copies the rest and exits 6. The reasons are `not UTF-8 text`, `secret pattern: <names>`, `names a repo that is not allowed`, `outside the vault` and `bad plan id`; the last one names the plan id instead of a path. The relative paths that did not make it are recorded in the `unmirrored` property of the trace's `run` notes, and the property is dropped again when nothing is unmirrored. There is no automatic redaction.

A `meta` repo copies nothing, prints `work add: a meta repo copies no work files` and exits 0. A `none` or unlisted repo exits 3. A trace file that is missing or has no `plan.end` event was not finished and exits 1.

`work pending --root <repo root>` prints one line `pending <trace>` per finished request whose `work/<trace>/trace.jsonl` is missing from the vault or differs from the local file, compared after the same drop of `vault` lines. It writes nothing, and for a repo that is not `full` it prints nothing.

One case to know: when a trace's report has a `vault.denied` row, `trace.md` names the `none` repo. That file is not copied and is listed as unmirrored, while `trace.jsonl` and the rest are copied, because the `vault` lines are dropped from it. So `work add` exits 6 every time it runs on that trace, and `work pending` does not list that trace again.

## Restore and config

`restore --root <repo root>` rebuilds the working files of a `full` repo from the vault; another mode prints nothing and exits 0.

- Each `spec` note of the repo with status `draft` or `confirmed` and a `file` property is written to `.plans/specs/<file>` when that file does not exist.
- Each `plan` note of the repo with status `draft` or `ready` and a `file` property is written to `.plans/inbox/<file>.draft` when none of `.plans/inbox/<file>`, `.plans/inbox/<file>.draft`, `.plans/running/<file>`, `.plans/failed/<file>` or `.plans/done/<plan id>/plan.md` exists. The text is the note body with the frontmatter `status:` line set to `draft`, the one place restore edits text, so a restored plan needs a new audit and approval.
- It prints `restored <path>` or `skipped <path>: <reason>` per item, then the open ideas of the repo (`idea <basename>`) and the last 3 run digests (`run <basename> | <gate> | <updated>`).
- It never overwrites an existing file, never writes a plan without `.draft`, never writes a file name with a path separator or `..`, and never resumes a run. Its writes stay under `<root>/.plans/`, and a `--root` without that folder is exit 1.

`config push --root <repo root>` copies `.plans/config.json` to `config/dispatch.json` after checking that it is a JSON object, that no secret pattern matches and that it names no `none` repo. It prints `config push: pushed` or `config push: unchanged`. A missing local file is exit 1; invalid JSON, a secret or a `none` repo name is exit 2. The file is not a note, so the per-type mode rules do not gate it; the secret scan and the `none` repo check do.

`config pull --root <repo root> [--force]` writes `.plans/config.json` from `config/dispatch.json` when the local file is missing and prints `config pull: pulled`. Without `--force` an existing local file is kept (`config pull: kept the local file (use --force to replace it)`); with it the file is replaced. No `config/dispatch.json` in the vault, or no `.plans` folder, is exit 1.

`vault setup` runs the pull for the repo it is started in, only when that repo has a `.plans` folder, and never replaces a local file. `doctor` prints the optional check `dispatch config`, which fails when the two files differ.

## Milestones

Spec, plan and idea notes are mirrors written at milestones by the orchestrator, for a `full` repo only:

| Milestone | Command |
|---|---|
| Spec confirmed | `note new spec <slug(spec id)>-spec --set trace=<T> --set repo=<slug> --set status=confirmed --set file=<spec file> --set host=<host> --body-stdin < .plans/specs/<spec file>` |
| Plan drafted or revised | `note new plan <slug(plan id)> --set trace=<T> --set round=<n> --set repo=<slug> --set status=draft --set file=<plan file without .draft> --set host=<host> --body-stdin < <plan draft path>` |
| Audit verdict | `note set <plan basename> --set audit=<pass\|fail> --set audit_round=<n>` |
| Approved and flipped | `note set <plan basename> --set status=ready` |
| Run finished | `work add --trace <T> --root <repo root>` (with `--probes` when probes were written), then `note set <plan basename> --set status=<done\|failed>`, and `note set <spec basename> --set status=done` when the request is finished |
| Idea stated | `note new idea idea-<slug(title)> --set status=open --set repo=<slug or -> --body-stdin` |

Every vault command run for a request carries `--trace <T> --root <repo root>`: the CLI writes its `vault.*` events only when it gets both flags. The commands above leave them out for brevity.

`note new` is an upsert that rebuilds the note from its own `--set` flags and body only. It keeps the stored `created`, sets `updated`, and drops every property not passed in `--set`. A revised plan draft is therefore written with `note new plan` again, passing every property to keep, and the audit verdict is set again with `note set` after the next audit. `host` is the `host` printed by `vault.mjs resolve --json`.

After a run the order is fixed, because the wrong order loses data:

1. `trace.mjs report --trace <T>`, so `.plans/traces/<T>.md` exists before the copy.
2. The `run` note and the `finding` notes with `note new`: `work add` records `unmirrored` only on run notes that already exist, and a later `note new run` would drop the property.
3. `work add --trace <T> --root <repo root>`.
4. `note set` of the plan status, and of the spec status `done` when the request is finished.
5. `log append`.
6. `sync push` when `sync_push` is `auto`.

For a `meta` or `none` repo the specs and plans stay local.

## Who may write

- **The orchestrator** is the only writer, and only through `vault.mjs`. It mirrors the work at milestones: a `spec` note when the spec is confirmed, a `plan` note when a plan is drafted or revised, its audit verdict, its status when it is flipped to ready and again when the run ends, and an `idea` note when the user states one. The working copies stay in `.plans/specs/` and `.plans/inbox/`, and the note is a mirror, never the source the tools read. After a run it writes the `run` note, one `finding` per reviewer, pair, security, plan-audit or gate finding, `decision` and `lesson` notes only for durable facts, then `log append`. It never writes under `work/` or `config/` by hand: only `work add` and `config push` do.
- **The `plan-auditor`** is read-only. It runs `vault.mjs boot` and may read vault files, and it never runs `note`, `log`, `index`, `repo allow` or `sync`. That is a prompt rule: the CLI cannot tell the auditor from the orchestrator, because both carry the same user and the same environment. Only the role files draw this line.
- **Pi workers** get no access, enforced in four places:
  - The dispatcher builds every worker's environment with `workerEnv` (`pi-plan-dispatch/core.ts`): it sets `PI_PLAN_DISPATCH_WORKER=1` and deletes `AGENT_VAULT`, so a worker never inherits the parent's, then passes the vault realpath in `PI_PLAN_DISPATCH_VAULT`. `verify:` commands get `PI_PLAN_DISPATCH_WORKER=1` and no `AGENT_VAULT` too (`pi-plan-dispatch/verify.ts`), because they run the same repo's tooling.
  - The vault CLI refuses every command when `PI_PLAN_DISPATCH_WORKER=1`, with exit 2, whichever vault it would have used.
  - The live guard (`pi-plan-dispatch/guard.ts`) reads the vault path from `PI_PLAN_DISPATCH_VAULT` and refuses any tool call whose path argument resolves, through symlinks, to the vault or something inside it. Read, grep and ls are refused as well as edits, and the vault deny applies even when `workerGuards` is off.
  - Preflight rejects a plan whose `files:` entry leaves the repo through a symlink, which closes that route to the vault.
- **Known limit.** A worker's shell can still reach any path the OS allows. The guard sees the command, not what it writes, and the git snapshot covers only the checkout. The backstops are the staging rule (`sync push` commits only managed files) and the range lint (`sync push` scans the commits for secrets).

## Sync and conflicts

`sync pull` fetches and runs `git pull --rebase --autostash`, then rebuilds `index.md`. If the pull leaves a rebase, unmerged paths or a changed stash, it aborts the rebase or resets to the previous HEAD and restores the stash, then exits 5 with the tree as it was. No remote is exit 1; no upstream branch pulls `origin <branch>` directly.

`sync push`:

1. Runs `lint --range`, which also scans the commits since `origin/<branch>`. Any error stops the push with exit 1 and nothing is committed.
2. Stages only managed files: the root files the template ships (`log.md`, `repos.json`, `harness.json`, `CLAUDE.md`, `README.md`, `bootstrap.sh`, `.gitattributes`, `.gitignore`), every `.md` and `.gitkeep` in a note folder, every file under `work/` at any depth, `config/dispatch.json` and `config/.gitkeep`, and everything in `templates/`. Other changed paths are printed as `unmanaged change: <file>` and left alone.
3. Commits as `vault: <summary|update> [trace <id>]`, using `agent-vault <agent-vault@localhost>` when git has no user email.
4. Pulls, then pushes; when the branch has no upstream it pushes with `-u origin HEAD`. A non-fast-forward rejection is retried once after another pull, then exit 5.

`log.md` carries `merge=union` in `.gitattributes`, so two machines appending log lines merge without a conflict. `work/**/*.jsonl` merges by union too, so a trace copy is appended to rather than conflicted. Every other file is last writer wins, which is why writes are short and happen after a run.

Whether the orchestrator pushes at the end of a request is the `sync_push` key in the vault's `harness.json`: `auto` means it runs `sync push`, `manual` means it commits nothing and tells the user a push is due. The vault is not the place to resolve a conflict by hand: pull first, then rewrite the note through the CLI.

## A new machine

1. Install Node 24 or newer and git.
2. Clone the vault repo next to the harness, so the vault's `bootstrap.sh` sits at `<parent>/agent-vault`.
3. Run `./bootstrap.sh` from the vault. It reads `min_node` and `harness_repo` from `harness.json`, clones the harness into the sibling `pi-plan-dispatch-phase1` when that is missing, and runs `vault setup` (`vault.mjs setup --path <vault>`).
4. `vault setup` writes `~/.config/agent-vault/config.json` (`path`, `remote`, `host`), creates the `specs/`, `ideas/`, `work/` and `config/` folders and the `work/**/*.jsonl merge=union` line in `.gitattributes` when they are missing, installs the skill files into `~/.claude/skills/dispatch-plan/` and the agents into `~/.claude/agents/`, runs `config pull` in the repo it started in when that repo has a `.plans` folder (which only writes a missing `.plans/config.json`), rebuilds `index.md`, then runs `doctor`. A file that was changed locally or never recorded is kept and reported as `kept (modified)`; `--force` replaces it.
5. `vault doctor` prints `ok` or `fail` per check with the exact fix command: Node version, git, a vault git repo the CLI's schema supports, a reachable `origin`, an upstream branch, installed files that match the harness, `pi`, the extension registered in `~/.pi/agent/settings.json`, `opencode-go` credentials, and at least one repo in `repos.json`. Graphify, the Obsidian skills plugin, `note types` (a note type the installed CLI does not know) and `dispatch config` (the local `.plans/config.json` against the vault copy) are optional checks.

All machines update the harness together: the vault schema stays 1, but an older CLI cannot read a vault written by this version. `doctor` warns when the vault holds a note type the installed CLI does not know.

On the first machine, `vault init` creates the vault from `vault-template/` and prints the next steps: create the private remote, `git push -u origin HEAD`, then run `bootstrap.sh` on the other machines. `vault setup` never edits `~/.pi/agent/settings.json` and never touches credentials.

## Obsidian skills

The role file names both skills: use `obsidian-markdown` whenever the orchestrator writes or edits note text itself (properties, wikilinks, callouts, embeds), and `obsidian-bases` when it writes or edits a `.base` view in `templates/`. The CLI is still the write path. The `obsidian-cli`, `json-canvas` and `defuddle` skills are not required, and no Obsidian app has to be running.

Install them in Claude Code with `/plugin marketplace add kepano/obsidian-skills` and `/plugin install obsidian@obsidian-skills`. Doctor reports the plugin as an optional check.

## Graphify

Graphify (`Graphify-Labs/graphify`, PyPI `graphifyy`, CLI `graphify`) explores a codebase, and the orchestrator distils `graphify-out/GRAPH_REPORT.md` into a `codebase` note through the CLI. It is used only in repos whose mode is `full`.

`graphify-out/` never enters the vault. Before the first run in a repo, append `graphify-out/` to that repo's `.git/info/exclude`, so the dispatcher's snapshots do not see it as an unowned change. Never run `graphify install --project` or `graphify hook install` in a project repo: they write instruction files and git hooks into it.

## Privacy and lint

The allowlist is only as good as the text that goes in. Do not put the slug or the `owner/name` of a `none` repo into a note, a log line or a commit summary. The CLI rejects such a write (`note`, `log append`, `sync push --summary`) and `lint` blocks the push.

`lint` findings:

| Severity | Code | Meaning |
|---|---|---|
| error | `secret` | A secret pattern matched in a note, in a file under `work/` or `config/`, or in the history `--range` scans |
| error | `none-repo-leak` | A file under `work/` or `config/` names a `none` repo |
| error | `work-binary` | A file under `work/` is not UTF-8 text |
| error | `absolute-path` | A note body or a property contains an absolute path; `spec` and `plan` bodies are exempt (D9) |
| error | (schema or privacy) | Invalid frontmatter, a missing property, or a note a `none` repo does not allow |
| error | `none-slug-in-log` | A log line names a `none` repo |
| info | `dangling-link` | A wikilink points at a note that does not exist |
| info | `orphan` | No other note links to this one |

No note schema or link check runs on `work/` and `config/`; the secret and `none` repo checks do.

## Trace events

With both `--root <repo>` and `--trace <T>` the CLI appends to the same `.plans/traces/<T>.jsonl` the dispatcher writes, as actor `vault`. A missing flag writes no event, and a failed append never fails the command.

| Kind | When | Data |
|---|---|---|
| `vault.boot` | `boot` | `bytes`, `items`, `truncated` |
| `vault.write` | A write command | `type`, `id`, `op` |
| `vault.sync` | `sync pull` or `sync push` | `op`, `result` |
| `vault.unavailable` | A command needs a vault that is not configured | `reason` |
| `vault.denied` | A write names a repo the mode does not allow | `repo`, `type` |
| `vault.work` | `work add` | `op`, `trace`, `files`, `unmirrored` |
| `vault.restore` | `restore` | `restored`, `skipped` |
| `vault.config` | `config push` or `config pull` | `op`, `result` |

`trace.mjs report` renders one line per event, for example `vault.write` as `new finding <basename>`.

## Non-goals and open ends

- No plan queue and no claiming of plans: plans still flow through `.plans/inbox/`, and the vault queue is deferred to Phase 2.
- No resuming an in-flight run on another machine, and no automatic redaction: a file that fails the copy is left out and reported, never cleaned.
- Prompts and Pi sessions are never copied, and the vault holds no source.
- No Graphify over the vault itself, no embeddings or RAG, no Obsidian plugin, no Obsidian CLI, no schema migrations.
- Graphify query logging, auto conflict resolution and credentials in the vault are all out of scope.
