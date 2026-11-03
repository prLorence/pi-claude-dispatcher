# The `omp` probe, 2026-11-02

Dated evidence for the question "can `omp` replace `pi` as the worker agent?" The companion
roadmap, `docs/roadmap-agent-abstraction.md`, is planned by the same plan and builds on this
document. This file records only what the probe saw; it is not revised when the roadmap changes.

## Summary

On 2026-11-02 the same two read-only prompts were run against `pi` and against `omp` 15.7.3, with
the dispatcher's environment variable set, the same model and the same flags, and their JSON event
streams were compared. `pi` answered both prompts, and on the second one it read a file through the
read tool, producing text, thinking and tool events. `omp` answered neither: every run ended with an
HTTP 400 from the OpenCode Go gateway, "Request is missing x-opencode-session and cannot be
routed efficiently", and a retry with a real session folder instead of `--no-session` failed the
same way. So no successful `omp` run was observed, and the parts of `omp`'s behaviour that only
appear on a real reply (text deltas, tool events, usage and cost, thinking events, run time) are not
measured.

## Setup

- Date: 2026-11-02.
- `omp` version: 15.7.3 (`omp --version` prints `omp/15.7.3`). It is a Pi fork by Can Bölük, MIT
  licensed, and it keeps its sessions under its own home folder, `~/.omp/agent/`.
- `pi` version: not recorded during the probe. The probe notes the gap rather than filling it in
  afterwards; any later version string would be a different measurement.
- Environment: `PI_PLAN_DISPATCH_WORKER=1` for both agents, so the dispatcher extension installed
  for Pi does not start its own watcher inside the run.
- Model: `opencode-go/deepseek-v4.1-flash` for both agents.
- Flags, identical for both agents:

```text
--mode json -p --no-session --model opencode-go/deepseek-v4.1-flash --thinking low --tools read "<prompt>"
```

- Prompt 1: `Reply with exactly the word READY and nothing else.`
- Prompt 2: `Use the read tool to read README.md, then reply with only its first line.`
- No file in the repository was written by either agent.

## Results

`omp`'s line counts were not recorded during the probe; the event kinds below are the full list the
probe saw, and the counts marked "derived" are the length of that list, not a measurement.

| Agent | Prompt | Flags variant | Outcome | JSON lines | Event kinds seen |
|---|---|---|---|---|---|
| `pi` | 1 | `--no-session` | answered `READY` | 15 | `session`, `agent_start`, `turn_start`, three `message_start` and `message_end`, `message_update` with `text_start`, `text_delta`, `text_end`, `turn_end`, `agent_end`, `agent_settled` |
| `pi` | 2 | `--no-session` | read `README.md`, replied with its first line | 53 | the prompt 1 kinds, plus `message_update` of the kinds `toolcall_start`, `toolcall_delta`, `toolcall_end`, `thinking_start`, `thinking_delta`, `thinking_end`, plus `tool_execution_start` and `tool_execution_end` |
| `omp` | 1 | `--no-session` | failed with HTTP 400; assistant message had no content and `stopReason: "error"` | not recorded; 10 events listed | `session`, `agent_start`, `turn_start`, two `message_start` and `message_end`, `turn_end`, `agent_end`, and also `auto_retry_start` and `auto_retry_end` (attempt 1 of 3, delay 2000 ms, then "Retry cancelled") |
| `omp` | 2 | `--no-session` | failed with HTTP 400; assistant message had no content and `stopReason: "error"` | not recorded; 8 events listed | `session`, `agent_start`, `turn_start`, two `message_start` and `message_end`, `turn_end`, `agent_end` |
| `omp` | 1 | `--session-dir <temporary folder>` (instead of `--no-session`) | failed with the same HTTP 400 | not recorded | not recorded |
| `omp` | 2 | `--session-dir <temporary folder>` (instead of `--no-session`) | failed with the same HTTP 400 | not recorded | not recorded |

## The 400

The assistant message of the failed `omp` runs carried `stopReason: "error"`, `errorStatus: 400`
and an error text that starts:

```text
400 Request is missing x-opencode-session and cannot be routed efficiently
```

