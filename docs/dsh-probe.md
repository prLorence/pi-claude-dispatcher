# The DeepSeek Harness (dsh) probe, 2026-11-03

Dated evidence of a read-only, key-free probe of the DeepSeek Harness, the open-source agent
runtime that this project is considering as a second front end. This file records only what the
probe saw. It is not revised when the roadmap changes, and it does not repeat or extend the
roadmap's reasoning.

## Summary

On 2026-11-03 the package `@deepseek-ai/dsh` version `0.2.1-rc.5` was installed from npm into an
isolated scratch folder with `--ignore-scripts`, with `DSH_HOME` pointed at a second scratch
folder, and four commands were run against it: `dsh --help`, `dsh headless --help`,
`dsh --profile headless --dump-config` and `dsh --dump-config-schema`. The installed package files
and READMEs were read as well. No API key was set and no model call was made, so everything below
is package and configuration evidence, not observed agent behaviour. The probe found a
plugin-composed CLI with web, tui, headless, sdk and acp profiles, a pi-ai based provider layer
that already lists `opencode-go`, and no guard, hook or permission package of its own. It also
found two name traps around the package, and a developer preview whose compatibility can break
between release candidates.

## Method

- Date: 2026-11-03.
- Package: `@deepseek-ai/dsh`, version `0.2.1-rc.5`, installed from npm.
- Isolation: the package was installed into a scratch folder of its own with
  `--ignore-scripts`, so no install script of the dependency tree ran, and `DSH_HOME` was pointed
  at another scratch folder. Both folders sit outside the repository and outside the home folder.
- Commands run, and nothing else:

```text
dsh --help
dsh headless --help
dsh --profile headless --dump-config
dsh --dump-config-schema
```

- Reading: the installed package files and READMEs were read to fill in the facts below.
- No API key was set and no model call was made.
- Nothing was written in the repository or in the user's home folder.
- A run with a fresh `DSH_HOME` created only a `profiles` folder in it.

## Package facts

- The official package is the scoped `@deepseek-ai/dsh` on npm, not an unscoped name.
- Repository: `https://github.com/deepseek-ai/deepseek-harness`.
- License: MIT. One maintainer address, on deepseek.com.
- Version: `0.2.1-rc.5`. Dist-tags: `latest` and `next` are `0.2.1-rc.5`, `alpha` is
  `0.2.2-alpha.3`. Last modified 2026-11-03.
- The README calls it a developer preview and says compatibility-breaking changes are expected.
- The install pulled 618 packages, about 840 MB in `node_modules`; the CLI package itself is
  76 KB.
- It depends on `@earendil-works/pi-ai` 1.5.0, the provider layer of Pi, and on
  `@anthropic-ai/sdk`.

## CLI facts

- Usage is `dsh [--profile] <name> [options] [app-args...]`, plus
  `dsh plugin --profile <name> <pnpm-args...>` for plugin management.
- Options: `--profile <name>` (a profile under `$DSH_HOME/profiles`),
  `--from-default-profile <name>`, `--patch <path>` (a repeatable overlay), `--dump-config`,
  `--dump-config-schema` and `--dump-default-config`.
- Examples given in the help: `dsh web`, `dsh headless "run the tests"`,
  `dsh tui --patch ./extra.yml`, `dsh tui --resume <session>` and
  `dsh plugin --profile tui add <package>`.
- The profiles named in the help are web, tui and headless; the reference documents also name sdk
  and acp.
- Headless: `dsh --profile headless [--json] [--session-id <id>] [task...]` answers one task and
  exits. The answer goes to stdout and diagnostics to stderr. `--json` writes newline-delimited
  run events. `-` reads the task from stdin. `--session-id` adopts a persisted session, and an
  unknown id is an error.
- A run with a fresh `DSH_HOME` creates only a `profiles` folder.

## Configuration and models

- A profile is an ordered stack of plugin-bundle patch layers, under the user's own YAML
  overrides.
