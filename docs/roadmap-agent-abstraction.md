# Roadmap: abstracting the worker from Pi

Companion to `docs/omp-probe.md`, which holds the dated evidence that this roadmap rests on.
The roadmap is a plan for later specs, not a commitment to build them in this order or at all.

## Goal and non-goals

Today every worker is the Pi coding agent. The dispatcher builds a `pi` command line, reads Pi's
JSON event stream, stores Pi session files, installs a guard as a Pi extension and reasons in Pi's
thinking levels. The user wants that whole workflow abstracted, so another coding agent can do the
work behind the same plan, gate, trace and vault contract.

The first other agent is `omp` (oh my pi), a community fork of Pi installed on this machine and
logged in with the OpenCode Go subscription. The reasons are a better experience and better
results; the cost and quality of each agent can then be compared on the same tasks. Claude Code
stays the front end for now: it is the one front end that uses the Claude subscription officially,
and the user talks to it directly.

The longer-term direction, written in its own section for a later stage of this roadmap, is an
automated and unattended workflow for almost all of the user's codebases, running on its own dev
box. That makes the workflow the backend and the front end interchangeable: the contract between
the two is the files under `.plans/` and the small CLIs, not a particular chat application.

This roadmap does not:

- change any code, test or config, including `piCommand`, the roles config and the dispatcher;
- start Phase 0, or run a model call against `omp` or `pi` to gather more evidence;
- fix the HTTP 400 that stops `omp` today;
- treat Claude Code as a worker agent, which is only mentioned as a later option.

One task stays one agent run. An agent does not fan out its own subagents inside a task, because
that would bypass per-task `files:`, the live guard, `verify:`, retries and the evidence the gate
reads. The dispatcher stays the scheduler.

## Coupling inventory

Every place below was found by reading the code at the time of this roadmap. Paths are
repository-relative; line numbers are approximate and will drift as the files change.

