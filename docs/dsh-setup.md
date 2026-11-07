# dsh setup: the dsh plugins in a `harness` profile

This page is the install and use guide for the dsh port in `dsh/`: the
dispatcher (M3), the vault wrapper (M4), the monitor (M6) and the Dispatcher
sidebar panel. The backend files under `.plans/`, `dispatch-plan/` and the vault
are unchanged; the dsh plugins are another front end on the same checkout.

## What is confirmed, and with which tools

Confirmed on dsh `0.2.1-rc.5` with the Cordis inspection tools in this session:

- `ctx.tools.register(definition)`, `ctx.tools.guard(fn)`,
  `ctx.tools.restrict({allow, deny})` and their semantics (the guard is
  monotonic, a restriction needs a scoped `agent.ctx`).
- `ctx.systemPrompt.section({name, order, text})`; `text` may be a function.
- `ctx.subagents.startActivation({provider, label, request, signal, delivery})`
  with `request.prompt`, `request.parent`, `request.cwd`,
  `request.agentOptions` and `request.maxDepth`; `delivery: "caller"` returns
  `{childId, result, dispose}`.
- `ctx.agents.roots()` / `get(id)`, `ctx.on("session/event", (session, event))`
  and the `tool/call`, `tool/result`, `assistant/message` and `turn/end` events
  with their fields under `event.data`.
- `ctx.webServer.register({kind: "exact" | "prefix", path, handler})` and
  `ctx.webServer.getOrigin()`; a route handler receives raw Node
  `(req, res)`.
- `workingDirectory` is a separate injected service (`inject` must list it).

Confirmed by executing them:

- A plugin loads from a patch `insert` row; a plugin that throws prints
  `dsh: warning: 1 entry did not activate` and the run continues.
- The worker guard applies to subagents; a denial returns
  `Error: BLOCKED by harness-dispatch: ...`; the task then shows a
  `blocked_action` warning.
- A real headless dsh run against a fake OpenAI-compatible server runs a
  three-task plan, writes events/evidence/`_summary.md`/gate, and the unchanged
  `trace.mjs gate` and `trace.mjs report` read it.

Not measured here:

- The `web` profile rendering the monitor in a real browser (the routes and the
  API were tested over a loopback Node server; the built client was copied
  unchanged). The **Dispatcher** sidebar panel was not rendered in a browser,
  and its model picker was not exercised against a real `omp`.
- A real model call, a real vault, a real `vault_record_run`, a real plan audit through `claude -p`, and the real OpenCode Go usage endpoint response shape.
- Whether a user plugin can be marked required (it cannot be, per the probe), so
  a plugin that fails to activate is fail-open; check stderr.
- Claude Code headless audit and the plan-auditor bridge: not ported in this
  run.

## Prerequisites

- dsh `0.2.1-rc.5` (pin it; this is a developer preview).
- Node 24 or newer for the CLIs and tests.
- The dispatcher and vault CLIs installed where the profile points: the repo's
  `dispatch-plan/` is enough; the vault plugin's `skillRoot` defaults to
  `~/.claude/skills/dispatch-plan`.
- A model route for the workers and the orchestrator. The repo's
  `dispatch-plan/config-init.mjs` writes `.plans/config.json`; keep it.

## Profile patch

A profile is a stack of patch layers. Add the rows to the `harness`
profile's patch (or create the profile from `headless` and add them). Replace
the paths and the route:

```yaml
# harness/cordis.patch.yml
- id: agent-default-model
  config:
    provider: opencode-go
    model: deepseek-v4-pro

- id: llm-pi-ai
  config:
    providers:
      opencode-go:
        apiKeyEnv: OPENCODE_GO_API_KEY

- insert:
    - id: harness-dispatch
      name: /absolute/path/to/repo/dsh/plugins/harness-dispatch/index.js
    - id: harness-vault
      name: /absolute/path/to/repo/dsh/plugins/harness-vault/index.js
    - id: harness-projects
      name: /absolute/path/to/repo/dsh/plugins/harness-projects/index.js
    - id: harness-monitor
      name: /absolute/path/to/repo/dsh/plugins/harness-monitor/index.js
    - id: harness-usage
      name: /absolute/path/to/repo/dsh/plugins/harness-usage/index.js
    - id: harness-dispatcher-ui
      name: /absolute/path/to/repo/dsh/plugins/harness-dispatcher-ui/index.js
```