- In the headless composition the default model plugin `@deepseek-ai/dsh-agent-default-model` is
  set to `provider: deepseek-official`, `model: deepseek-flash`.
- The plugin `@deepseek-ai/dsh-llm-pi-ai` is mounted in the headless composition. It routes
  requests through pi-ai provider catalogs, or through hand-declared gateways from a `providers`
  dictionary in which each key is a route name, with a per-route endpoint, protocol and headers.
- Credentials are `apiKeyEnv` references resolved per request. A reference that resolves to
  nothing fails with `MISSING_CREDENTIAL`.
- `retryPolicy` defaults to normal mode with five retries.
- The pi-ai 1.5.0 provider list includes `opencode-go`, `opencode` and `anthropic`.
- pi-ai's OAuth modules cover anthropic, github-copilot, kimi-coding, openai-chatgpt,
  openai-codex, openrouter and xai.
- The dsh docs say the harness has no ChatGPT sign-in; the `openai` route signs in with an API
  key. They also say Bedrock, Vertex, Azure and Codex cannot be fully described by a profile, so
  they are reached through catalog routes.

## Instructions and tools

- `@deepseek-ai/dsh-agent-instructions` is described as the workspace context loader for AGENTS.md
  and CLAUDE.md instruction files.
- dsh has its own skill system: `dsh-skill`, `dsh-skill-filesystem` and `dsh-tool-skill`.
- Tool packages seen: `dsh-tool-bash` (with persistent and local variants, plus
  `dsh-bash-sandbox`), `dsh-tool-fs`, `dsh-tool-fs-search`, `dsh-tool-str-replace-editor`,
  `dsh-tool-subagent` with in-process spawn and fork providers, `dsh-tool-todo`,
  `dsh-tool-workflow` (runs a JavaScript orchestration script that fans out subagents),
  `dsh-tool-ralph` (a fresh-agent loop toward one objective), `dsh-tool-goal`,
  `dsh-tool-schedule`, `dsh-tool-ask-user`, `dsh-tool-web`, `dsh-mcp-client` (tools only) and the
  experimental `dsh-experimental-tool-agent-team` with nine team tools.
- No package named for a guard, hook or permission policy was found. A live edit guard and our
  trace events would therefore be plugins of our own.

## Programmatic surfaces

- An `sdk` profile: a JSON-RPC server, a TypeScript SDK and a Python SDK.
- An `acp` profile, described as automation-only.
- An HTTP server and gateway, a remote-access plugin, a Web Client and an Electron desktop app.
- A `SessionPersistence` interface with `create`, `open`, `stat`, `list` and `export`.
- Everything is a plugin on the Cordis plugin framework. A package declares itself with a `dsh`
  field in `package.json`.

## Name traps

- The unscoped npm name `dsh` is an unrelated JavaScript shell, version 1.0.1. It is not this
  harness.
- The name `deepseek-harness` is a reserved placeholder, version 0.0.1. It is not this harness
  either.
- Installing by a guessed name would therefore install the wrong code. Only the scoped
  `@deepseek-ai/dsh` is the official package.

## Unverified

These items are secondhand. The probe did not verify any of them, and they are not evidence of
how dsh behaves.

- Creator mode: inspecting the runtime, testing Cordis plugins in memory and combining them into
  new modes. Reported in the developer preview of August 2026; not verified by the probe.
- Community plugin directories; not verified by the probe.
- A community plugin that lets dsh delegate to Claude Code through the Agent SDK; not verified by
  the probe.
- A community bridge that loads Claude-style SKILL.md folders; not verified by the probe.
- A report that the pi-ai SDK never sends the `x-opencode-session` header that the OpenCode Go
  gateway requires. The `omp` probe in `docs/omp-probe.md` hit the same HTTP 400 with another
  Pi-family agent. This is not verified for dsh and is the first live check for dsh on OpenCode
  Go.

