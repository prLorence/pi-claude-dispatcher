# Roles

A role is a named job: `implement`, `review`, `security`, `qa`; it carries a model, thinking level,
read-only flag and prompt. Plans name a role, never a model, so moving a role to another provider
is a config edit, and an empty or missing `thinking` passes no flag. Only `security` can be a
read-only task `role:`; every other read-only role, `review` included, is only a `pair:` reviewer,
and a custom role with `readonly: true` works the same way.

## Default roles

| Role | Default model | Price in / out (per Mtok) | Thinking | Read-only |
|---|---|---|---|---|
| `implement` | config `model` (`deepseek-v4.1-flash`) | $0.15 / $0.60 | config `thinking` (`low`; `low`, `high`, `max`) | no |
| `review` | `opencode-go/minimax-m3.1-flash-free` | $0 / $0 | `low` (`low` to `max`, incl. `medium`) | yes |
| `security` | `opencode-go/glm-5.3-flash` | $0.15 / $0.50 | `high` (`low`, `high`, `max`) | yes |
| `qa` | `opencode-go/mimo-v2.6-flash` | $0.14 / $0.28 | not listed, so no flag | no |

`implement` sets no model or thinking, so it inherits the config worker defaults; prices and
thinking levels above are Pi's catalog values. Resolution, highest first: task `model:`/`thinking:`,
the task's role, plan frontmatter, config defaults. The role prompt is appended as `## Your role`.

## Config

```json
{
  "model": "opencode-go/deepseek-v4.1-flash",
  "thinking": "low", "maxRunsPerTask": 8,
  "roles": {
    "review": { "model": "opencode-go/minimax-m3.1-flash-free", "thinking": "low" },
    "security": { "model": "opencode-go/glm-5.3-flash", "thinking": "high" } }
}
```

A user entry overrides only the fields it sets; add a role by naming it under `roles` and using it
in a plan. `maxRunsPerTask` (default 8) caps implementer plus reviewer runs for one task; at the cap
the pair loop stops, the task keeps its last verified state and a `pair_unresolved` warning is
recorded. The config role `qa` is unrelated to the Pi agent of that name in `~/.pi/agent/agents/`.
MiniMax M3.1 Flash is free for a limited period with no paid replacement listed; MiMo's thinking
levels are untested, so no flag is passed. Run `/plans roles test`. `config-init.mjs` writes the starting config, and the review model is the field to change when the free period ends.

## Plan fields

```markdown
## task: api
role: implement        # default
pair: review           # optional: review before this task counts as done
pair_rounds: 2         # optional, 1-3
```

`role:` defaults to `implement`; an unknown role, or a read-only role other than `security`, is
rejected pointing at `pair:`. `pair:` names a read-only role that reviews the task after it passes;
a non-read-only pair role, or a pair on a read-only task, is rejected. `pair_rounds:` defaults to 2.

## Pair mode

After an implementer task succeeds and its `verify:` passes, the dispatcher runs the pair
reviewer on that task: a read-only worker that gets the implementer's report and the prompt.
The loop is inside the task's lifecycle, so dependents wait for it, and a dry run skips it.

- `approve` means done.
- `changes` with findings and rounds left means the implementer runs again with the findings
  as feedback. This uses a separate `pairRound` counter and does not use `retries`.
- An `issues` verdict ends the loop at once and its findings go to `pair_unresolved`; only
  `changes` sends the implementer back.
- After the last round with `changes` still open, even with no findings listed, the task
  stays done and a `pair_unresolved` warning records it in the plan summary the orchestrator
  reports to the user.
- In a reviewer window, a changed file is blamed on the reviewer unless it belongs to a task
  running concurrently. Writes to finished tasks' files and unowned files are caught;
  parallel tasks editing their own files are not.
- A reviewer that crashes or returns an unparseable report never fails the task: a
  `review_unparsed` warning is recorded and the task carries on.
- Reviewer cost is added to the task's cost; reviewer tokens appear on the `task.review`
  event and in the Models table, not in the task's token total.

Known limitation: retries count failed attempts only, so a pair re-run that fails its
`verify:` with `retries: 0` fails the task even though an earlier attempt verified.

## Security and QA

A `role: security` task is a read-only review with the security prompt and report format, not the
implementer prompt, whose report format would contradict it. Its findings become faults:
`security_finding` with error for `high`, warn for `medium`, info for `low`; an unlabelled finding
counts as medium, and only high fails the gate. An unparseable report raises `review_unparsed`.
Read-only tasks change nothing by design, so the implementer checks do not apply; any edit raises a
`readonly_violation` error. The live guard denies edit tools and the obvious shell writes (`>` to a
file, `tee`, `sed -i`, `mv`, `cp`, `touch`, `rm`, `mkdir`, `chmod`), skipping wrapper commands
(`env`, `xargs`, `nohup`, `command`, `exec`, `nice`, `stdbuf`, `time`, `timeout`) first, but that
is best-effort: `python -c`, `node -e`, `git apply`, `truncate`, `xargs rm` and `find -delete` still
write through it. A window around its own run is the backstop: a change is blamed unless a task
running concurrently owns it, so finished-task and unowned writes are caught. Cost and tokens come
from its `task.end` event, not `task.review`.
A `role: qa` task is an ordinary implementer task with the QA model and prompt. Its
`files:` limit what it may edit, `verify:` checks its claims, and bugs go under NEEDS `BUG:`.

## Review formats

A pair or security reviewer ends with one of these, in plain text:

```text
VERDICT: approve | changes           (security: clean | issues)
FINDINGS: none, or
- <path>:<line>: <problem>. <fix>.   (security: - [high|medium|low] ...)
```

`findings:` may be `none`. Parsing is tolerant: case-insensitive, bold markers, prose
around the report, bullets or plain lines; a missing verdict is `unknown`.

## Commands

`/plans roles` lists each role's resolved model, thinking level and read-only flag.
`/plans roles test` runs a tiny real call per distinct (model, thinking) pair with a 90 s
timeout, and reports pass or fail, cost and seconds per pair, so a bad model id or thinking
level is found before a plan runs.

## Pilot protocol

The pair benefit is a hypothesis. Run the same tasks solo and with `pair: review`, then
compare worker cost, gate pass rate, rounds and faults per model in the Models table.
