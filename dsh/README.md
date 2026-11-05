# dsh plugins for the Pi Harness backend

Six DeepSeek Harness (`dsh`) plugins that port the Pi Harness backend and surface it
in the sidebar **Dispatcher** panel (plus Settings → Usage). They
read and write the same files as `pi-plan-dispatch` and `dispatch-plan`, so the
old Pi extension and the dsh plugins can run side by side on one checkout.

Nothing here is built: every plugin is a plain ES module package with an
`index.js` and the logic in pure modules beside it. No dependency outside Node's
standard library is imported at runtime, and no `@deepseek-ai/*` package is
imported statically.

## Layout

| Path | What it is |
|---|---|
| `plugins/harness-dispatch/` | The dispatcher: plan parsing, G4 preflight, file-overlap scheduling, dsh-subagent and Pi workers, the worker guard (G2), independent verification (G1), pair mode, resilience, the trace/evidence/gate and `dispatch_status` |
| `plugins/harness-vault/` | A thin wrapper over `dispatch-plan/vault.mjs`: the session-start boot text, the orchestrator's vault tools and `vault_record_run` |
| `plugins/harness-projects/` | Git repositories as projects: a registry, a Projects page, read-only git state, and the warm repo-scoped vault context every session starts with |
| `plugins/harness-monitor/` | A read-only port of the Bun monitor and its built React client, served through dsh `webServer` routes |
| `plugins/harness-usage/` | A Client widget in the sidebar footer plus a Host poller for provider usage: OpenCode Go’s live usage route and configurable URLs for other routes |
| `plugins/harness-dispatcher-ui/` | The sidebar **Dispatcher** panel below Projects: a Settings tab with the omp default-model picker, the authenticated catalog from `omp --list-models`, filtered by provider and defaulting to OpenCode Go, and the plugin rows formerly under Settings → Harness, plus a **Dispatcher monitor** tab that embeds `/plugins/harness-monitor/` |
| `test/` | `node:test` suites, including a real headless `dsh` integration test and `fake-llm.mjs` |
| `fixtures/` | Fake executables and fixture builders (never named like a test) |

## Loading a plugin

A plugin loads from a dsh profile patch row:

```yaml
- insert:
    - id: harness-dispatch
      name: /absolute/path/to/dsh/plugins/harness-dispatch/index.js
```

`inject` lists only the services a plugin uses. A missing service makes that
plugin fail to activate (`dsh: warning: 1 entry did not activate`) and the run
continues; check stderr before relying on a guard.

## harness-dispatch

Watches `.plans/inbox/` from plugin start, runs one plan at a time, and moves it
through `running/` to `done/` (or `failed/` for a rejected plan). It writes the
same trace events, `.plans/done/<plan>/` files and gate as `pi-plan-dispatch`.
The unchanged CLIs remain the reading surface:

```bash
node dispatch-plan/trace.mjs wait --plan <id>
node dispatch-plan/trace.mjs gate --plan <id>
node dispatch-plan/trace.mjs report --trace <T>
```

### Config

Read from `.plans/config.json` and never written. The existing keys are read:
`model`, `thinking`, `maxParallel`, `timeoutMinutes`, `retries`, `tools`,
`dryRun`, `persistSessions`, `verifyTimeoutMinutes`, `workerGuards`,
`maxFilesPerTask`, `maxTaskChars`, `roles`, `pairDefault`, `maxRunsPerTask`,
`transientRetries`, `backoffSeconds`, `stallMinutes`, `outagePauseMinutes`,
`probeSeconds`, `probeUrls`. Additional dsh keys:

| Key | Default | Meaning |
|---|---|---|
| `dshCommand` | `dsh` | The headless dsh binary the Pi-style adapter would use |
| `ompCommand` | `omp` | The oh-my-pi binary used by `agent: "omp"` |
| `codingTimeoutMinutes` | `20` | Wall-clock bound for one `coding_subagent` call |
| `projectRegistry` | `~/.dsh/harness-projects.json` | Registered repositories whose `.plans/` is ensured |
| `dshPairDefault` | `pairDefault` | `.plans/config.json` key read only by dsh; lets a dsh plan use `pair-omp` without making the shared Pi preflight reject the role |
| `prices` | `{}` | `{ "<model>": { "in": <USD/Mtok>, "out": <USD/Mtok> } }`; dsh reports no cost, so cost is computed here or left 0 |
| `requirePlanAudit` | `false` | Reject a ready plan unless its trace has a passing `plan.audit` for this plan and round |
| `claudeCommand` | `claude` | The Claude Code binary used by `audit_plan` |
| `auditTimeoutMinutes` | `20` | Timeout for one `audit_plan` run |