## Web sources

The facts above rest on these sources. No other URL is cited in this document.

- `https://www.npmjs.com/package/@deepseek-ai/dsh`: the scoped package name, version, dist-tags,
  last-modified date, maintainer and the size figures.
- `https://github.com/deepseek-ai/deepseek-harness`: the repository and the MIT license.
- `https://deepseek-harness.github.io/deepseek-harness/en/reference/`: the reference material on
  the profiles, the programmatic surfaces, the `SessionPersistence` interface, the provider and
  OAuth lists and the remarks about ChatGPT sign-in and the catalog routes.
- `https://deepseek.com/harness/en/`: the product page listed as an allowed source for the
  harness. The probe records no fact that is attributed to this page alone.
- `https://github.com/deepseek-ai/deepseek-harness/discussions/6417` and
  `https://github.com/deepseek-ai/deepseek-harness/discussions/6173`: listed as allowed sources
  for the secondhand community items. The probe did not read them and attributes no claim above
  to either one.
- `https://thenewstack.io/deepseek-harness-open-source-plugins/`: listed as an allowed source for
  the secondhand reports about plugins. The probe did not read it.
- The three performance links of the spec are used by the roadmap's model table, not by this
  document, and are therefore not repeated here.

## Not measured

Every item below was outside the probe and is unknown.

- Any model call.
- The OpenCode Go route and its key inside dsh.
- The real `--json` event shapes and their names.
- Whether tool calls, usage and cost appear in those events.
- Session files on disk, and how a session resumes.
- Token and cost reporting.
- The `sdk` and `acp` profiles.
- The bash sandbox behaviour.
- How the instruction loader finds AGENTS.md. The documents say AGENTS.md and CLAUDE.md are
  loaded; the precedence and the nested-folder behaviour were not tested.
- Whether a plugin can block a tool call.
- Startup time and memory.
- `dsh plugin add` from GitHub.
- Whether headless `claude -p` can run the `plan-auditor` agent file from `~/.claude/agents/`.

## Checks that would settle the open points

Each row names one open point, the check, what to look at and the pass condition. The last column
says whether the check is read-only or needs a key or subscription the user supplies.

