# The agent vault

The agent vault is the harness memory: one Obsidian vault, in its own git repo, holding notes that outlive one repository and one machine. It is the only memory the agents keep outside `.plans/`, and the only files they share across checkouts.

The orchestrator is the only role that writes it, and only through `dispatch-plan/vault.mjs`. The `plan-auditor` runs `vault.mjs boot` and reads. Pi workers have no vault access at all. The write rules for each role live in `dispatch-plan/ORCHESTRATOR.md` (marker `## Vault rules (agent-vault)`) and in `dispatch-plan/agents/plan-auditor.md`.

## Why a vault

- **Portable memory.** A repo's `.plans/` dies with the checkout. The vault holds what outlives one request: decisions, lessons, open findings, a project's shape and a log of what happened on which machine.
- **A git repo of its own.** The vault is a separate private repo, cloned next to the harness (default `~/Documents/repos/agent-vault`). A new machine clones it and the agents resume with the same context.
- **Notes only.** The vault holds Markdown notes, the log, the generated index, `repos.json` and `harness.json`. No source, no results, no traces, no credentials.
- **One write path.** Every agent write goes through the CLI, which enforces the schema, the per-repo privacy allowlist, the vault lock and the sync rules, and emits trace events.

The implementation is `pi-plan-dispatch/vault/` (schema, privacy, notes, git, lock). The CLIs are `dispatch-plan/vault.mjs` and `dispatch-plan/vault-admin.mjs`, plain Node with no dependencies.

## Layout

| Path | What it is |
|---|---|
| `plans/`, `runs/`, `findings/`, `decisions/`, `lessons/`, `projects/`, `codebases/` | One folder per note type |
| `log.md` | Append-only log, one line per entry |
| `index.md` | Generated list of every note; gitignored |
| `repos.json` | Per-repo modes, plus host aliases |
| `harness.json` | `schema`, `boot_budget_tokens`, `min_node`, `sync_push` |
| `CLAUDE.md`, `README.md`, `bootstrap.sh` | Vault instructions and the new-machine entry point |
| `templates/` | Note templates and Obsidian Bases views |
| `.gitattributes` | `log.md merge=union` |

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

A finding's 8 hex characters are the first 8 of the sha1 of its `fingerprint`; the CLI checks that they match. The vocabulary is fixed:

| Property | Allowed values |
|---|---|
| plan and run `status` | `done`, `failed` |
| run `gate` | `pass`, `fail` |
| finding `status` | `open`, `closed` |
| finding `severity` | `blocker`, `major`, `minor`, `error`, `warn`, `info` |
| finding `source` | `plan-audit`, `auditor`, `pair`, `security`, `gate` |

A note's `repo` is a slug like `github.com/owner/name`, built from the repo's `origin` URL; `-` is allowed only on `decision` and `lesson`.

## Repo modes

`repos.json` maps each repo slug to a mode. A repo that is not listed, or `repos.json` being unreadable, counts as `none`.

| Mode | Allows |
|---|---|
| `none` | Nothing, and the slug may not appear anywhere in the vault |
| `meta` | `run`, `decision` and `lesson` notes only; a run body is generated from its fields, with no fenced code and no tracked file names |
| `full` | Every note type |

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
| `stats [--repo <slug> \| --all]` | Note counts, boot tokens and finding repeat rate | |
| `note new <type> <basename> [--set k=v]... [--body-stdin]` | Creates a note | yes |
| `note set <basename> [--set k=v]... [--body-stdin]` | Merges properties, or replaces the body | yes |
| `note status <basename> <open\|closed>` | Opens or closes a finding | yes |
| `note rm <basename>` | Removes a note | yes |
| `log append --repo <slug\|-> [--trace <id>] <text...>` | Appends one log line | yes |
| `index rebuild` | Rewrites `index.md` | yes |
| `repo allow <slug-or-uri> --mode <mode>` | Sets a repo's mode | yes |
| `repo list`, `repo check` | Reads the modes | |
| `sync pull` | Pulls with rebase and autostash, then rebuilds the index | yes |
| `sync push [--summary <text>]` | Lints, commits the managed files, pulls and pushes | yes |
| `init [--path <dir>] [--remote <url>]` | Creates a vault from the template | |
| `setup [--path <dir>] [--force]` | Writes the config, installs the skill and agents, rebuilds the index, runs `doctor` | |
| `doctor` | Checks the machine and the vault; exit 0 only when every required check passes | |

Flags accepted anywhere: `--vault <path>`, `--trace <id>`, `--root <repo>`, `--json`. A missing `--vault` falls back to discovery, below.

Exit codes:

| Code | Meaning |
|---|---|
| 0 | Done |
| 1 | Failure: lint errors, no remote, missing config, or a failed `doctor` check |
| 2 | Rejected: schema or privacy violation, bad argument, a worker calling the CLI, a newer vault schema, or a rebase in progress |
| 3 | The repo's mode is `none` (`repo check`) |
| 4 | The vault is locked by another writer |
| 5 | Sync conflict or a rejected push; the tree is left as it was |
| 64 | Usage error: unknown command, unknown flag, or a wrong argument count |

`boot` prints `CLAUDE.md` first, then the project note, the repo's open findings, the last 20 log lines and the generated index, all inside the token budget (`harness.json` `boot_budget_tokens`, default 4000, about 4 characters per token). `CLAUDE.md` is outside the budget; the rest is dropped from the end and the text ends with `[truncated: <n> items]`. `stats` reports the boot size, so the budget can be seen before it is hit.

