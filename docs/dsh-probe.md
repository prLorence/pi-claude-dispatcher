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