| Open point | Check | Command or action | What to look at | Pass condition | Access |
| --- | --- | --- | --- | --- | --- |
| Any model call | One minimal headless run | `dsh --profile headless "Reply with READY"` with a route key in the environment named by `apiKeyEnv` | stdout, stderr, exit code | The word READY on stdout and exit 0, with no credential error | Needs a key |
| OpenCode Go route and its key | Route a run through `opencode-go` | Same run, with a `providers` route for `opencode-go` and its `apiKeyEnv` reference set | stdout, stderr, the error text | A text answer and exit 0; no `MISSING_CREDENTIAL` and no HTTP 400 | Needs a key |
| `x-opencode-session` report | The same OpenCode Go run, then a header fix | Run once as above; if it fails with the 400, add the session header to that route's headers in `providers` and run again | The error status and text; the second run's answer | First run answered, or the 400 reproduced and then cleared by the route header | Needs a key |
| Real `--json` event shapes | One headless run with JSON output | `dsh --profile headless --json "Reply with READY"` | The newline-delimited event lines | Every line parses as JSON and the event type names are written down | Needs a key |
| Tool calls, usage and cost in events | A run that reads one file | `dsh --profile headless --json "Read README.md and quote its first line"` | Event lines for tool start and end, and any usage or cost fields | A tool event names the path, and usage and cost fields are present or their absence is recorded | Needs a key |
| Session files and resume | Persist a session, then adopt it | Run with `--session-id <id>`, list the `DSH_HOME` tree, then run again with the same id; also try an unknown id | New files under `DSH_HOME`, the second answer, the unknown-id error | The session file exists, the second run continues it, and the unknown id is an error | Needs a key |
| Token and cost reporting | Compare the reported numbers with the run | The `--json` run above | Usage and cost fields | Numbers are present and plausible for the prompt | Needs a key |
| `sdk` and `acp` profiles | Dump their configuration, then start them | `dsh --profile sdk --dump-config` and `dsh --profile acp --dump-config`, then start each and make one call | The dumped layers, the listening port, the first response | Both profiles dump without error and answer one request | Read-only for the dump; needs a key for the call |
| Bash sandbox behaviour | A task that tries a write outside the workspace | A headless task whose command writes to a path outside the repository, with `dsh-bash-sandbox` mounted | The tool output and any refusal message | The write is refused or confined, and the message says which rule applied | Needs a key |
| Instruction loader precedence | Place instruction files at two levels | `--dump-config` first, then one headless run in a folder whose parent and child both hold an AGENTS.md and a CLAUDE.md | Which instruction files the run reports as loaded, and in what order | The load order and the nested-folder behaviour are recorded from the run itself | Read-only for the dump; needs a key for the run |
| Whether a plugin can block a tool call | Read the plugin and tool hook surface, then test a blocking plugin | Read the Cordis and tool packages in the installed tree; then mount a small plugin that refuses one tool and run a task that calls it | The hook the plugin can use, and the tool result the model sees | The call is refused and the refusal reaches the model as a tool result | Read-only for the source read; needs a key for the run |
| Startup time and memory | Timed headless runs | Time three headless runs and sample the process memory while one runs | Wall time per run and peak memory | Three numbers are recorded, with the host and the version | Needs a key for a full run |
| `dsh plugin add` from GitHub | Install a plugin into a scratch profile | `dsh plugin --profile <scratch> add <package>` for a GitHub source | The install log, the lockfile, the files it fetched | The plugin installs into the scratch profile only and is listed afterwards | Needs network and a scratch home |
| Headless `claude -p` and the auditor | Run the auditor agent headlessly | Confirm `~/.claude/agents/` holds the `plan-auditor` file, then run `claude -p` with that agent on a saved plan and spec | The output format, the findings, the exit code | Findings come back in the auditor's format with no interactive session | Needs the user's Claude subscription |
| Creator mode | Look for it in the installed tree and the reference pages | Search the installed packages and the reference page for Creator mode | Whether it exists, and how it is started | Either it is documented and reachable, or its absence is recorded | Read-only |

The checks that need a key cover the same ground as the roadmap's Phase 0; this table only names
them, and decides nothing about when they run.

## Addendum, 2026-11-04: live runs

The probe above was key-free and made no model call. This addendum records the live part of the
same probe, run one day later on the same version. It is append-only: every line above stays as
it was written, including the statements that the live runs later corrected. Where that happens,
the correction is stated here and the earlier sentence is marked as superseded, not edited.

### Method

- Date: 2026-11-04.
- Binary: the user's own `dsh`, version `0.2.1-rc.5`, the same version as the key-free probe. Its
  dsh home was the default `~/.dsh`, so this addendum also records what a real run leaves there.
- Configuration: a minimal patch kept in a scratch folder, with three settings:
  `agent-default-model` set to `provider: opencode-go` and `model: deepseek-v4-pro`, and the
  plugin `llm-pi-ai` with `providers.opencode-go.apiKeyEnv: OPENCODE_GO_API_KEY`.
- Credential: the key was entered by the user in a terminal and passed as that one environment
  variable, `OPENCODE_GO_API_KEY`, for the run. It was never written to a file and appears in no
  output file quoted below.
- Working folders: each run used its own scratch working folder outside the repository. Run 2
  used a folder holding an `AGENTS.md`, a `note.txt` and a project skill
  `.agents/skills/probe-skill/SKILL.md`.
- Method limit: two model calls, one resume and one `claude -p` call. This is a smoke test of the
  surfaces a front end and a worker adapter need, not a measurement of quality, speed or cost.

### Results