| Place | File and function | What assumes Pi | What would become agent-specific |
|---|---|---|---|
| Worker spawn | `pi-plan-dispatch/core.ts`, `runWorker`, around line 976; the config field `piCommand` around line 117 and its default `"pi"` around line 162 | The worker is an executable named by `piCommand` and started with `--mode json -p`, `--session-id`, `--session-dir`, `--name`, `--no-session`, `--model`, `--thinking`, `--tools`, then the prompt as the last argument | The argument list for a run, including which of those flags exist and how the prompt is passed |
| Smoke test | `pi-plan-dispatch/core.ts`, `smokeTestModel`, around line 1170 | It uses the same `piCommand` with `--mode json -p --no-session --model ... --thinking ...`, a fixed prompt and a 90 second timeout | The smallest real call for the agent, how it reports success and how a wrong model or level shows up |
| Event parsing | `pi-plan-dispatch/core.ts`, `createWorkerStream`, around line 839 | It reads Pi's line-delimited JSON: `tool_execution_start` and `tool_execution_end` for the tool record, `message_end` of an assistant message for text, `usage.input`, `usage.output`, `usage.totalTokens`, `usage.cost.total`, `stopReason` and `errorMessage`; plain stdout text is kept as an error hint | A normalised event layer per agent, so the dispatcher sees one event shape whatever the agent prints |
| Named sessions and resume | `pi-plan-dispatch/core.ts`, `sessionFor` around line 728, `resumeCommand` around line 708, `retireSession` and `findSessionFile` beside them | A session is a Pi session id plus a directory, opened with `--session-id` and named with `--name`; the file is found by the `_<id>.jsonl` suffix; the resume command is a literal `pi --session <id> --session-dir <dir>` | Where the agent keeps sessions, how a run is given a name and reopened, and the human resume command |
| Worker environment | `pi-plan-dispatch/core.ts`, `workerEnv`, around line 959, and `withVaultEnv` above it | The child is a Pi process, so `PI_PLAN_DISPATCH_WORKER=1` stops the dispatcher extension from starting a second watcher inside it, and `PI_PLAN_DISPATCH_GUARD` carries the guard policy to a Pi extension | How a given agent is told it is a worker, and how it receives (or refuses) the guard policy |
| Live guard registration | `pi-plan-dispatch/index.ts`, around line 960, inside the extension's setup: `pi.on("tool_call", ...)` when `isWorker()` is true | The guard is a Pi extension callback keyed on Pi's `tool_call` event, reading the policy from `PI_PLAN_DISPATCH_GUARD`; the event carries `toolName` and `input` | How the guard is installed in each agent: Pi extension, `omp -e` or `--hook`, or a wrapper, and how a blocked call is reported back |
| Guard policy | `pi-plan-dispatch/guard.ts`, `policyFromEnv` around line 342 and `checkToolCall` around line 402 | Tool names and arguments follow Pi's conventions (`edit`/`write`/`patch`, `bash`/`shell`, `path`, `file_path`, `filePath`, `file`); the block reason is a returned object with `block` and `reason` | A mapping from the agent's tool names and argument keys onto the policy, and from the decision onto that agent's block mechanism |
| Extension lifecycle and watcher | `pi-plan-dispatch/index.ts`, `pi.on("session_start", ...)` around line 971 and `pi.on("session_shutdown", ...)` around line 984 | The dispatcher itself is a Pi extension on the orchestrator side: it gets `ctx.cwd` from Pi, watches `.plans/inbox/`, renders a widget and aborts on shutdown | Nothing for a worker adapter; the dispatcher stays a Pi extension. Only the worker side of these hooks is agent-specific |
| Thinking levels in resolution | `pi-plan-dispatch/core.ts`, `resolveModel` around line 317 and `resolveThinking` around line 351; `RoleConfig` around line 22 | A task's level is a Pi `--thinking` value; an empty level means "pass no flag"; precedence is task, role, plan, config | The ladder an agent accepts, and the mapping from the dispatcher ladder to it |
| Thinking ladder and escalation | `pi-plan-dispatch/decider/effort.ts`, `LADDER` at line 17 and `escalateLevel` around line 125; `suggestEffort` in the same file | The ladder is `low`, `high`, `max`, and a retry steps up that ladder; the decider's criteria are written in those three levels | The per-agent ladder and the cap when the agent has no level as high as `max` |
| Transient error text | `pi-plan-dispatch/resilience.ts`, `classifyError` around line 86 with `PERMANENT_PATTERNS`, `TRANSIENT_PATTERNS`, `STATUS_CODE_RE` and `TRANSIENT_EXACT` above it | The text Pi and its providers print (`ECONNRESET`, `429`, `stream ended without finish_reason`, `terminated`) is what decides transient versus permanent, and a transient error resumes the same session | A per-agent error vocabulary, or a normalised error classification the adapter fills in |
| Session transcript in the monitor | `monitor/src/server/sessions.ts`, `parseSessionLines` around line 178 and `summarizeSession` around line 286 | A JSONL file with `session`, `session_info`, `model_change` (`modelId`), `thinking_level_change` (`thinkingLevel`) and `message` lines, with Pi's `message.usage` | Reading each agent's session format, including `omp`'s single `model` field and its absent `session_info` line |
| Session transcript in the Go app | `monitor-app/internal/sessions/sessions.go`, `ParseSessionLines` around line 305 and `SummarizeSession` around line 593 | The same Pi rules, ported with golden-file parity against the Bun server | The same per-agent session reading, kept in parity with the TypeScript monitor |
| Model ids and catalog | `pi-plan-dispatch/core.ts`, `DEFAULT_CONFIG` around line 160 and `DEFAULT_ROLES` around line 32; `pi-plan-dispatch/decider/config.ts` | Model ids are Pi catalog ids, and the price and context figures quoted in the docs are Pi's; `omp --list-models` shows different metadata for the same id | Per-agent model catalog and metadata, and which ids are valid for a role on that agent |
| Wording in the docs and rules | `docs/roles.md` ("Pi's catalog values", the default roles table), `pi-plan-dispatch/README.md` (session, resume and guard sections), `CLAUDE.md` (Layout, settled decisions, open questions) | The documentation describes Pi as the only worker and speaks of "Pi sessions" and "a Pi extension" | A neutral description of the worker, with the agent-specific facts moved into the adapter documentation |