with `type=MissingSessionID`. The OpenCode Go gateway requires an `x-opencode-session` header, and
`omp` did not send it.

The retry replaced `--no-session` with `--session-dir <temporary folder>`, so the run wrote to a
real session folder instead. Both prompts returned the same 400. What
this shows is negative but useful: the missing header is not caused by `--no-session`. The cause
on `omp`'s side is not confirmed, because no report naming `omp` was found (see Web findings).

## Comparisons

### Events

Both agents emit the same envelope, but `omp` emits a smaller one.

| Kind | `pi` | `omp` |
|---|---|---|
| `session` (with `version`, `id`, `timestamp`, `cwd`) | yes | yes; `omp` reports `version: 3` |
| `agent_start`, `turn_start`, `message_start`, `message_end`, `turn_end` | yes | yes |
| `agent_end` (with a `messages` array) | yes | yes |
| `agent_settled` | yes | no (Pi-only event seen) |
| `message_update` (`text_*`, `thinking_*`, `toolcall_*`) | yes | no (Pi-only event seen) |
| `tool_execution_start`, `tool_execution_end` | yes (prompt 2) | not seen |
| `auto_retry_start`, `auto_retry_end` | not seen | yes (`omp`-only events seen) |

The `omp` assistant message carries `role`, `content`, `api` (`openai-completions`), `provider`,
`model`, `usage` (`input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`, `cost` with parts and
`total`), `stopReason`, `errorStatus` and `errorMessage`. Its user message also has an
`attribution` field.

### Session files

Both agents write JSONL, and both start with a `session` line holding `type`, `version`, `id`,
`timestamp` and `cwd`. After that they diverge.

| Line | `pi` | `omp` |
|---|---|---|
| `session_info` (with `name`) | yes | not seen |
| `model_change` | yes, with `provider` and `modelId` | yes, with a single `model` field |
| `thinking_level_change` | yes | yes |
| `message` lines | yes | yes; each has `id`, `parentId`, `timestamp` and a `message` object |

The two formats are close but not equal.

### Model catalog

`omp --list-models` lists the OpenCode Go models under the same ids, for example
`opencode-go/deepseek-v4.1-flash`. The metadata for that model differs from Pi's:

| Field | `pi --list-models` | `omp --list-models` |
|---|---|---|
| context | 1M | 222K |
| max output | 384K | 8.9K |

### Extensions

Loading the Pi extension `pi-vim` inside `omp` failed with `Export named 'SettingsManager' not
found`, so Pi extensions are not all portable to `omp`. `omp` takes extensions with `-e` or
`--extension`, `--hook` and `--no-extensions`.

### Flags

The dispatcher passes these flags to Pi, from `pi-plan-dispatch/core.ts`: `--mode json -p`,
`--session-id`, `--session-dir`, `--name`, `--no-session`, `--model`, `--thinking`, `--tools`.

| Flag | `pi --help` | `omp --help` |
|---|---|---|
| `--mode` | yes | yes (`text`, `json`, `rpc`, `rpc-ui`) |
| `-p` | yes | yes |
| `--session-dir` | yes | yes |
| `--no-session` | yes | yes |
| `--model` | yes | yes |
| `--thinking` | yes | yes |
| `--tools` | yes | yes |
| `--session-id` | yes | not listed (it lists `-c` and `-r, --resume`) |
| `--name` | yes | not listed |
| `-e` / `--extension`, `--hook`, `--no-extensions` | not noted | yes |

### Thinking levels

| Source | Levels listed |
|---|---|
| `omp --help` | `minimal`, `low`, `medium`, `high`, `xhigh` |
| `pi --help` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| dispatcher and decider ladder | `low`, `high`, `max` |

`omp` has no `max`, so the top rung of the dispatcher's ladder does not exist there as listed.

### Existing seam

The dispatcher config already has `piCommand` (default `pi`), the executable it spawns. The probe
did not change it.

## Web findings

Other harnesses were rejected by OpenCode Go with the same 400 for the same reason, a missing
`x-opencode-session`; and in the report about the `pi-ai` SDK, Pi's application layer adds the
header while SDK users do not get it. No report naming `omp` was found, so the cause on `omp`'s
side is not confirmed. These are the only sources cited:

- <https://github.com/PrimeIntellect-ai/prime-agent/discussions/2110> — OpenCode Go requests
  rejected with 400 "Request is missing x-opencode-session".
- <https://github.com/PrimeIntellect-ai/prime-agent/discussions/2072> — OpenCode requests lack
  `x-opencode-session` and a specific User-Agent.
- <https://github.com/deepseek-ai/deepseek-harness/discussions/6417> — the `pi-ai` SDK never
  generates the header.
- <https://github.com/deepseek-ai/deepseek-harness/discussions/6173> — no per-conversation session
  header, hurting cache hits.
- <https://dev.co/ai/frameworks/oh-my-pi> — what `omp` is.
- <https://x-cmd.com/install/oh-my-pi/> — what `omp` is.

## Not measured

No successful `omp` run was observed, so the following are explicitly unmeasured for `omp`:

- text deltas
- `tool_execution_*` events
- tool call content
- usage and cost on a real reply
- thinking events
- real run time

Two further facts were read from files rather than exercised: `omp`'s own config on this machine,
`~/.omp/agent/config.yml`, sets a memory backend named `hindsight` (a local API URL), a default
model role and `defaultThinkingLevel: high`. The probe never ran with that memory backend.

## Checks that would settle the open points

Each check is read-only or cheap, and none of them was run by this document's author.

| Open point | Check |
|---|---|
| Whether `omp` can be told to send `x-opencode-session` (cause of the 400 on `omp`'s side) | Read `omp`'s installed source for the header and the provider request builder: `grep -r "x-opencode-session"` in the `omp` install directory under the global npm folder, then read the file it matches. No model call. |
| Whether a provider setting in `omp`'s config can carry the header | Read `~/.omp/agent/config.yml` and `omp --help` for a provider or header option; compare with the field the `pi-ai` report names. |
| `omp`'s text, thinking and tool events on a real reply | After the 400 is fixed, one cheap run of prompt 1 and one of prompt 2 with the setup above, then count the JSON lines and list the event kinds. This is a model call, so it is deferred, not run here. |
| `omp`'s usage and cost fields on a real reply | The same two runs; read the `usage` object of the assistant `message_end`. |
| `omp`'s session file format with a real session | The same run with `--session-dir`, then read the JSONL file and compare its lines with Pi's. |
| Whether `omp` accepts `max` as a thinking level | `omp --help` output (already shows no `max`); if needed, read the argument parser in the `omp` install directory to see whether an unlisted value is rejected. |
| Whether other Pi extensions load in `omp` | Load one small extension with `omp -e <path> --help` (help printing, no model call), and read `omp`'s extension API for `SettingsManager`. |
| Whether the model catalog difference matters | `omp --list-models` and `pi --list-models`, diffed for `opencode-go/deepseek-v4.1-flash`; both are read-only. |
| Whether `omp`'s `hindsight` memory backend changes what a worker can reach | Read `~/.omp/agent/config.yml` and the backend's local API URL, and check whether it is enabled by default in a worker run. |

## Addendum, 2026-11-02: Phase 0 result

The 400 above is fixed. A provider header override in the agent's own `models.yml`, under
`providers.opencode-go.headers`, sets `x-opencode-session: "!uuidgen"`. With that header the two
read-only probe prompts succeeded on 2026-11-02, and no HTTP 400 was returned.

- Prompt 1 returned a `READY` reply with `stopReason: "stop"`.
- Prompt 2 made one `read` tool call on `README.md:1`; the model's final answer was the first line
  of the README, while the tool itself returned the whole file.
- The tool events use the same names and fields as Pi's: `tool_execution_start` with
  `toolCallId`, `toolName`, `args` and `intent`, and `tool_execution_end` with `toolCallId`,
  `toolName`, `result` and `isError`.
- The usage shape is the same too, including `cost.total`; that total was 0 for the OpenCode Go
  model used.
- A one-line prompt cost about 33 000 input tokens.
- The raw streams are not committed here because they hold local paths. The small fixtures under
  `pi-plan-dispatch/fixtures/agents/` are written from these documented shapes, not copied from
  the probe.
