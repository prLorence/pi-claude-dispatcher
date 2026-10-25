# Decider

`dispatch-plan/decide.mjs` is a small CLI that asks a decision model for a typed probability, not prose. It has two uses:

1. `effort`: suggest a thinking level (`low`, `high`, `max`) for each task of a plan, so the orchestrator can write the `thinking:` lines.
2. `audit`: score each plan-audit finding with P(real defect) and roll the scores into one proposal for the approval step: `approve`, `hold`, `dismiss` or `fix`.

It is an advisory proof of concept. The effort suggestion is applied by the orchestrator; the audit proposal is shadow-only, never replaces the user's yes, and never flips a plan.

## OpenRouter contract

- Endpoint: `POST https://openrouter.ai/api/alpha/decisions`.
- Auth: `Authorization: Bearer <inference key>`. A management key gets `401 User not found`, so use an inference key.
- Request: `{model, state, questions}`, where `questions` is a map of name to `{type, instructions, criteria}`. `noul` is yes/no with `criteria: {false, true}`, `choice` has a map of option to description, `score` has an ordered array.
- Response: `{model, answers, usage: {input_tokens, output_tokens, cost}, id, provider}`. A `noul` answer is `{type, noul}` with P(true) in `noul`; a `choice` answer is `{type, choice, probabilities, confidence}`; a `score` answer is `{type, score, legend, probabilities, confidence}`. The returned `model` carries a dated suffix, for example `...-20261016`.
- Model: `perplexity/pplx-decider-flash-v1.2`, about $0.000004 per call. The endpoint is alpha and its contract can change.

The backend is `{name, ask(request)}` and the result is `{answers, usage, model}`. The core and the CLI use only that interface, so another hosted or local decider is a new backend file (`decide-backend.mjs`), not a change to the core.

## Config

`.plans/config.json`, key `decider`:

```json
{
  "effort": "off",
  "audit": "off",
  "model": "perplexity/pplx-decider-flash-v1.2",
  "timeoutMs": 30000,
  "thresholds": { "effortMax": 0.40, "effortLow": 0.60, "complexityHigh": 3.0, "approve": 0.50, "dismiss": 0.10, "minorWeight": 0.2 }
}
```

- `effort`: `off` or `apply`. `audit`: `off` or `shadow`. Both default to `off`; an invalid mode becomes `off`. `model` and `timeoutMs` fall back to the defaults shown here when missing or invalid.
- `thresholds` are initial guesses, to be fitted later on the recorded outcomes. `effortMax`, `effortLow`, `approve`, `dismiss` and `minorWeight` are numbers from 0 to 1, and a value outside that range falls back to its default. `complexityHigh` (3.0) is the cut on the complexity score, a number from 0 to 4, and anything else falls back to 3.0.
- `effortLow` (0.60) only matters when a task's complexity score is missing; otherwise `complexityHigh` decides between `high` and `low`.
- The dispatcher ignores this key. The user sets the config; the orchestrator never does.

## Commands

```text
node decide.mjs effort --plan <file> --trace <T> [--root <dir>]
node decide.mjs audit  --plan <file> --spec <file> --findings <file> \
                       --audit-round <n> --verdict pass|fail --trace <T> [--root <dir>]
node decide.mjs stats  [--root <dir>]
```

`--root` defaults to the working directory.

| Exit | Meaning |
|---|---|
| `0` | ok |
| `2` | dispatcher modules not found |
| `3` | no key |
| `4` | disabled (mode `off`) |
| `5` | not allowed (privacy gate) |
| `6` | backend error |
| `64` | usage error, a bad findings file, or more than 40 requests |

`effort` prints `{model, cost, tasks: [{task, suggested, probabilities, confidence, complexity}]}` and writes one `decision.effort` event per task. `audit` prints `{model, cost, audit_round, verdict, proposal, aggregate, findings: [{id, severity, p}]}` and writes one `decision.audit` event. In both, the printed `cost` is the sum for the command.

The findings file is an array: `[{id, severity: "blocker"|"major"|"minor", text, tasks?: [<id>], reqs?: ["R5"]}]`.

## Effort rule