Two notes on scope. First, the `monitor-app/` row exists only because that folder exists in the
repository now; if it were removed, the Bun monitor row would stand alone. Second, the coupling
above is about the worker side of the dispatcher. The plan format, the trace events and the gate
already avoid naming Pi, so they need no adapter.

## Target design

The design is one adapter per agent behind a small interface, plus one new optional config field.
Nothing in a plan changes: a plan still names roles, never agents and never models.

### The agent adapter

An adapter answers the same seven questions for every agent. The dispatcher calls it in place of
the Pi-specific code listed in the inventory.

- **Argument list for a worker run.** Given the model, the thinking level already mapped to the
  agent's vocabulary, the tools list, the prompt and the session choice, the adapter returns the
  executable and the argument vector. For Pi this reproduces today's list exactly; for `omp` it
  drops `--session-id` and `--name`, which `omp --help` does not list, and uses `--session-dir`
  or `-c`/`-r` as the session mechanism allows.
- **Event normalisation.** The adapter reads the agent's stdout and emits the events the
  dispatcher already consumes: a tool start and a tool end with a tool name and a result, an
  assistant message end with text, usage, cost and stop reason, and a plain-text fallback. The
  dispatcher's stream handler and the stall watchdog work on the normalised events only. For `omp`
  this means mapping its envelope (`session`, `agent_start`, `turn_start`, `message_start`,
  `message_end`, `turn_end`, `agent_end`) and treating `auto_retry_start`/`auto_retry_end` as
  progress or as a retry notice rather than as a fault. The tool events themselves are not yet
  measured on `omp`, so this mapping stays unverified until a successful run exists.
- **Session location and format.** The adapter says where sessions live (`.plans/sessions/<plan>/`
  stays the dispatcher-side location), what a session file is called, how it is opened by id, and
  how a reader should interpret it. Pi uses `session`, `session_info`, `model_change` with
  `modelId` and `thinking_level_change` with `thinkingLevel`; `omp` uses `model_change` with a
  single `model` field, also writes `thinking_level_change`, has no `session_info` line, and its
  message lines carry `id`, `parentId`, `timestamp` and a `message` object.
- **Thinking-level mapping.** The adapter maps the dispatcher ladder onto the agent's accepted
  values and says what happens when a level has no equivalent. The table below is the proposal.
  A mapping that raises or lowers a role's effort is a cost and quality decision, so it belongs in
  the adapter's documentation and in a test, not in a hidden default.
- **Guard installation.** The adapter installs the same policy (owned `files:`, no destructive
  shell, read-only roles, no vault path, nothing under `.git/` or `.plans/`) through whatever the
  agent offers. For Pi that is the extension callback on `tool_call`. For `omp` the probe saw
  `-e`/`--extension`, `--hook` and `--no-extensions`, but the Pi extension `pi-vim` failed to load
  inside `omp`, so a Pi extension is not assumed portable. A blocked call must still produce a
  tool result starting with `BLOCKED by pi-plan-dispatch:` so the existing `blocked_action`
  warning keeps working.
- **Smoke test.** The adapter supplies the smallest real call for one model and thinking level,
  the prompt, and the success rule. Today the Pi smoke test accepts any assistant reply; the same
  rule should hold for every agent, and the failure text should name the agent, not Pi.
- **Resume.** The adapter reopens a session and says how. Pi uses a session id and directory;
  `omp` needs a different mechanism because it has no `--session-id`. The human-facing resume
  command in the task report comes from the adapter too.

### Thinking ladder

The dispatcher ladder is `low`, `high`, `max`. Pi accepts `off`, `minimal`, `low`, `medium`,
`high`, `xhigh`, `max`; `omp --help` lists `minimal`, `low`, `medium`, `high`, `xhigh`.

| Dispatcher ladder | Pi flag | `omp` flag |
|---|---|---|
| `low` | `--thinking low` | `--thinking low` |
| `high` | `--thinking high` | `--thinking high` |
| `max` | `--thinking max` | no equivalent; proposal: `xhigh`, or refuse the task and report it |

