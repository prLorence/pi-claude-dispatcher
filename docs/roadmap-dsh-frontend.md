# Roadmap: the DeepSeek Harness (dsh) as a second front end

This document is the ordered plan for using the DeepSeek Harness (`dsh`) beside Claude Code as a designated front end for this project. It records what a front end does today, what the target design looks like, the phases that get there, the risks, the open questions and a measurement plan; the probe evidence behind the statements about dsh is in [docs/dsh-probe.md](dsh-probe.md).

## Goal and non-goals

This project is a backend. Specs and plans are files under `.plans/`, a Pi extension dispatches plan tasks to worker agents, a deterministic gate and a trace decide whether a run passed, and the agent vault stores the memory of a request. Claude Code is today's only front end: Sonnet 5.5 is the orchestrator and Opus 5.5 is the plan auditor. The user wants dsh as a second designated front end, to use at work, and later wants dsh to run workers and host the monitor.

The roadmap exists to let the user choose what to build first, and each phase can later become its own spec. dsh is a designated second front end, not a replacement: both front ends drive the same backend, and the user picks a front end per request. Claude Code keeps Sonnet and Opus as today.

This roadmap does not:

- start any phase, write any code, add any plugin or change any config;
- run dsh, install anything or make a model call (the live probe is Phase 0 of the roadmap, not part of the request that wrote this document);
- decide Phase 4's timing, the user's other subscriptions or the work repos, which are open questions;
- route Claude models through dsh's own Anthropic provider or its Anthropic subscription sign-in, the billing question `CLAUDE.md` already avoids;
- retire the Wails monitor app or the Bun monitor before a dsh monitor plugin matches them.

## The front end today

A front end is the session the user talks to. In this project it clarifies the request into a saved spec, writes the plan, runs the plan audit, gets the user's approval, starts the dispatcher and reads the gate and the trace. It never writes code; workers do. The front end is defined by rules text, a skill, an agent file, two agent-level tools and one notification channel, and all of those assume Claude Code today.

| Component (real file or marker) | What it does | What dsh needs instead |
| --- | --- | --- |
| `CLAUDE.md`, marker line `## Delegation rules (dispatch-plan)` (line 19), and the same block in `dispatch-plan/ORCHESTRATOR.md` (line 4) | The eight-step flow the orchestrator follows, the hard rule that Claude models never write repo files, the vault rules, the actor name `sonnet-orchestrator`, and the installed CLI paths under `~/.claude/skills/dispatch-plan/` | The same rules text loaded through `AGENTS.md`; a dsh identity for the orchestrator, a hard-rule plugin that enforces the edit and shell blocks, and paths that do not assume the `~/.claude/skills/` install location |
| `dispatch-plan/SKILL.md` | The spec and plan formats, the atomic draft and flip, the plan-audit procedure, the wait and gate procedure, the trace events, the fix-round limits and the vault procedure | A rewritten skill in dsh's own skill format (dsh has `dsh-skill`, `dsh-skill-filesystem` and `dsh-tool-skill`), with the same content and dsh tool names |
| The `grilling` skill (external, `~/.agents/skills/grilling/SKILL.md`; it lives outside this repository) | The relentless clarification pass that turns a request into a spec before any plan is written | The same skill installed in dsh's skill format, or a dsh-native equivalent; the flow depends on it, so it must be present before Phase 1 is usable |
| `dispatch-plan/agents/plan-auditor.md` | The read-only Claude Code subagent definition: frontmatter `model: opus`, `tools: Read, Grep, Glob, Bash`, `disallowedTools: Write, Edit`, and preloaded skills `codebase-design`, `domain-modeling`, `tdd`; it logs `plan.audit` as `opus-plan-auditor` | A dsh plan-auditor bridge that runs headless `claude -p` with this agent file and returns its findings; the agent file itself stays unchanged |
| The Agent tool, named in the rules as "spawn the read-only `plan-auditor` subagent ... with the Agent tool, `subagent_type: plan-auditor`" | Starts the auditor in a fresh read-only context | The planned plan-auditor bridge plugin, since dsh's own subagents (`dsh-tool-subagent`, `dsh-tool-workflow`) run in-process and are not the Claude Code Agent tool |
| Background waits and notifications: the Bash tool's `run_in_background`, the Monitor tool, `trace.mjs wait` / `watch`, and `PushNotification` | The run is not polled: the session is re-invoked when the background `wait` exits, and one notification reports the plan id and the gate result | dsh's own background-command and notification surfaces, or a small plugin that wraps `trace.mjs wait`; the polling rule and the exit codes stay the same, and `PushNotification` needs a dsh equivalent or is dropped |
| The Obsidian skills `obsidian-markdown` and `obsidian-bases` (external, outside this repository), named in the vault rules | Govern how note text and `.base` views are written when the orchestrator writes the vault through `vault.mjs` | The same skills in dsh's skill format, or plain rules in `AGENTS.md`; the vault CLI is unchanged and still the only write path |