In this order: `max` when P(max) is at least `effortMax` (0.40); otherwise `high` when the complexity score (0 to 4) is at least `complexityHigh` (3.0); otherwise `low`. The complexity score is the `score` answer of the `complexity` question, on the same 0 to 4 scale as its five legend levels.

When the complexity score is missing, the fallback decides between `high` and `low`: `high` when P(low) is below `effortLow` (0.60), else `low`.

Example, from the first live check: task `lanes` had a score of 3.2 and P(max) 0.07, so P(max) is below 0.40 and the score is at or above 3.0, giving `high`; task `docs` had a score of 2.3 and P(max) 0.01, so it is `low`. The threshold 3.0 is a guess fitted on 13 tasks: the first live check with the old rule suggested `high` for all 13, which is why the rule changed.

A task the orchestrator pins to another level carries `# pinned: <reason>` after the value in the plan.

## Audit aggregate and proposals

Weights are 1.0 for `blocker` and `major` and `minorWeight` (0.2) for `minor`. The aggregate is

```text
A = 1 - product over findings of (1 - w_i * p_i)
```

and 0 when there are no findings. A noisy-OR rather than a mean, so nine nitpicks cannot hide one real blocker.

Example: one blocker with p 0.6 and one minor with p 0.5. `A = 1 - (1 - 0.6) * (1 - 0.2 * 0.5) = 1 - 0.4 * 0.9 = 0.64`.

Proposal: with `--verdict pass`, `approve` when A is below `approve` (0.50), else `hold`; A 0.64 is not below 0.50, so `hold`. With `--verdict fail`, `dismiss` when there is at least one blocker or major and every blocker and major has p below `dismiss` (0.10), else `fix`: blocker p 0.05 and major p 0.08 gives `dismiss`, blocker p 0.30 gives `fix`.

## Privacy gate

Before any network call the CLI runs `vault.mjs repo check` in the repo root and proceeds only when it exits `0` and prints exactly `full`. For a `meta` repo, a `none` repo, an unlisted repo or a vault that cannot be resolved it sends nothing, prints `not allowed: <reason>` without naming the repo, and exits `5`.

What is sent, and nothing more:

- `effort`: the task body, its `files:` list and its role, once per task whose role is `implement` or `qa`.
- `audit`: the finding text and severity, the bodies of up to 8,000 characters of the tasks it names, the spec line of the requirements it names, and up to 6,000 characters of the plan's shared context.

Never sent: whole files, vault notes, the plan or spec file, the key.

## Key

The backend reads `OPENROUTER_API_KEY` from the environment first, else the first line of `~/.config/pi-plan-dispatch/openrouter.key`, trimmed. Keep that file at mode `0600`. No key means exit `3` and no network call. Any `sk-or-` token in a message becomes `<redacted>`, so the key cannot reach stdout, stderr, a trace event or a log. The dispatcher removes `OPENROUTER_API_KEY` from the environment of every worker and every `verify:` child.

Cap the key's spend on OpenRouter. The current limit is $1, and one call costs about $0.000004.

## Events and stats

All events use actor `decider`, and `--round` is the plan round:

- `decision.effort`, one per task: `{task, suggested, probabilities, confidence, complexity, model, cost, mode}`. `cost` is that task's own request.
- `decision.audit`, one per command: `{model, cost, audit_round, verdict, proposal, aggregate, findings}`.
- `decision.error`: `{command, status, kind, message}`, with no request text.

`trace.mjs report` shows a Decider table when a trace has these events. The monitor of `monitor/` shows several repos on one screen and, from the same events, shows the decider's suggested level next to the level that ran for each task, plus the audit proposal per plan. `decide.mjs stats` joins the recorded decisions with what happened, with no network: for effort, the suggested level against the level the task ran with, first-try pass, retries, pair `changes` rounds and failure counts; for audit, each proposal against the next audit verdict or the user's approval, with an agreement flag; and the total cost.

## Out of scope

- Effort chosen at dispatch time, or a retry escalating to a higher level.
- Any change to how the dispatcher picks a model or thinking level.
- Letting the decider flip a plan, auto-approve, auto-dismiss a finding, or write to a plan or spec.
- A Laya or other local backend; only the adapter that makes one possible.
- Fitting the thresholds and training.
- Any dependency.