#### 1. The credential and the failed runs

The user had configured the OpenCode Go route in the dsh desktop app. Its profile file,
`~/.dsh/profiles/desktop/cordis.patch.yml`, holds an `llm-pi-ai` entry with
`apiKeyEnv: OPENCODE_GO_API_KEY` and a model list, and no key value. That patch also lists
`deepseek-official` as the default provider with `deepseek-v4.1-flash`, and
`subagent-model-selection-settings` allowing `opencode-go` models.

The headless profile does not read that stored credential. Without the variable the run failed
with:

```text
MISSING_CREDENTIAL: llm-pi-ai: no credential for provider route "opencode-go"; its profile resolves OPENCODE_GO_API_KEY, which is not set
```

Exporting `OPENCODE_GO_API_KEY` for the command fixed it. Credentials are therefore per profile
and per environment, not shared between the desktop and headless profiles.

A failed run is not silent. It still emitted `session` and `status` events, a `turn_end` with an
error reason and a `final` event with empty text, then exited 1:

```json
{"type":"turn_end","reason":{"kind":"error","error":{"message":"..."}}}
{"type":"final","text":""}
```

A headless run also creates `~/.dsh/profiles/headless/` (four small files) and a session folder
`~/.dsh/sessions/<working folder encoded>/session-<uuid>`.

#### 2. Run 1: a plain answer, real event shapes and usage

Prompt: reply with the word READY. The OpenCode Go route answered with no error and no
`x-opencode-session` 400. The output is one JSON object per line:

```json
{"type":"session","sessionId":"session-<uuid>","cwd":"..."}
{"type":"status","phase":"turn_start","turn":1}
{"type":"status","phase":"step_start","turn":1,"step":1}
{"type":"text","text":"READY"}
{"type":"status","phase":"step_end","turn":1,"step":1,"usage":{"inputTokens":297,"outputTokens":2,"totalTokens":7979,"cacheReadTokens":7680}}
{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}
{"type":"final","text":"READY"}
```

What the shapes say:

- The `text` event carried the whole text at once, not a delta stream.
- Usage is on `step_end`, per step, not on `turn_end`.
- The fields are `inputTokens`, `outputTokens`, `totalTokens` and `cacheReadTokens`.
- `totalTokens` equals input plus output plus cache read: 297 + 2 + 7,680 = 7,979.
- dsh reports no cost field. Cost has to be computed outside the harness from a price table.
- The first call used about 8K tokens of context, mostly served from cache.

#### 3. Run 2: a tool call, the AGENTS.md load and the skill catalog

The workspace held an `AGENTS.md` with the rule "end every final answer with the single word
PINEAPPLE", a file `note.txt`, and a project skill `.agents/skills/probe-skill/SKILL.md`. The
prompt asked the model to read the file with a tool, list the skill names and say what
instruction text it was given.

A tool call and its result look like this:

```json
{"type":"tool_call","callId":"call_<id>","tool":"read","input":{"file_path":"note.txt"}}
{"type":"tool_result","callId":"call_<id>","status":"completed","result":"<path>...</path><type>file</type><content>\n1: ...\n</content>"}
```

- `tool_result` carries no tool name; only the `callId` links it to its `tool_call`.
- The result text is line-numbered file content, wrapped in the harness's own tags.
- The read ran with no approval prompt in the headless profile.
- The run had two `step_end` events with their own `usage`; the second step used 372 new input
  tokens and 7,936 cache-read tokens.
- Then came a `text` event, a `turn_end` with `completed`, and a `final` event.
- The answer quoted `note.txt` correctly, quoted the `AGENTS.md` rule and ended with PINEAPPLE.
  So an `AGENTS.md` in the working folder is loaded by default.

#### 4. Skills: 31 in the catalog, 13 hidden on purpose