`max` is the one gap. The proposal is to map it to `xhigh` and record both the requested and the
actual level in the trace, so a `max` task on `omp` is visibly weaker and the comparison in the
measurement plan stays honest. Refusing the task is the conservative alternative; either way the
adapter decides once rather than each caller guessing.

### Roles gain an optional `agent` field

`.plans/config.json` gets one new field: a role may set `agent`, and the default is `pi`.

```json
{
  "roles": {
    "implement": { "agent": "pi" },
    "review": { "agent": "omp" }
  }
}
```

Resolution follows the existing order: the task's role, then the config defaults for that role,
with `agent` defaulting to `pi`. A user entry overrides only the fields it sets, as it does today.
A plan never names an agent; it names a role, so moving a role to `omp` is a config edit, just as
moving it to another model is today. This also means an existing config keeps running on Pi with
no change, and Phase 2 of the roadmap can prove that by leaving the tests untouched.

The per-task `model:` and `thinking:` lines keep their meaning inside the chosen agent's catalog.
An id that does not exist on that agent fails the smoke test, not a plan mid-run.

### What stays unchanged

- **Plans.** The frontmatter, the `files:` list, `verify:`, `role:`, `pair:` and the draft-to-ready
  flip are untouched. A plan does not learn about agents.
- **The gate.** It still passes only when every task is done and there is no error fault, and it
  still reads the dispatcher's evidence, not the worker's claims.
- **The vault.** Workers still have no vault access, and the orchestrator still writes the vault
  only through `dispatch-plan/vault.mjs`. The worker environment keeps removing `AGENT_VAULT`.
- **The spec flow.** Clarify, spec, plan, audit, approval, run, gate and report stay the same; the
  agent is invisible to the orchestrator except in the trace and the cost report.

## Phases

Each phase is a candidate spec of its own. Phase 0 is a prerequisite, not an implementation phase:
the work it names happens outside this repository. Phase 1 must not change behaviour, so it can be
tested against today's output. Phases 3 and later are blocked on Phase 0 for `omp`; Phases 1, 2, 4
and 5 can proceed on Pi alone while Phase 0 is unresolved.

### Phase 0

**Goal.** Make `omp` finish one run through OpenCode Go. Today every run ends with a 400,
`Request is missing x-opencode-session and cannot be routed efficiently`, type `MissingSessionID`,
and the assistant message has no content and `stopReason: "error"`. The retry with a real session
folder produced the same 400, so the cause is the missing header, not `--no-session`.

**Work.** Choose one of these four routes and record the choice with its evidence. Each route is
tested by the same two read-only prompts the probe used, never by a call this repository makes.

- **A provider setting in `omp`.** `omp`'s own config, `~/.omp/agent/config.yml` on this machine,
  may accept extra headers for a provider. Cost: an hour or two of reading `omp`'s docs and
  config schema, no repository change. Test: add the header there, then run the two probe prompts
  with `--mode json -p` and confirm a non-error assistant message with text `READY`, and the
  first line of `README.md` for the second prompt.
- **An upstream report or fix.** Open an issue or a pull request in `omp`'s own repository, since
  `omp` is a community fork of Pi. Cost: waiting for a release plus the maintainer's review; no
  local code, but no date either. Test: install the release that contains the fix and run the two
  probe prompts; until then this route leaves the phase open.
- **A thin proxy that adds the header.** Put a local HTTP proxy in front of the OpenCode Go
  endpoint and point `omp`'s provider base URL at it, so the proxy adds `x-opencode-session`.
  Cost: a new service to write, run and keep patched, plus a secret it must hold, and one more
  hop that can fail; this is the route with the most moving parts. Test: run the proxy, point
  `omp` at it and run both probe prompts; also confirm the header reaches the gateway by logging
  it at the proxy.
- **Another `omp` provider.** Use a provider `omp` already reaches without that header, such as a
  provider configured directly in `omp`. Cost: a different model and possibly a different
  subscription, so the comparison with Pi no longer holds for the same model, and the result
  answers "can `omp` run at all", not "can `omp` run DeepSeek through OpenCode Go". Test: run both
  probe prompts against that provider and record the model id and the provider in the evidence.

**Exit test.** The two read-only prompts of the probe succeed on `omp` through OpenCode Go, and a
re-run of `omp --version` and `omp --list-models` is recorded beside them:

```sh
PI_PLAN_DISPATCH_WORKER=1 omp --mode json -p --no-session \
  --model opencode-go/deepseek-v4.1-flash --thinking low --tools read \
  "Reply with exactly the word READY and nothing else."
```

The run passes when the stream holds an assistant message with text `READY`, `stopReason` other
than `error`, and no `errorStatus: 400`; the second prompt must return the first line of
`README.md`. Record the full stream as evidence, because the tool events of a real reply are what
Phase 3 needs and the probe could not observe them.

**Files touched.** None in this repository. The change is in `~/.omp/agent/config.yml`, in
`omp`'s own repository, or in a proxy repository outside this one; if an option is recorded in
this repo, it is the roadmap's own evidence file, `docs/omp-probe.md` or its successor.

### Phase 1

**Goal.** Record real Pi streams as fixtures and add a normalised event layer to the dispatcher,
with no behaviour change.

**Work.** Capture the JSON streams already used by the tests and by a real worker run, for text,
a tool call, an error and a retry. Add the normalised event types the adapter will emit (tool
start, tool end, assistant message end with usage and cost, plain-text fallback) and translate
Pi's current events into them inside the dispatcher. Every consumer of the stream, including the
stall watchdog, reads the normalised events. The Pi path produces the same plan results as before.

**Exit test.** `cd pi-plan-dispatch && npm test` passes with the existing tests unchanged, and a
dry run of a small plan produces the same `_summary.md` gate line as a run from before the change.

**Files touched.** `pi-plan-dispatch/core.ts`, `pi-plan-dispatch/trace.ts` if the event types live
there, the new adapter module and its tests, and new fixtures under `pi-plan-dispatch/fixtures/`
(planned).

### Phase 2

**Goal.** Add the optional `agent` field to roles and a Pi adapter that reproduces today's
behaviour exactly.

**Work.** Add `agent` to the role config, defaulting to `pi`, and resolve it in the existing order
(task role, role config, plan, defaults). Move the Pi-specific spawn, event parsing, session,
thinking, guard and smoke-test code behind the adapter interface. The Pi adapter emits the same
arguments, the same normalised events and the same session paths as today.

**Exit test.** `cd pi-plan-dispatch && npm test` passes with no test file edited, a plan with no
`agent` field runs on Pi, and `docs/` still describes Pi as the default worker.

**Files touched.** `pi-plan-dispatch/core.ts`, `pi-plan-dispatch/index.ts`,
`pi-plan-dispatch/guard.ts`, the new `pi-plan-dispatch/adapters/pi.ts` (planned), the config and
role parsing, and their tests.

### Phase 3

**Goal.** Add the `omp` adapter: flags, thinking mapping, guard through `-e` or `--hook`, and
session handling without `--session-id`. Try it first on one read-only role.

**Work.** Build the argument list from `omp`'s real flags, which include `--mode`, `-p`,
`--session-dir`, `--no-session`, `--model`, `--thinking`, `--tools` and `-e`, and which lack
`--session-id` and `--name`. Map `low` and `high` directly and decide the `max` case (proposal:
`xhigh`, recorded in the trace as requested and actual). Install the guard through `omp`'s
extension or hook mechanism, after checking that a minimal extension loads, since `pi-vim` did not.
Point a read-only role, such as the plan reviewer or the security role, at `omp` in the config and
run one small plan.

**Exit test.** A one-task read-only plan whose role resolves to `omp` passes the gate, its task
report carries the `omp` resume command and its trace carries the agent and both thinking levels;
the same plan on Pi produces the same verdict.

**Files touched.** The new `pi-plan-dispatch/adapters/omp.ts` and its guard module (planned),
`pi-plan-dispatch/core.ts`, `pi-plan-dispatch/index.ts`, and the adapter tests and fixtures.

**Blocked on Phase 0.** No `omp` run can pass until Phase 0 does.

### Phase 4

**Goal.** The monitor reads both session formats, in the Bun monitor and in the Go app.