The dispatcher prefers the most recently active `harness-projects` repository
as its root when no explicit `root` is configured, so a profile launch works in
the current git project. It ensures `.plans/{inbox,running,done,failed,specs,decisions,traces,sessions}`
in that root and in every repository in the registry; a missing `.plans/` is
created, never overwritten. `dispatch_status` returns the
current `plans` root and a `projects` list with each project's inbox/running
counts.

`decider` is parsed and ignored: the decider is not ported.

Roles resolve exactly as before: task `model:`/`thinking:`, then the task's
role, then plan frontmatter, then config defaults. A role's `agent:` is `dsh`
by default; `pi` selects the old `pi --mode json -p` runner and `omp` selects
oh-my-pi. The `pair-omp` role is a read-only oh-my-pi reviewer on
`opencode-go/beam-free`; set `pairDefault: "pair-omp"` to use it by default.
Retries, pair rounds and verify timeout are unchanged.

### Workers

The `dsh` runner starts one in-process subagent per task through
`ctx.subagents.startActivation` (the built-in `spawn` provider), passes the
prompt, model, reasoning effort and `cwd`, applies a scoped guard and a tool
restriction to the child, and observes its `session/event` stream for tool calls
and usage. It restricts tools to the worker set, denies self-delegation and
every vault tool, and enforces the task's `files:` live. The Pi runner keeps
`PI_PLAN_DISPATCH_WORKER=1`, drops the vault, and installs
`PI_PLAN_DISPATCH_GUARD` exactly as before.

- `agent: "omp"` runs the same JSON protocol through oh-my-pi; the `pair-omp`
  role is a read-only reviewer on `opencode-go/beam-free`. See
  [docs/omp-opencode.md](../docs/omp-opencode.md) for the OpenCode session header.

The worker guard text starts `BLOCKED by harness-dispatch:` and counts as a
`blocked_action` warning. The guard is an allow-list on top of a shell: shell
redirects, `sed -i`, `tee`, scripts and `python -c` can still write, so the git
snapshot and the gate remain the backstop.

The guard follows the worker across a process boundary. An `agent: "omp"` task
runs in a separate `omp` process that cannot see the parent's tool scope, so
the policy travels with it: the runner puts it on the request, the provider
exports it into that child's own environment and passes `--hook`, and
`plugins/harness-omp-subagent/omp-guard-hook.js` reads it and calls the same
`guard.js` the parent uses. An unreadable policy blocks every tool call rather
than allowing the run, and a run with no policy exported stays unguarded. The
policy is per child, so concurrent tasks with different file scopes cannot
observe each other's.

### Orchestrator tools

`dispatch_status` returns the ready queue, the running plan's task states and
the last gate for the calling session's repository. `dispatch_project` selects
that repository explicitly when the session's working directory is not the git
project; the choice is kept per session and a queue is started for it. `coding_subagent` starts one ad-hoc dsh coding subagent outside a
plan, with a prompt, `cwd`, model, thinking level and an explicit tool
allow-list; it returns the child's final report. `audit_plan` runs headless
`claude -p --agent plan-auditor --output-format json --no-session-persistence`
with the plan, spec, trace, plan round and audit round, returns the findings
and verdict, and never logs `plan.audit` itself — the auditor agent logs it.
All three are registered globally but denied to every worker by the worker
restriction and the guard.

## harness-vault

A wrapper over `<skillRoot>/vault.mjs` (default
`~/.claude/skills/dispatch-plan`). It never writes a vault file itself: it
spawns the CLI with an argument array, no shell, an allow-listed subcommand, a
timeout, and `--trace`/`--root` when given.

At plugin start it runs `resolve --json`, `repo check`, `sync pull` and `boot`
(20 s each), caches the text and adds it as a system-prompt section. A failed
step becomes one line in that section and never blocks the session; exit `3`
from `repo check` means mode `none` and says to skip every vault step.

Tools, orchestrator only (never offered to subagents or workers):
`vault_search`, `vault_note` (`new`, `set`, `status`, `supersede`; body on
stdin), `vault_work` (`add`, `pending`), `vault_log`, `vault_sync`
(`pull`, `push`), `vault_restore`, `vault_config` (`push`, `pull`), `vault_project` and
`vault_record_run`.

