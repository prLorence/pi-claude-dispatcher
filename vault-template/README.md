# Agent vault

Agent memory. One git repo that the agents read at the start of a session and
write to as the work moves: specs, plans and ideas are mirrored at each
milestone, and the record of a finished run is copied in. What they learned
survives the next session and the next machine.

Notes are written only through the `vault` CLI. No agent edits a note file by
hand, so the schema, the allowlist and the privacy rules are always applied.

## Layout

| Path | What it is |
|---|---|
| `specs/` | one note per request, mirrored when the spec is confirmed |
| `plans/` | one note per run's plan, updated at each milestone |
| `ideas/` | ideas, each with a status |
| `runs/` | one digest per run: trace, repo, status, gate |
| `findings/` | reviewer, audit, pair, security and gate findings |
| `decisions/` | durable decisions |
| `lessons/` | durable lessons |
| `projects/` | one note per project, listing its repos |
| `codebases/` | Graphify digests of codebases |
| `templates/` | Obsidian Bases views |
| `index.md` | generated from the notes, git-ignored, never edited |
| `log.md` | append-only one-line log, merged with `merge=union` |
| `repos.json` | the allowlist and the privacy mode of each repo |
| `harness.json` | schema version, harness repo, boot budget, minimum Node |
| `CLAUDE.md` | the schema the agents follow |
| `bootstrap.sh` | sets up a new machine |
| `work/` | the run record of finished requests, written only by the CLI, not a note folder |
| `config/` | `dispatch.json`, the dispatcher config |

Each type folder is flat. The agent schema is in `CLAUDE.md`.

## A new machine

1. Clone this vault.
2. Run `./bootstrap.sh`. It checks Node and git, clones the harness repo into a
   sibling folder named `pi-plan-dispatch-phase1` when that folder is missing,
   and runs `vault setup` from there.
3. Do the rest by hand, as the script prints:
   - log Pi into OpenCode Go;
   - register the extension package in `~/.pi/agent/settings.json`;
   - install the Obsidian skills plugin in Claude Code:
     `/plugin marketplace add kepano/obsidian-skills`, then
     `/plugin install obsidian@obsidian-skills`;
   - optionally install Graphify.

## Privacy

Every repo in `repos.json` has a mode. The mode of a note is the mode of the
repo it names. An unlisted repo, a repo with no slug, and a missing or
malformed `repos.json` are `none`: the CLI fails closed.

| Mode | What the vault may hold |
|---|---|
| `full` | every note type, subject to `lint` |
| `meta` | `run`, `decision`, `lesson` and `idea` only, and no code or repo file paths |
| `none` | nothing that names the repo |

The point of the modes is that a repo that must stay private still contributes
its gate result, its lessons, its decisions and its ideas, and nothing more.