**Work.** Teach both readers `omp`'s session lines: its `model_change` with a single `model`
field instead of `modelId`, its `thinking_level_change`, its `message` lines with `id`, `parentId`,
`timestamp` and a `message` object, and its missing `session_info` line. Keep the Go port in parity
with the TypeScript server through the existing golden files, and add an `omp` golden file.

**Exit test.** The monitor shows the same lanes and task rows for a recorded `omp` session as for
the equivalent Pi session, and the Go golden-file tests pass against the same inputs.

**Files touched.** `monitor/src/server/sessions.ts`, `monitor-app/internal/sessions/sessions.go`,
`monitor-app/internal/sessions/sessions_test.go`, the monitor's session tests and golden files,
and the React client only if a field is displayed that the server did not previously send.

**Blocked on Phase 0** for a recorded `omp` session; the reader work can start from the session
format the probe did observe.

### Phase 5

**Goal.** The trace and the report carry the `agent` and the cost per agent.

**Work.** Record the resolved agent on `task.start`, the reviewer agent on `task.review`, and the
agent in the plan's evidence. Extend the `Models` table of `trace.mjs report` so each row carries
the agent beside the model, and so cost and faults are grouped per agent as well as per model.
Older traces with no agent render as Pi, as the report already does for legacy events.

**Exit test.** `node ~/.claude/skills/dispatch-plan/trace.mjs report --trace <T>` on a plan that
ran tasks on two agents shows one row per agent and the per-agent cost, and a report on an old
trace is unchanged.

**Files touched.** `pi-plan-dispatch/trace.ts`, `dispatch-plan/trace.mjs`,
`dispatch-plan/decide-stats.mjs` if the per-agent join belongs there, and their tests.

**Blocked on Phase 0** for an `omp` row; the schema change itself is not.

### Phase 6

**Goal.** One more agent and a fallback when an agent is down.

**Work.** Add an adapter for the next chosen agent, using the interface Phase 2 settled. Add a
fallback rule: a role names a primary agent and an optional fallback, and a permanent failure or
an outage longer than the plan-level pause moves the task to the fallback once, with the agent
recorded in the trace. A fallback is a config edit made explicit, not an automatic model swap.

**Exit test.** An induced permanent failure on the primary agent runs the task on the fallback and
passes the gate, with both agents visible in the report; a config with no fallback fails the task
as it does today.

**Files touched.** A new `pi-plan-dispatch/adapters/<agent>.ts` (planned), `pi-plan-dispatch/core.ts`,
`pi-plan-dispatch/resilience.ts`, the role config and their tests.

**Blocked on Phase 0** only for a second `omp`-style agent whose provider is unresolved; a
fallback between Pi and a working agent needs Phase 3 first.

## Long-term direction

This section states the user's vision as a direction, not as commitments. The workflow should run
automated and unattended for almost all of the user's codebases, on its own dev box, an
always-on machine that is not the user's laptop. Each item below says what exists today, what is
missing, and which open question blocks it.

One task stays one agent run. An agent does not fan out its own subagents inside a task, because
that would bypass the per-task `files:` list, the live guard, `verify:`, the retry accounting and
the evidence the gate reads. The dispatcher stays the scheduler; an agent is a worker, not a second
scheduler.

### (a) The runner

- **Exists today.** The dispatcher is a Pi extension that watches `.plans/inbox/` from
  `session_start` and runs one plan at a time; it needs an open Pi window. `CLAUDE.md` already
  lists Phase 2 as a standalone worker.
- **Missing.** A dispatcher that runs with no Pi window, a plan queue with a claim state machine
  in the vault, and crash resume of a whole plan (today only one worker run is resumed, and a plan
  left in `running/` must be re-dropped).
- **Blocks it.** The Phase 2 scope question in `CLAUDE.md`'s open questions; the vault plan queue
  is designed against the standalone runner, so the two must be specified together.

### (b) Many repos on one box

- **Exists today.** The Go monitor app already shows several repos, and a plan runs in one repo
  at a time.
- **Missing.** One active plan per repo, a queue across repos, and a decision on isolation, since
  the shared checkout cannot host two plans editing the same repo at once.
- **Blocks it.** `CLAUDE.md`'s open question on per-task git worktrees, and the worktree decision
  has to be made before cross-repo scheduling is designed.