The vault rules block (`## Vault rules (agent-vault)`, also in `CLAUDE.md` and `dispatch-plan/ORCHESTRATOR.md`) is part of the same front-end surface: it names the CLI `dispatch-plan/vault.mjs`, the actor `vault`, the Obsidian skills and the push order. dsh needs that block loaded from `AGENTS.md`, with the CLI paths adapted to the device.

## Target design

### Shared backend, per-request front end

The backend does not change: `.plans/specs/` and `.plans/inbox/` are the hand-off, the `pi-plan-dispatch` extension dispatches workers, the gate and the `verify:` commands decide a run, the traces live in `.plans/traces/` and the vault is written only through `dispatch-plan/vault.mjs`. A front end is a thin session on top: it writes specs and plans, runs the CLIs and reports. The user chooses Claude Code or dsh per request; a request started in one can be continued in the other because the hand-off is files, not session state. Nothing in the backend records which front end wrote a plan, except the trace actor.

### Models inside dsh

- Orchestrator: the recommended default is `opencode-go/deepseek-v4-pro`, reached through the OpenCode Go plan. Alternatives to measure are `mimo-v2.6-pro` and `glm-5.2`. The user's criterion is the OpenCode Go model closest to Sonnet 5.5 with the highest request count for long sessions; that closeness is a hypothesis, not a measured fact (see the caveats below).
- Workers: unchanged, `deepseek-v4.1-flash` through OpenCode Go.
- Auditor: stays Opus 5.5, reached by dsh running headless `claude -p` for that one step on the user's Claude subscription. Every dsh device therefore also needs Claude Code installed and logged in. Claude models are not routed through dsh's Anthropic provider or its Anthropic subscription sign-in.

The OpenCode Go limits, copied from the source with the same columns and figures:

| Model id | Price in / out per Mtok | Requests per 5h / week / month (Go plan) |
| --- | --- | --- |
| `deepseek-v4-pro` | $0.66 / $1.98 off-peak, $1.32 / $3.96 peak (cached read $0.022 / $0.044) | 1,050 / 2,600 / 5,200 |
| `deepseek-v4.1-flash` | $0.15 / $0.60 off-peak, $0.30 / $1.20 peak | 43,330 / 108,330 / 216,670 |
| `glm-5.2` | $1.40 / $4.40 | 880 / 2,150 / 4,300 |
| `glm-5.3` | $1.40 / $4.40 | 220 / 540 / 1,080 |
| `kimi-k3` | $3.00 / $15.00 | 110 / 250 / 490 |
| `kimi-k3.1-pro` | $2.00 / $10.00 | 147 / 368 / 735 |
| `qwen3.8-max` | $2.00 / $6.00 | 160 / 400 / 810 |
| `mimo-v2.6-pro` | $0.435 / $0.87 | 3,250 / 8,150 / 16,300 |
| `claude-haiku-5-5` | $0.10 / $0.50 up to 100K | 3,850 / 9,620 / 19,230 |

Source: `https://opencode.ai/docs/go/`, read 2026-11-03. The page calls the request counts estimates for typical usage.