`vault_project` writes the existing `project` note type with a standard
`## Pipeline` section: product requirements, spec, plans, runs, decisions and
deployment, each a note basename or wikilink. No vault schema change is needed.

`vault_record_run` performs the fixed order of CLAUDE.md vault rule 2: trace
report, run note and finding notes (`note new`), `work add`, plan/spec status,
`log append`, then `sync push` when the vault's `harness.json` has
`sync_push: auto`. Finding basenames are `<trace>-f-<first 8 hex of sha1 of the
fingerprint>`.

### Config

| Key | Default | Meaning |
|---|---|---|
| `skillRoot` | `~/.claude/skills/dispatch-plan` | Folder holding `vault.mjs` and `trace.mjs` |
| `injectVaultBoot` | `true` | Add the cached boot text to the system prompt |
| `timeoutMs` | `20000` | Per-call CLI timeout |
| `root` | session working directory | Repo root passed as `--root` |

## harness-projects

Git repositories as projects, and the warm context every session starts with.

The Host keeps a registry of local repo paths in `~/.dsh/harness-projects.json`
(overridable). A root session primes its own repository on `agent/created`, so a
repository registers itself the first time a session opens in it. `project_add`
and `project_remove` manage the registry by hand; `project_list`,
`project_status` and `project_warm` read it.

Two prompt contributions per session, both keyed by the session's repository:

- a section `harness-projects` at order 940: the slug, the root and the vault
  mode, computed once per session;
- a context `harness-projects` at order 130: the warm block — git state and the
  newest commits, the vault project note, open findings, recent runs, the last
  decision/lesson and the newest log line, capped at `budget` characters.

The warm block is rebuilt in `agent/created` before the first model call and
refreshed every `refreshSeconds` for running sessions, so new and existing
sessions both stay warm. It reads git directly (`rev-parse`, `status`, `log`,
`remote`) with `GIT_OPTIONAL_LOCKS=0` and reads the vault as files; it never
writes a vault file and never runs a vault write command. The vault's mode gate
applies: `none` and `meta` repos get git context only, and workers get no vault
text at all.

`harness-vault` still injects its own `boot` section at order 950. The two do
not overlap: this block is repo-scoped and compact, the vault boot is the
schema and the global rules. A profile that wants only the compact block sets
`injectVaultBoot: false` on the `harness-vault` row.

The Client half is a Projects page under `main` key `git-projects` with a
sidebar row of the same id, served by two exact routes:
`GET /plugins/harness-projects/state[?dir=…]` and
`POST /plugins/harness-projects/action` (`add`, `remove`, `pin`, `refresh`).

### Config

| Key | Default | Meaning |
|---|---|---|
| `warm` | `true` | Inject the warm block at all |
| `budget` | `1200` | Character cap for the warm block |
| `refreshSeconds` | `20` | Git/vault cache TTL and refresh interval |
| `registryPath` | `~/.dsh/harness-projects.json` | The registry file |
| `skillRoot` | `~/.claude/skills/dispatch-plan` | Folder holding `vault.mjs`, used once to resolve the vault |
| `warmForSubagents` | `false` | Give workers the git-only block |
| `maxRepos` | `80` | Rows in `project_list` |

## harness-monitor

A read-only port of `monitor/src/server` to plain Node ESM. It registers these
routes on `ctx.webServer` in a web profile:

- `GET /api/state` (the board: repos, plans, task rows, lanes, gate, decider),
- `GET /api/events` (SSE `hello`, `change`, ping),
- `GET /api/monitor/session/<repo>/<plan>/<session>?after=<line>` (transcripts),
- `GET /api/agents?scope=added|all` (Pi, omp and dsh sessions),
- `/plugins/harness-monitor/` (the built client copied from `monitor/dist`),
  with `?embed=1&theme=dark|light` for the Dispatcher panel.

It never writes. It answers `GET`/`HEAD` only, checks the `Host` header, rejects
path traversal, and adds `nosniff` and `no-store` (no CORS headers). In a
profile with no web server it is inert; there is no fallback HTTP server because
dsh already provides `ctx.webServer`.

### Config