### (c) The front end

- **Exists today.** Claude Code is the orchestrator: it clarifies, plans, audits and asks for
  approval. It is the one front end that uses the Claude subscription officially. The contract is
  files under `.plans/` plus the small CLIs (`trace.mjs`, `preflight.mjs`, `decide.mjs`,
  `vault.mjs`), so a front end is replaceable in principle.
- **What any front end must provide.** Run shell commands; spawn a read-only plan auditor; start a
  run in the background and be woken or polled when it exits; read the gate with
  `trace.mjs gate`. Writing the spec, plan and trace is the minimum; the approval can be any
  channel that can say yes.
- **What is Claude Code specific today.** The Agent tool used to spawn the `plan-auditor`, the
  skills (`grilling`, `dispatch-plan`), and `PushNotification`. A second front end, including the
  user's DeepSeek harness, would have to supply equivalents.
- **Missing.** A written front-end contract (the four abilities above, as a checkable list) and a
  second implemented front end.
- **Blocks it.** The billing question below, and the user's decision on whether a second front end
  is worth building while Claude Code works.

### (d) Unattended safety

- **Exists today.** The live guard, `verify:`, preflight, the plan audit and the gate. The gate
  fails a plan when a task fails or an error fault is recorded.
- **Missing.** Cost caps per plan and per day, a kill switch that stops the box without a Pi
  window, a written policy of what may run without approval, and a rule for who is told when a
  gate fails.
- **Blocks it.** The user's decision on `autoReady`, on the cap values, and on what may run
  unattended. `CLAUDE.md` says the orchestrator never turns `autoReady` on, and that stays true
  until the user decides otherwise.

### (e) Remote approval and notification

- **Exists today.** Approval in the main session, and `PushNotification` when a run ends and the
  user is not at the terminal.
- **Missing.** Approving a plan from a phone, and a notification channel that reaches the user
  when the session is not running.
- **Blocks it.** The user's choice of channel and its security, and the front-end contract in (c).

### (f) Secrets and subscription logins on the box

- **Exists today.** The OpenCode Go key lives in `~/.pi/agent/auth.json`; the decider key lives in
  a 0600 file and is never in a worker's environment; the dispatcher removes `AGENT_VAULT` from
  workers and `verify:` commands. `omp` keeps its own config and login under `~/.omp/agent/`.
- **Missing.** A secrets story for the dev box: where each login lives, how it is rotated, how a
  second agent's login is kept out of worker environments, and what happens when a free model's
  period ends.
- **Blocks it.** The user's decision on which providers run on the box, and whether the box holds
  the logins or a proxy does.

### (g) Monitoring across repos

- **Exists today.** The native monitor app (Wails, Go server, React client) already shows several
  repos and a live session transcript.
- **Missing.** A cross-repo queue view, per-agent lanes in the same view, and alerts on a failed
  gate when nobody is watching.
- **Blocks it.** (b): the cross-repo queue has to exist before it can be shown.

### (h) Vault sync and harness updates across machines

- **Exists today.** The vault is its own git repo; `sync push` is `auto` or `manual` per its
  `harness.json`; a new machine runs the vault's `bootstrap.sh`, and `vault.mjs setup --force`
  writes the skill and agent files.
- **Missing.** Updating the installed skill, agents and extension across machines without a
  manual copy list, a version marker for the harness, and a decision on when the vault pushes.
- **Blocks it.** The user's decision on automatic pushes and on how the dev box is provisioned.

### Billing stays open

Reaching the Claude subscription through any harness other than Claude Code may be billed as
extra usage. `docs/pi-harness-context.md` records this for `pi-claude-bridge`: requests that look
like third-party use may be billed as Extra Usage. This roadmap does not assume that route is
allowed, and the front-end item (c) keeps Claude Code as the only front end that uses that
subscription officially until the user decides otherwise.

## Risks

- **The 400 is not fixable on the `omp` side.** If neither `omp`'s config nor an upstream fix adds
  the header, the proxy or another provider is the only route, and both change what is measured.
  Mitigation: Phase 0 tests the cheapest route first and records which one worked; the roadmap
  keeps Pi as the default agent until it does.