The insert block has six rows. `harness-settings` is no longer one of them: the
bundle was uninstalled, its **Settings → Harness** section is gone, and its
plugin rows now sit in the **Dispatcher** panel below Projects.

`harness-vault` and `harness-projects` need `agents` and `workingDirectory`, and
their Projects page needs `webServer` (the Host tools and the warm context work
without it); `harness-monitor`, `harness-usage` and `harness-dispatcher-ui` need
`webServer`. Load the vault and projects plugins in a front-end profile, and the
monitor and the Dispatcher panel only in the `web` profile. The dispatcher is
the one the headless workers need.

The key is never written into a patch. Set it in the environment for the run:

```bash
export OPENCODE_GO_API_KEY=...   # the user's key, never committed
dsh --profile harness "draft a plan for ..."
```

## Use

1. The orchestrator (the dsh session) clarifies the request and writes a spec
   and a plan under `.plans/`; only a flipped `.md` (never `.md.draft`) is
   picked up.
2. The dispatcher starts each task as a dsh subagent, enforces the task's
   `files:` in the guard, runs `verify:` itself, retries once on a failed
   verify, and writes the trace and the gate.
3. Wait with the unchanged CLI:

   ```bash
   node dispatch-plan/trace.mjs wait --plan <id> --timeout 3300
   node dispatch-plan/trace.mjs gate --plan <id>
   node dispatch-plan/trace.mjs report --trace <T>
   ```

   `dispatch_status` gives the same queue and task states from inside the
   session.
4. In a `web` profile, open
   `http://127.0.0.1:<port>/plugins/harness-monitor/` for the read-only board.
   The API is `/api/state`, `/api/events`, `/api/session/...` and
   `/api/agents`.
5. After a run, call `vault_record_run` once with the trace and plan ids. It
   performs the fixed order; `sync push` follows only when the vault's
   `harness.json` says `auto`.
6. For a project-level index, call `vault_project` with the project name and
   repo slugs, then the pipeline stages (`requirements`, `spec`, `plans`,
   `runs`, `decisions`, `deployment`). It writes the existing `project` note;
   stage values can be note basenames or `[[wikilinks]]`.
7. For work outside a plan, call `coding_subagent` with a self-contained
   prompt; it starts one dsh coding subagent and returns its final report.
   For a drafted plan, call `audit_plan` with the plan and spec paths; it runs
   the installed `plan-auditor` agent through headless Claude Code and returns
   its JSON report. The auditor logs `plan.audit`; the tool never does. Set
   `.plans/config.json` `requirePlanAudit: true` to make the dispatcher reject a
   ready plan until that event has a `pass` verdict.
8. The usage widget renders in the sidebar footer beside Settings; click **Usage** to open a card with donut charts for the 5h/week/month windows and the provider status lines. OpenCode Go polls its usage route; Claude Code reads its local `/usage` command (no token access); OpenDesign credits are console-cookie only, so it stays a status line unless you configure `usageUrl`; see [claude-team-usage-api.md](claude-team-usage-api.md) and [opendesign-usage-api.md](opendesign-usage-api.md). **Settings → Usage** mirrors the effective config: adapter, endpoint, credential reference and key status, unit, poll interval, timeout and live state.
9. Open the sidebar **Dispatcher** panel, below Projects. Its Settings tab has
   the omp default-model picker and the plugin rows that used to be under
   **Settings → Harness**; that section is gone, and `harness-usage` keeps its
   own **Settings → Usage** page. **Set default** writes omp's global
   `modelRoles.default` through `omp config set modelRoles`, so it changes the
   default for every omp run; it does not change the dispatcher's `pair-omp`
   role, whose model stays in `.plans/config.json` (default
   `opencode-go/beam-free`) unless the config or a plan overrides it. The
   **Dispatcher monitor** tab embeds `/plugins/harness-monitor/?embed=1`
   (the host passes the active theme), the same read-only board as step 4;
   it auto-discovers the projects in `~/.dsh/harness-projects.json`.