Write commands take a lock file in the vault's `.git/` (`agent-vault.lock`) so two writers never interleave; a busy lock is exit 4. The lock's wait time can be raised with `AGENT_VAULT_LOCK_WAIT_MS`.

### Discovery

The vault path is `$AGENT_VAULT` when it is set and non-empty, otherwise the `path` in `~/.config/agent-vault/config.json`. `vault.mjs resolve` prints what was picked.

The CLI's `findVault` (`pi-plan-dispatch/vault/notes.ts`) does not check that the folder exists. The dispatcher's `findVaultPath` (`pi-plan-dispatch/core.ts`) requires an existing directory and returns its realpath, and falls back to `AGENT_VAULT`-less discovery when it is missing. So an `AGENT_VAULT` that names a missing folder makes the two pick different vaults: the CLI talks to that path, the dispatcher guards the configured one.

## Who may write

- **The orchestrator** is the only writer, and only through `vault.mjs`. Its rules say to write after a run, never before: a `run` note, a `plan` note in a `full` repo, one `finding` per reviewer, pair, security, plan-audit or gate finding, `decision` and `lesson` notes only for durable facts, then `log append`. Plans stay in `.plans/inbox/` until the run is over.
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
2. Stages only managed files: the root files the template ships (`log.md`, `repos.json`, `harness.json`, `CLAUDE.md`, `README.md`, `bootstrap.sh`, `.gitattributes`, `.gitignore`), every `.md` and `.gitkeep` in a note folder, and everything in `templates/`. Other changed paths are printed as `unmanaged change: <file>` and left alone.
3. Commits as `vault: <summary|update> [trace <id>]`, using `agent-vault <agent-vault@localhost>` when git has no user email.
4. Pulls, then pushes; when the branch has no upstream it pushes with `-u origin HEAD`. A non-fast-forward rejection is retried once after another pull, then exit 5.

`log.md` carries `merge=union` in `.gitattributes`, so two machines appending log lines merge without a conflict. Every other file is last writer wins, which is why writes are short and happen after a run.

Whether the orchestrator pushes at the end of a request is the `sync_push` key in the vault's `harness.json`: `auto` means it runs `sync push`, `manual` means it commits nothing and tells the user a push is due. The vault is not the place to resolve a conflict by hand: pull first, then rewrite the note through the CLI.

## A new machine

1. Install Node 24 or newer and git.
2. Clone the vault repo next to the harness, so the vault's `bootstrap.sh` sits at `<parent>/agent-vault`.
3. Run `./bootstrap.sh` from the vault. It reads `min_node` and `harness_repo` from `harness.json`, clones the harness into the sibling `pi-plan-dispatch-phase1` when that is missing, and runs `vault setup` (`vault.mjs setup --path <vault>`).
4. `vault setup` writes `~/.config/agent-vault/config.json` (`path`, `remote`, `host`), installs the skill files into `~/.claude/skills/dispatch-plan/` and the agents into `~/.claude/agents/`, rebuilds `index.md`, then runs `doctor`. An installed file that differs from the recorded copy is kept and reported; `--force` replaces it.
5. `vault doctor` prints `ok` or `fail` per check with the exact fix command: Node version, git, a vault git repo the CLI's schema supports, a reachable `origin`, an upstream branch, installed files that match the harness, `pi`, the extension registered in `~/.pi/agent/settings.json`, `opencode-go` credentials, and at least one repo in `repos.json`. Graphify and the Obsidian skills plugin are optional checks.

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
| error | `secret` | A secret pattern matched in a note or in the history `--range` scans |
| error | `absolute-path` | A note or a property contains an absolute path |
| error | (schema or privacy) | Invalid frontmatter, a missing property, or a note a `none` repo does not allow |
| error | `none-slug-in-log` | A log line names a `none` repo |
| info | `dangling-link` | A wikilink points at a note that does not exist |
| info | `orphan` | No other note links to this one |

## Trace events

With both `--root <repo>` and `--trace <T>` the CLI appends to the same `.plans/traces/<T>.jsonl` the dispatcher writes, as actor `vault`. A missing flag writes no event, and a failed append never fails the command.

| Kind | When | Data |
|---|---|---|
| `vault.boot` | `boot` | `bytes`, `items`, `truncated` |
| `vault.write` | A write command | `type`, `id`, `op` |
| `vault.sync` | `sync pull` or `sync push` | `op`, `result` |
| `vault.unavailable` | A command needs a vault that is not configured | `reason` |
| `vault.denied` | A write names a repo the mode does not allow | `repo`, `type` |

`trace.mjs report` renders one line per event, for example `vault.write` as `new finding <basename>`.

## Non-goals and open ends

- No plan queue: plans keep flowing through `.plans/inbox/`, and the vault holds a `plan` note only after the run, in a `full` repo. The vault queue is deferred to Phase 2.
- Results, evidence, prompts and traces stay in the repo's `.plans/`; they are not copied into the vault.
- No Graphify over the vault itself, no embeddings or RAG, no Obsidian plugin, no Obsidian CLI, no schema migrations.
- Graphify query logging, auto conflict resolution and credentials in the vault are all out of scope.