- **Event or session-format drift between agent versions.** `omp` and Pi both change their event
  and session shapes, and the probe already saw differences (`session_info`, `modelId` versus
  `model`, `agent_settled`). Mitigation: Phase 1 records fixtures per version and Phase 4 keeps a
  golden file per agent; a new version is tested against the fixtures before it is used.
- **The guard does not load in `omp`.** A worker would then have no live edit guard. What still
  catches a bad edit: the git snapshot before and after the plan records every changed file, the
  gate fails on a change outside a task's `files:`, and a read-only task that edits anything raises
  `readonly_violation`. Mitigation: Phase 3 loads a minimal extension before any real task, and a
  role that cannot get the guard stays on Pi.
- **The thinking mapping changes cost or quality.** Mapping `max` to `xhigh` makes an `omp` task
  weaker than the same plan on Pi, and a wrong mapping can raise cost. Mitigation: record requested
  and actual levels in the trace, and compare them in the measurement plan; the adapter decides
  once and a test pins the table.
- **`omp` adds its own tools and memory features.** `omp`'s own config on this machine sets a
  memory backend named `hindsight` (a local API URL), a default model role and
  `defaultThinkingLevel: high`; this was read from `~/.omp/agent/config.yml`, not exercised by the
  probe. Features like that change what a worker can reach beyond its `files:` and the vault rule.
  Mitigation: the adapter documents the tools and memory it enables, plans and preflight keep the
  file limit, and a review checks that no memory backend is enabled for a worker role.
- **OpenCode Go subscription limits.** The free or included period of a model can end, and a rate
  limit or quota ends a run. Mitigation: the transient-error path and the plan-level outage pause
  already exist, and a permanent error fails the task; the roles config is the place to move a role
  to another provider.
- **Gate still necessary, not sufficient.** When a worker is a different agent, its own claims are
  even less comparable. The gate, `verify:` and the git evidence stay the source of truth.

## Open questions

What only the user can decide:

1. Which Phase 0 route to take: a provider setting in `omp`, an upstream fix, a thin proxy, or
   another `omp` provider.
2. Which agent comes after `omp`, and whether the next one is another Pi fork or a different
   harness.
3. Whether reaching the Claude subscription through a harness other than Claude Code is acceptable
   given the extra-usage risk, and whether Claude Code stays the only front end.
4. What the cost caps per plan and per day should be, and what may run unattended.
5. Whether the DeepSeek front end, or any second front end, is worth building while Claude Code
   works.
6. Whether to accept the `max` to `xhigh` mapping for `omp`, or refuse such tasks instead.
7. Whether parallel tasks should move to per-task git worktrees, which many repos on one box
   needs.
8. Where the dev box keeps its logins and secrets, and which providers it may hold.
9. Which remote approval and notification channel to use.
10. When `sync push` may be automatic and how the harness updates on the box.

## Measurement plan

The comparison reuses the `Models` table of `trace.mjs report`, as `docs/roles.md` already
proposes for pair mode. The same task runs solo on each agent with the same role, model and
thinking level where the agent has it, and the table is compared on four things:

- **Gate pass rate.** How often a plan of that task passes the gate, per agent.
- **Rounds to pass.** How many plans, including fix rounds, a task needs before it passes.
- **Faults.** The error and warning faults per task, split by kind, as the Models table already
  shows.
- **Cost.** Tokens and cost per task, including reviewer cost when a role is a pair.

Method: pick a small task with a real `verify:` and run it at least three times on each agent, on
the same starting commit, with the same plan file apart from the role's agent. Keep the model id
and thinking level fixed; where `omp` has no `max`, record the mapped level in the table so the
comparison is not read as equal effort. Read the table after each plan with
`node ~/.claude/skills/dispatch-plan/trace.mjs report --trace <T>` and keep the four numbers
beside the plan id.

The pair-mode comparison in `docs/roles.md` is the model for this section: it also runs the same
tasks with and without a second role and compares cost, gate pass rate, rounds and faults. This
roadmap adds only the agent dimension to that comparison, and Phase 5 is what puts the agent in
the table.