Caveats on the evidence:

- The performance evidence is thin and mostly vendor-reported: one comparison reports Terminal-Bench 2.1 scores of 87.9 (DeepSeek V4 Pro), 88.2 (GLM-5.3) and 88.3 (Kimi K3); a review reports 80.6% on SWE-bench for V4 Pro; a ranking lists Sonnet 5.5 on Terminal-Bench 4.0, a different version, so those figures are not comparable. No neutral head-to-head with Sonnet 5.5 was found, and no coding score was found for `mimo-v2.6-pro`.
- The table's request counts assume typical usage. Real orchestrator turns carry long contexts, so the real request count per session will be lower than the table, and peak pricing applies in peak hours. The measurement plan is how this gets settled.

### How the flow reaches dsh

- `AGENTS.md` (planned; it is not in this repository yet). The rules block of `dispatch-plan/ORCHESTRATOR.md` is written to be pasted into an `AGENTS.md`, and the setup step in `CLAUDE.md` already says to paste the block into `AGENTS.md` with `CLAUDE.md` importing it. dsh's instruction loader (`@deepseek-ai/dsh-agent-instructions`) is described as the workspace context loader for `AGENTS.md` and `CLAUDE.md`, so the planned dsh setup is: paste the block into `AGENTS.md` and let dsh load it. The precedence between `AGENTS.md` and `CLAUDE.md`, and the nested-folder behavior, were not measured by the probe.
- The agent-neutral CLIs, unchanged: `dispatch-plan/trace.mjs` (events, `wait`, `watch`, `gate`, `report`, `new-id`), `dispatch-plan/preflight.mjs`, `dispatch-plan/decide.mjs` and `dispatch-plan/vault.mjs` (with its `work`, `restore` and `config` modules beside it). They already run with `node` and take `--root` and `--trace`, so dsh calls them the same way Claude Code does. The installed-copy paths in the rules (`~/.claude/skills/dispatch-plan/`) need a per-device install location that both front ends can use.
- The skills, rewritten once in dsh's own skill format: `dispatch-plan/SKILL.md` and the `grilling` skill. dsh's skill system (`dsh-skill`, `dsh-skill-filesystem`, `dsh-tool-skill`) is not Claude's SKILL.md format, so this is a rewrite, not a copy; a community bridge that loads Claude-style SKILL.md folders exists secondhand but was not verified.
- A custom dsh profile (planned) that mounts our plugins on top of the `headless` composition and sets the orchestrator model. A profile is an ordered stack of plugin-bundle patch layers under the user's own overrides; the probe saw the headless composition's default model plugin set to `provider: deepseek-official`, `model: deepseek-flash`, which the profile overrides.

### The plugins we would write (all planned)

- A hard-rule plugin (planned). It runs inside the orchestrator session and blocks: edit and write tools whose target is outside `.plans/`; shell writes into the repository (redirects, `sed -i`, `tee`, and the destructive commands the worker guard already lists); and vault writes except through `vault.mjs`. The exact blocks of spec R3 are the contract. The user's decision is that the hard rule is enforced by a plugin here, not by rule text alone; the probe found no package named for a guard, hook or permission policy, so this is our own plugin, and whether a dsh plugin can block a tool call at all was not measured.
- A plan-auditor bridge (planned). It runs headless `claude -p` with the `plan-auditor` agent file, passes the plan path, spec path, trace id, plan id, plan round and audit round, and returns the findings and the verdict to the orchestrator session. Whether headless `claude -p` can run the agent file from `~/.claude/agents/` was not measured.
- The monitor plugin, Phase 3 (planned). A dsh web-client plugin ported from the Bun monitor's TypeScript server logic and React client in `monitor/`, reading the same `.plans/` files, so the Wails app in `monitor-app/` and the Bun monitor can be retired once it matches them.

### Plugin policy

Official `@deepseek-ai` packages and our own plugins are the default. Community plugins are allowed only after the orchestrator reads the plugin's source and reports to the user before anything is installed. Every plugin is pinned to a version, because dsh is a developer preview with compatibility-breaking changes expected between release candidates.