The model listed 31 skill names: code-review, codebase-design, defuddle, diagnosing-bugs,
domain-modeling, find-skills, gemini-meeting-debrief, grilling, hindsight-docs, impeccable,
json-canvas, knap, obsidian-bases, obsidian-cli, obsidian-markdown, ponytail, ponytail-audit,
ponytail-debt, ponytail-gain, ponytail-help, ponytail-review, probe-skill (the project skill),
project-doc, prototype, research, rex, tdd, vault-cleanup, vercel-composition-patterns,
vercel-react-best-practices and web-design-guidelines.

The user's Pi skills live in `~/.agents/skills`, 43 folders (not 44). Nothing pointed dsh at that
folder; it found it by itself. The 13 folders not listed are ask-matt, grill-me, grill-with-docs,
handoff, implement, improve-codebase-architecture, setup-matt-pocock-skills, teach, to-spec,
to-tickets, triage, wayfinder and writing-great-skills. Each carries
`disable-model-invocation: true` in its frontmatter, which `dsh-skill-filesystem` documents as
keeping a skill out of the model-facing catalog. Such a skill stays user-invocable unless the
frontmatter also sets `user-invocable: false`. The 13 are therefore recognised, not missing.

`dsh-skill-filesystem` documents the roots it scans, in rank order:

1. `<projectRoot>/.dsh/skills`
2. `<projectRoot>/.agents/skills`
3. `Config.customSkillDirs`
4. `<dshHome>/skills`
5. `<agentsHome>/skills`

A skill is a `<name>/SKILL.md` folder or a flat `<name>.md` file. Frontmatter requires `name` and
`description` and optionally `whenToUse`, `metadata`, `disable-model-invocation` and
`user-invocable`. Nested `**/SKILL.md` files are not discovered.

The folder `~/.claude/skills/dispatch-plan` is not in any scanned root, so the `dispatch-plan`
skill is not visible to dsh as things stand.

#### 5. Resume with `--session-id`

A second call, `dsh --profile headless --json --session-id <id> "<question>"`, continued the same
session. Its `session` event carried the same id, and its `step_end` and `turn_end` events say
`turn: 2`. It answered from the first call's tool result without a tool call, and it still ended
with PINEAPPLE, so the instruction file is reloaded or kept across the resume.

#### 6. Pi agents and dsh agent presets

The user's Pi agents are the files `architect.md`, `comment-sicko.md`, `dev-be.md`, `dev-fe.md`,
`flow.md`, `poteto-agent.md`, `qa.md` and `ux.md` in `~/.pi/agent/agents/`. They use Pi
frontmatter, and `docs/pi-migration.md` records how they were translated: `allowedAgents`, a
`skills:` list with `inheritSkills: false`, a generated guardrails appendix and model pins.

dsh has a different mechanism. `dsh-agent-preset` documents agent presets as a way to "define an
Agent's child plugins in ordinary Cordis YAML, declare several presets and let sessions select
one". There is also a subagent seam with spawn and fork providers and the tool
`dsh-tool-subagent-control`. How a dsh subagent gets its skills and its prompt was not measured.

#### 7. Headless `claude -p` running the plan-auditor

```text
claude -p --agent plan-auditor --output-format json --no-session-persistence "<prompt>"
```

Run in a scratch folder, this returned:

- `result: "READY"` and `is_error: false`, with `num_turns: 1`.
- `duration_ms` 2470, about 7 seconds of wall time.
- model `claude-opus-5-5`, taken from the agent file's `model: opus`.
- `total_cost_usd` 0.073288, a notional figure: the run used the user's Claude subscription.
- `usage` with 9,150 cache-creation tokens.

So a dsh plugin can run the `plan-auditor` agent through the official Claude Code CLI and read a
JSON result. It was a trivial prompt. A real audit with the plan, spec and trace arguments was
not measured, nor was the `plan.audit` event the agent logs itself.

#### 8. The guard and permission APIs

Read from the READMEs of the installed packages, not exercised:

- `@deepseek-ai/dsh-tools` documents `ctx.tools.restrict(filter)`, an allow or deny mask on the
  tools one agent inherits, lifted when the mask is disposed.
- The same package documents `ctx.tools.guard(guard)`, "a monotonic synchronous guard after the
  extensible `tools/pre-execute` waterfall: a returned reason denies the call, and no later
  listener can turn that denial back into permission".
- It also documents `tools/pre-execute` as the reorderable allow, deny and ask gate.
- The packages `dsh-permission-presets` (a sandbox mode bundled with an approval policy),
  `dsh-user-approval` (a fail-closed approval seam), `dsh-sandbox-policy` and `dsh-bash-sandbox`
  (confined command execution with denial and escalation facts) exist.

This supersedes the sentence in the key-free probe that no package named for a guard, hook or
permission policy was found. The correction: the guard is an API of `dsh-tools`, not a package of
its own name. It is documented and not exercised, so no claim is made here about how it behaves
in a run.

### Side effects

The live runs wrote to the user's dsh home, not to the repository:

- `~/.dsh/profiles/headless/`: created by the first headless run, four small files.
- `~/.dsh/sessions/<working folder encoded>/session-<uuid>/`: one session folder per run, plus
  the folder of the resumed session.
- `~/.dsh/profiles/desktop/cordis.patch.yml` was already there; the runs read it, they did not
  change it.

Cleaning these up was outside this probe.

### Status of the earlier Not measured list

Every item of the `## Not measured` section, with its status after the live runs. "Measured"
names the fact above; "not measured" means it is still unknown.

| Item of the earlier list | Status |
| --- | --- |
| Any model call | Measured (facts 2 and 3) |
| The OpenCode Go route and its key inside dsh | Measured (facts 1 and 2): answers with no 400, key from `OPENCODE_GO_API_KEY` per profile |
| The real `--json` event shapes and their names | Measured (facts 2, 3 and 5) |
| Whether tool calls, usage and cost appear in those events | Measured (facts 2 and 3): tool calls and usage appear, there is no cost field |
| Session files on disk, and how a session resumes | Measured (facts 1 and 5) |
| Token and cost reporting | Measured for tokens (facts 2 and 3); there is no cost field, so cost is not measured from dsh and must be computed |
| The `sdk` and `acp` profiles | Not measured |
| The bash sandbox behaviour | Not measured |
| How the instruction loader finds AGENTS.md | Partly measured (fact 3): an `AGENTS.md` in the working folder is loaded by default. Precedence, `CLAUDE.md` and nested folders are not measured |
| Whether a plugin can block a tool call | Not measured. The API exists and is documented (fact 8); it was not exercised |
| Startup time and memory | Not measured |
| `dsh plugin add` from GitHub | Not measured |
| Whether headless `claude -p` can run the `plan-auditor` agent file | Measured (fact 7) with a trivial prompt. A real audit through it is not measured |

One earlier sentence is corrected rather than measured: "No package named for a guard, hook or
permission policy was found" (in `## Instructions and tools`). It is superseded by fact 8. The
guard is an API of `dsh-tools` (`ctx.tools.guard`, `tools/pre-execute`), not a package of its own
name, and it is documented but not exercised.

### Still not measured

These remain outside the probe after 2026-11-04:

- A session-start hook, meaning a plugin hook that runs when a session starts. This is what the
  vault plugin's automatic boot would need. Not measured.
- The `sdk` and `acp` profiles. Not measured.
- How a subagent gets its prompt, its tools and its skills. Not measured.
- `dsh plugin add` from GitHub. Not measured.
- Creator mode. Not measured.
- Startup time and memory of a successful headless run. Not measured.
- The bash sandbox in practice. Not measured.
- A real plan audit through `claude -p`, with the plan, spec and trace arguments and the
  `plan.audit` event. Not measured.
- Whether the headless profile enforces a permission preset by default. Not measured.