10. Each session's dispatcher root is its git root when it has one, otherwise the repository selected with `dispatch_project`. With no selection, it falls back to the configured `root` or the profile directory; `.plans/` is created automatically in the selected root and in every registered repository. Existing plans are never overwritten. `dispatch_status` returns `plans` and `projects` with inbox/running counts.
11. For oh-my-pi pair review, set `dshPairDefault: "pair-omp"` in `.plans/config.json` (or `pair: pair-omp` on a task); dsh reads that dsh-only key, while the shared Pi preflight still sees the ordinary `pairDefault`. The reviewer runs `omp` on `opencode-go/beam-free` with the read-only tools. See [docs/omp-opencode.md](omp-opencode.md) for the `x-opencode-session` fix.


## Known limits

- **The decider is not ported.** `.plans/config.json` `decider` is read and
  ignored; there is no dispatch-time effort suggestion and no audit proposal.
  Plans still run without it.
- **The guard is an allow-list on top of a shell, not a sandbox.** It blocks
  edit tools outside the task's `files:`, paths outside the repo, `.git/` and
  `.plans/`, and the listed destructive shell commands. Redirects, `sed -i`,
  `tee`, scripts, `python -c`, `xargs rm` and `find -delete` can still write.
  The git snapshot, `verify:` and the gate are the backstop.
- **Fail-open plugins.** dsh has no required-plugin flag. A plugin that throws
  during activation only warns; check stderr. The dispatcher is the one that
  matters for workers.
- **In-process subagents.** The default dsh runner is not a separate process:
  it shares the dsh process, so cancellation is `dispose()` and there is no Pi
  session file to reopen. `agent: "pi"` keeps the old headless process runner
  and its session files.
- **No cost from dsh.** dsh reports tokens, not cost. The dispatcher computes
  cost from the optional `prices` table or records 0. `trace.mjs report` will
  show `$0.0000` unless prices are set.
- **Usage polling is partly unverified.** OpenCode Go has a
  `/inference/go/v1/usage` route, but its response shape is not documented; the
  widget accepts common limit/used windows, shows the raw body otherwise, and
  records no key. OpenDesign Cloud exposes no documented usage route.
- **omp is not added.** `omp 15.7.3` is installed, but the dated probe never
  completed an OpenCode Go run (HTTP 400, missing `x-opencode-session`), so its
  tool stream is unmeasured. `dsh` is the default coding agent, with `pi` as the
  fallback; adding `omp` is a probe first, adapter second.
- **`coding_subagent` is not a sandbox.** It restricts the child to a tool
  allow-list and denies delegation/vault tools, but the child can still write
  through the shell; use it for trusted prompts.
- **The monitor is web-profile only.** It registers routes and does not start
  its own server; in headless it is inert. The built client is built with
  `cd monitor && bun run build` and copied from `monitor/dist` into the
  plugin's `dist/`.
- **Vault writes stay in the CLI.** The plugin never writes a vault file; it
  spawns `vault.mjs` with an allow-list. The real vault was not exercised here.
- **Plan audit needs Claude Code.** `audit_plan` runs the installed
  `plan-auditor` agent through headless `claude -p`; it needs the `claude`
  binary and a logged-in Claude Code. The command itself is tested with a fake
  binary, but a real audit with a plan and spec was not measured. The auditor
  writes `plan.audit`; `requirePlanAudit` is opt-in because older plans have no
  audit event.
- **Not ported:** the hard-rule guard, the context-rules plugin, the launcher
  and the profile presets.
- **Compatibility risk.** dsh is a developer preview; a later release can change
  the `session/event` fields, `agentOptions`, the web route shape or the plugin
  loader. Pin the version and rerun `cd dsh && node --test` after an upgrade.

## Try by hand

1. One real plan through the dispatcher with the real key: start dsh in the
   repo, flip a small plan, run `trace.mjs wait`, then `gate` and `report`.
2. Open the monitor in the dsh web client and compare it with `monitor/` on the
   same `.plans/` tree.
3. Run `vault_record_run` on a real trace and check the run, finding, plan and
   spec notes, the `work add` copy and the log line.
4. Run `vault_project` for one project and read the `boot` output; confirm the
   project note appears with its pipeline links.
5. Open the usage widget and confirm the OpenCode Go route shape; if it shows
   the raw body, send that shape so the parser can be extended.