### Credentials

The OpenCode Go key reaches dsh only through an `apiKeyEnv` credential reference on the route, or through dsh's own stored sign-in. It never appears in a repository, in a plan, in a spec, in a trace or in a worker's environment. A reference that resolves to nothing fails with `MISSING_CREDENTIAL`, which is the intended fail-closed behavior. The vault repo modes still decide which repositories may send text to a model, and the decider's existing privacy gate stays in front of any text it sends.

### The worker adapter shape for `agent: "dsh"` (planned)

The adapter contract in `pi-plan-dispatch/adapters/types.ts` is types only, so it can be implemented without touching the dispatcher. Its members are: `AgentEvent`, the normalised event union with `kind` `tool_start`, `tool_end`, `assistant_end`, `plain` and `progress`; `AgentSessionRef` (`id`, `dir`, optional `file`); `WorkerRunSpec` (`model`, `thinking`, `tools`, `prompt`, optional `session`, `name`); `SessionRequest` (`cwd`, `planId`, `taskId`, `attempt`); and `AgentAdapter` with `name`, `command`, `workerArgs`, `smokeArgs`, `parseLine`, `sessionFor`, `findSessionFile`, `retireSession` and `resumeCommand`.

A planned dsh adapter would fill those members like this:

- `command` and `workerArgs`: the `headless` profile, one task per run, with `--json` so the run events are newline-delimited.
- `parseLine`: normalise dsh's `--json` events to the `AgentEvent` kinds above. The probe did not measure the real event shapes or their names, or whether tool calls, usage and cost appear in them, so this mapping is Phase 2 work against recorded streams.
- `sessionFor`, `findSessionFile`, `retireSession`, `resumeCommand`: map a task attempt to a dsh session id and resume it with `--session-id`; an unknown id is an error in dsh, and session files on disk and resumption were not measured.
- `thinking`: map `WorkerRunSpec.thinking` onto whatever dsh's model plugin accepts; the mapping was not measured.
- The live guard for dsh workers is a plugin, because dsh has no guard package and the Pi guard is a Pi `tool_call` handler. The guard policy itself (limit edits to the task's `files:`, deny paths outside the repo, under `.git/` or under `.plans/`, block destructive shell commands) is already pure logic in `pi-plan-dispatch/guard.ts` and can be reused.

The adapter is registered beside `pi` and the waiting `omp` entry in `pi-plan-dispatch/adapters/index.ts`; `getAdapter` and `knownAgents` already key off the registry, so `agent: "dsh"` is a registry entry plus the adapter module.

### What stays unchanged

The plan and spec formats, the dispatcher and its scheduling, the deterministic gate, the `verify:` commands, the worker live guards for Pi, the traces, the vault and its CLI, the fix-round limits, and Claude Code as a front end with Sonnet 5.5 as orchestrator and Opus 5.5 as auditor. Nothing is removed when dsh joins: Pi stays, and the `omp` adapter stays on the list but waits.

## Phases

The phases are ordered. Each one ends with a test that can be run, and each can later become its own spec. Phase 0 settles the unmeasured points of the probe before any of them is built on. Nothing here starts until the user approves its spec.

### Phase 0

Goal: replace the probe's open points with measured facts, using one supplied OpenCode Go key in a scratch folder outside the repository. The probe recorded what could be learned without a key; this phase makes one model call possible and answers the questions the later phases depend on.

Work:

- Pin the package at the probed version, `@deepseek-ai/dsh@0.2.1-rc.5`, install it with `--ignore-scripts` into a scratch folder, and point `DSH_HOME` at another scratch folder. Record the exact version and install method in the probe record, because the package is a developer preview.
- Run one supplied-key `headless` run on an OpenCode Go route for `deepseek-v4-pro`, and record the result. Check specifically for the reported 400 caused by the missing `x-opencode-session` header (the pi-ai SDK reportedly never sends it, and the `omp` probe in [docs/omp-probe.md](omp-probe.md) hit the same 400 with another Pi-family agent). If the 400 appears, try the likely fix: declare the route in the profile's `providers` dictionary with the `x-opencode-session` header set, and record whether the run then succeeds.
- Capture the real `--json` run events: their names and shapes, and whether tool calls, usage and cost appear in them. Capture the session files on disk and how a session resumes with `--session-id`, including what an unknown id does.
- Check cost reporting: what the run prints or stores, and whether it matches the OpenCode Go prices for the chosen model.
- Run headless `claude -p` against the `plan-auditor` agent file and confirm it can be selected and returns findings and a verdict. This is the audit bridge's single most important dependency.
- Test whether a dsh plugin can block a tool call at all: write a throwaway plugin in the scratch folder that refuses one tool name, and record whether the call is stopped or merely observed. The hard-rule plugin depends on this answer.
- Test the instruction load: whether `AGENTS.md` is read from the working folder, what wins between `AGENTS.md` and `CLAUDE.md`, and whether a nested folder's file is read. Record it against a tiny scratch folder.
- Test the other subscriptions the user names in the open questions (for example ChatGPT or Codex, Copilot, Gemini), each with one read-only run if the user wants it, and record which ones need an API key and which need a sign-in.

Exit test: `docs/dsh-probe.md` is extended with a dated "live probe" appendix, and every bullet above has a recorded command, the observed output, and a pass or fail line. A reader can rerun each command against the pinned version and expect the same line.

Files touched: `docs/dsh-probe.md` only. Every scratch file and the installed package stay outside the repository.

### Phase 1

Goal: use dsh as the front end on this Mac, for one small real request, with the same backend and the same Opus audit as Claude Code.

Work:

- Write `AGENTS.md` (planned) from the rules block in `dispatch-plan/ORCHESTRATOR.md`, with a dsh orchestrator identity and per-device CLI paths that do not assume `~/.claude/skills/dispatch-plan/`.
- Rewrite `dispatch-plan/SKILL.md` and the `grilling` skill once in dsh's own skill format (planned copies under a dsh skill folder in this repository), keeping the spec and plan formats, the atomic draft and flip, the audit, wait and gate steps, the trace events, the fix-round limits and the vault procedure.
- Write the hard-rule plugin (planned): block the orchestrator's edit and write tools outside `.plans/`, block shell writes into the repository, and block vault writes except through `vault.mjs`. It reuses the policy shape of `pi-plan-dispatch/guard.ts`. Its feasibility depends on Phase 0's tool-block test.
- Write the plan-auditor bridge (planned): run headless `claude -p` with the unchanged `dispatch-plan/agents/plan-auditor.md`, pass the plan path, spec path, trace id, plan id, plan round and audit round, and return findings and verdict. It logs nothing itself; the auditor agent keeps logging `plan.audit`.
- Write the custom dsh profile (planned) that mounts our plugins and the rewritten skills on top of the `headless` composition, declares the OpenCode Go route with its `apiKeyEnv` reference, and sets `opencode-go/deepseek-v4-pro` as the orchestrator model.
- Write the install steps for a new device (planned section of the dsh setup document): install Claude Code and log in for the audit, install dsh at the pinned version, install the CLIs, set the key's environment reference, and copy the skills and plugins.
- Keep the background-wait rule: `trace.mjs wait` runs as a dsh background command, and the session is re-invoked on its exit codes; where dsh has no notification equivalent, the orchestrator reports in the session and `PushNotification` is dropped.

Exit test: one small real request is run from dsh on this Mac, from spec to a passing gate, with Pi workers and an Opus audit. Pass means `node dispatch-plan/trace.mjs gate --plan <id>` exits `0`, `node dispatch-plan/trace.mjs report --trace <T>` lists the Opus `plan.audit` round, and `node dispatch-plan/vault.mjs work pending --root <repo root>` no longer lists the trace.

Files touched: `AGENTS.md` (planned), the rewritten skills (planned), the plugins (planned), the custom profile (planned) and the setup document (planned). No backend file changes.

### Phase 2

Goal: add `dsh` as a third worker agent beside Pi, through the existing agent adapter, without removing Pi or the waiting `omp` entry.

Work:

- Record real dsh headless streams from Phase 0 and turn them into small JSON-lines fixtures (planned files under `pi-plan-dispatch/fixtures/agents/`), in the same style as the existing Pi and `omp` fixtures. Never copy a raw probe stream; write the fixture from the documented event shapes and check it against the recording.
- Write the dsh adapter (planned file `pi-plan-dispatch/adapters/dsh.ts`) against the contract in `pi-plan-dispatch/adapters/types.ts`: `command` and `workerArgs` use the `headless` profile with `--json`; `parseLine` maps dsh events to `AgentEvent` kinds `tool_start`, `tool_end`, `assistant_end`, `plain` and `progress`; `sessionFor`, `findSessionFile`, `retireSession` and `resumeCommand` map a task attempt to a dsh session id and resume with `--session-id`; `thinking` maps the request's level onto the dsh model plugin's setting.
- Register the adapter beside `pi` and `omp` in `pi-plan-dispatch/adapters/index.ts` (a registry entry, not a dispatcher change), and add its tests (planned file `pi-plan-dispatch/adapters/dsh.test.ts`).
- Write the live guard as a dsh plugin (planned), reusing the pure policy in `pi-plan-dispatch/guard.ts`: limit edits to the task's `files:`, deny paths outside the repo, under `.git/` or under `.plans/`, and block the listed destructive shell commands.
- Keep the worker environment rule: `PI_PLAN_DISPATCH_WORKER=1`, no vault access, no key in the worker's environment.

Exit test: one plan runs unchanged on Pi workers and again on dsh workers. Both runs must have the same gate result with all tasks done and zero error faults, and `node dispatch-plan/trace.mjs report --trace <T>` must show both in its Models table with comparable roles, tasks, tokens, cost and faults. Equal gate results are the pass condition; a difference is reported with its cause, not averaged away.

Files touched: `pi-plan-dispatch/adapters/index.ts`, the planned adapter and its planned test, the planned dsh fixtures, and the planned guard plugin. No change to `pi-plan-dispatch/core.ts` or `pi-plan-dispatch/index.ts`.

### Phase 3

Goal: host the monitor as a dsh web-client plugin, ported from the Bun monitor in `monitor/`, reading the same `.plans/` files and writing nothing.

Work:

- Port the TypeScript server logic in `monitor/src/server/` (plans, lanes, state, sessions, watch, decider, repos, http) into the plugin's server side (planned), keeping the read-only rule and the 500 ms change poll with its change notification.
- Reuse the React 19 client in `monitor/src/client/` (board, repo sections, lane cells, transcript, formatting, styles) as the plugin's view (planned), so the two looks stay the same during the transition.
- Keep the same data: repos, plans, tasks, implementer and reviewer lanes, attempts, decider suggestions, gate, task and session transcripts, and live updates.
- Do not port the container packaging, the static server or the Host-header guard from `monitor/README.md`; the dsh web client owns the transport, and the plugin still refuses writes and bounds the repo count.

Exit test: the plugin is opened in the dsh web client against a fixture plans tree and against one real repository, and each row is compared with the Bun monitor on the same tree. The automated check is a parity test (planned) that runs the existing `monitor/` fixture tests and the plugin's equivalent and finds the same board state; the manual check opens both screens side by side.

Files touched: new plugin files (planned) only. `monitor/` and `monitor-app/` stay unchanged in this phase.

### Phase 4

Goal: retire the Wails app in `monitor-app/` and the Bun monitor in `monitor/` once the dsh plugin matches them, and drop the planned Wails v3 migration.

Work:

- Work through a parity checklist of what the monitors show today, taken from `monitor-app/README.md` and the sources in `monitor/`:
  - the repo list, its naming and ordering, the 24-repo cap, and a missing repo shown with its own message;
  - one plan per repo, `running/` before the latest finished plan, idle repos collapsed and active ones expanded;
  - the plan header with id, state, done and total task count and the gate;
  - one task row in plan order with role, waits-for note and skipped badge;
  - implementer and reviewer lanes side by side, with a dash when there is no pair;
  - lane state badges, attempt labels and attempt switching, model, elapsed time, tokens, cost and last tool line, plus reviewer verdict and findings count and the failed-review badge;
  - the decider's effort suggestion next to what ran, and the decider audit proposal in the plan header with per-finding values;
  - the shared live transcript with auto-follow, the "no output yet" and error states, and the stalled marker;
  - code blocks as diff, file body or command, with language highlighting and the plain-text fallbacks;
  - live updates on a 500 ms poll-driven change event;
  - the read-only rule, loopback-only access, the 403 and 405 guards and the read-only mounts;
  - the Wails app's Settings panel with the omp and Pi session toggles, the added-repos and all-sessions scope, and the read-only agent session views, or a recorded decision to drop them;
  - the golden-file parity test and the client tests, or their dsh equivalents.
- Delete the retired folders in the same change that removes their last use, and record that the planned Wails v3 migration is dropped; remove any line that still proposes it.
- Leave the `.plans/` files, the traces and the session folders untouched; the plugin only reads them.

Exit test: every checklist item is ticked in the plugin or has a written user decision to drop it, the plugin passes the parity and client tests, and `git grep` finds no remaining reference to `monitor-app/` or `monitor/` outside the history and the archived notes. The Wails v3 migration no longer appears in any roadmap.

Files touched: removes `monitor-app/` and `monitor/`, edits any document that still proposes the Wails v3 migration, and touches the planned plugin.

## Risks

| Risk | What it would break | Mitigation |
| --- | --- | --- |
| The OpenCode Go 400 for a pi-ai route, the unmeasured missing `x-opencode-session` header | Every dsh model call on OpenCode Go fails before the front end works, and the orchestrator cannot run at all | Phase 0 tests the route first and tries the likely fix of declaring the route with that header; until it passes, dsh stays a probe and Claude Code stays the only front end |
| A developer preview with compatibility-breaking changes between release candidates | A dsh upgrade silently changes the `--json` events, the profile schema or the plugin API, and the adapter or plugins break | Pin the exact version (`0.2.1-rc.5` at the probe), record the version in each probe and adapter note, upgrade only with a recorded rerun, and keep the Pi front end as the fallback |
| The 840 MB install and 618 packages on a small dev box | A work laptop or a small virtual machine may not fit dsh beside Claude Code, Pi and the monitors | Measure disk and memory in Phase 0, keep the install in a scratch folder for the probe, and choose the device and the workspace in the open questions before Phase 1 |
| Supply chain: wrong-name packages, community plugins, `--ignore-scripts` and what it breaks | Installing `dsh` by a guessed name installs an unrelated shell, and a community plugin or a skipped install script can run or omit arbitrary code | Use only the scoped `@deepseek-ai/dsh`; read a community plugin's source and report before installing it; pin versions; record what `--ignore-scripts` skipped in the probe and retest with scripts only in a disposable folder |
| A DeepSeek orchestrator writing weaker specs and plans than Sonnet | More audit rounds, more blockers and majors, and a slower path from request to a passing gate | The audit stays Opus 5.5, the fix-round cap of 3 stays, and the measurement plan compares audit findings and rounds with the Sonnet runs on record before the model is kept |
| The dependency on Claude Code being installed and signed in on every dsh device for the audit step | A dsh device without Claude Code cannot audit a plan, so no plan can be flipped to ready there | Make the dependency explicit in the install steps and in the check before a request starts; keep the audit as the only Claude step; a missing login stops the request rather than skipping the audit |
| The terms of headless `claude -p` use under the user's subscription | The audit bridge could break the subscription's terms, or stop working without notice | Check Anthropic's current terms before relying on it, keep the use to one read-only audit step per plan, and record the answer; Claude Code itself remains the supported path |
| Long-session request limits, with the limits table's counts as estimates and peak pricing | A long orchestrator session can exhaust the 5-hour or weekly request count, and peak-hour prices can be double the off-peak ones, as the table shows for the DeepSeek models | Measure real requests and cost per session against the limits table, prefer the model with the highest count for long sessions, and start a new session or switch model at a measured threshold rather than by guess |
| No known guard or hook API in dsh | The hard rule and the worker live guard cannot be enforced, and the orchestrator or a worker could edit the repository | Phase 0's tool-block test decides this; if a plugin cannot block a call, the rule stays text only plus the git evidence and the gate, and the user decides whether that is acceptable |
| In-process dsh subagents against our isolated headless workers | A dsh subagent shares the orchestrator's process and context, so it cannot be isolated, guarded or resumed like a headless worker, and the adapter's session model does not fit it | Keep workers headless, one process and one session per task attempt, and do not use `dsh-tool-subagent` or `dsh-tool-workflow` for plan tasks |
| The skill format difference | `dispatch-plan/SKILL.md` and the `grilling` skill cannot be copied as they are, so a partial rewrite loses a step or a rule | Rewrite once in dsh's format in Phase 1, diff the steps against the Claude Code skill, and keep one source of truth for the rules text in `dispatch-plan/ORCHESTRATOR.md` |
| The user's work repos and their network rules, with the vault repo modes deciding which repos may send text | A `meta` or `none` repo could leak a name or text to a model, or a work network could block OpenCode Go or the Claude endpoint | Keep the vault repo modes as the gate, keep the decider's privacy check, and settle the work repos and their network rules in the open questions before any work request runs from dsh |

## Open questions

- Which other subscriptions does the user have (ChatGPT or Codex, Copilot, Gemini), and should each be tested in the Phase 0 live probe? The answer sets the routes a dsh profile may declare and the models the measurement plan can compare.
- Which work repositories will use dsh, and which network rules apply there? This decides whether OpenCode Go and the Claude audit endpoint are reachable, and which vault repo modes apply.
- Where does the front end run: this Mac, or a dev box reached through Rex? The answer changes the install steps, the key's storage and the latency of the headless audit.
- Does Claude Code stay installed on every device, only for the audit step, or is there a device that will not have it? Without it there is no Opus audit on that device.
- When should Phase 4 run: immediately after the monitor plugin reaches parity, or after a period of both monitors running side by side? The user decides the timing, and the roadmap does not.

## Measurement plan

The comparison unit is the Models table that `node dispatch-plan/trace.mjs report --trace <T>` writes, plus the Plan audit, Rounds and Faults tables of the same report. Each item below names what is compared and what would count as a difference worth acting on.

- Replay two or three past requests with a DeepSeek orchestrator. Take requests whose Sonnet specs, plans, audit findings, rounds and cost are on record, replay the spec and plan work from dsh with `opencode-go/deepseek-v4-pro` (and, if the user wants, `mimo-v2.6-pro` and `glm-5.2`), and compare plan-audit blockers and majors, rounds to a clean audit, and cost. A comparison that needs more than the fix-round cap, or a repeated blocker the Sonnet run did not have, is a failure of the hypothesis, not a rounding difference.
- Replay the recorded Opus audit findings against a DeepSeek auditor. Feed the same plan and spec to a DeepSeek auditor and check which of the recorded findings it reproduces, which it misses and which it invents. The reference is the recorded `plan.audit` events in `.plans/traces/`; the result decides whether the auditor can ever move off Opus.
- Measure real requests per session against the limits table. For a set of real orchestrator sessions, count the requests and the cost shown by `trace.mjs report` and compare them with the OpenCode Go table's per-5-hour, weekly and monthly counts. The table's figures are estimates for typical usage, so the measured count per session is the number to plan with.
- Run one plan on Pi workers and on dsh workers. Use the same plan id and the same model, once with the Pi adapter and once with the dsh adapter, and compare gate pass rate, rounds, faults, tokens and cost in the Models table. Equal gate results are the baseline; any difference is reported with its fault codes and the task it came from.

All four comparisons use the same report and the same tables, so the results can be read side by side and kept with the trace they came from.