| Key | Default | Meaning |
|---|---|---|
| `root` | session working directory | Repo root |
| `plansDir` | `<root>/.plans` | Plans tree to read |
| `repos` | auto-discovered | Named repositories; when omitted, projects come from `~/.dsh/harness-projects.json` |
| `registryPath` | `~/.dsh/harness-projects.json` | Project registry used for discovery |
| `staticDir` | `<plugin>/dist` | Built client |
| `pollMs` | `500` | Change-poll interval for SSE |
| `prefix` | `/plugins/harness-monitor` | Client mount path |
| `enableAgents` | `true` | Enable `/api/agents` |

## harness-usage

A Client widget in the sidebar footer (beside Settings) plus a Host poller with OpenCode Go, Claude Code plan windows and OpenDesign status. The footer button shows a small donut and opens a provider card with donut charts for the 5h, week and month windows. A dedicated **Settings → Usage** page mirrors the effective config: provider adapter, endpoint, credential reference and key status, unit, poll interval, timeout and live state. It is read-only; the key is never shown. It reads the
provider list from config and serves `GET /plugins/harness-usage/state` to the
widget.

- **OpenCode Go** polls `https://opencode.ai/inference/go/v1/usage` with
  `OPENCODE_GO_API_KEY` (environment or the dsh credential store). The endpoint returns `usage.rolling`, `usage.weekly`
  and `usage.monthly`, each with `status`, `percent` and `resetsAt`; the parser
  maps those to the 5h/week/month donuts. It also accepts common limit/used
  shapes and shows the raw payload when it cannot recognise one.
- **Claude Code** runs `claude -p /usage --output-format json` locally and
  parses the 5-hour and weekly lines. The CLI authenticates itself; no token
  is read. No public Team usage API exists (see
  [docs/claude-team-usage-api.md](../docs/claude-team-usage-api.md)).
- **OpenDesign Cloud** has no API-key usage route: credits are console-cookie
  only. It shows a console-only status unless `usageUrl` is configured; see
  [docs/opendesign-usage-api.md](../docs/opendesign-usage-api.md).

No key is logged, returned or written. A missing key, unreachable endpoint,
unknown shape or unsupported provider is a status line in the widget, never an
invented number.

### Config

| Key | Default | Meaning |
|---|---|---|
| `providers` | the two known routes | Per-provider `{id,label,kind,usageUrl,apiKeyEnv,unit}`; merged by id |
| `pollMs` | `60000` | Host poll interval |
| `timeoutMs` | `10000` | Per-request timeout |

## harness-dispatcher-ui

The sidebar **Dispatcher** panel, placed below Projects. It is a Client bundle
(`@pi-harness/dsh-plugin-harness-dispatcher-ui`) with a small Host half that
serves the model routes. It has two tabs:

- **Settings** — the omp default-model picker. It reads the current default with
  `omp config get modelRoles --json`, fills the list from `omp --list-models`,
  and **Set default** writes `omp config set modelRoles '{"default":"<id>"}'
  --json`. That is omp's global default, so it applies to every omp run; the
  dispatcher's `pair-omp` reviewer keeps its own model in `.plans/config.json`
  (default `opencode-go/beam-free`) unless the config or a plan changes it. The
  same tab repeats the plugin rows that used to live under **Settings →
  Harness**.
- **Dispatcher monitor** — an iframe of `/plugins/harness-monitor/`, titled
  **Dispatcher monitor**; it embeds the existing read-only board (the routes in
  the `harness-monitor` section above) instead of copying the client.

Host routes: `GET /plugins/harness-dispatcher/settings` returns `{ompModel,
models}`, `POST` the same path takes `{ompModel}` and writes it through omp, and
`GET /plugins/harness-dispatcher/models` returns the catalog. An unknown model
or a malformed id is rejected with `400` before omp is written. The Host never
reads an API key.

The `harness-settings` bundle was uninstalled: its **Settings → Harness** section
is gone, and its plugin rows are the ones in this panel. `harness-usage` keeps
its own **Settings → Usage** page. The panel's rendering was not visually
verified in a running web profile.

## Tests

```bash
cd dsh && node --test
```

Every file under `dsh/test/` exits 0 with no arguments. The integration test
runs a real headless `dsh` against `test/fake-llm.mjs`, a fake OpenAI-compatible
server on `127.0.0.1`, with a scratch `DSH_HOME`, a scratch `HOME` and the
dummy key `OPENCODE_GO_API_KEY=dummy-not-a-key`; it skips only when `dsh` is not
installed. It then runs the unchanged `dispatch-plan/trace.mjs gate` and
`report`. No test reads the real `~/.dsh`, `~/.pi`, `~/.omp` or the real vault.
