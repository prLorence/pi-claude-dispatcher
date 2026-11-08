# Recon: why mistral-subscription and opendesign-cloud have no reasoning field

Date: 2026-11-08 · Status: reconnaissance complete, fixes scoped but not implemented

## TL;DR

The reasoning picker is hidden for both providers because **`model.reasoning` is
false in the materialized model catalog**, and for different reasons:

| | mistral-subscription | opendesign-cloud |
|---|---|---|
| Profile declares `reasoningEfforts`? | Yes — `false` on all 10 models | No — field omitted |
| Profile `compat.supportsReasoningEffort` | `false` (route-level) | absent → pi-ai detects `true` |
| pi-ai catalog fallback | no catalog entry (`mistral-subscription` is not a catalog provider) | no catalog entry (`opendesign-cloud` is not a catalog provider) |
| Result | `reasoning: false` → no picker, and send path blocked | `reasoning: base?.reasoning ?? false` → `false` → no picker |

The upstream APIs **both accept `reasoning_effort` natively** (live-verified
2026-11-08), and both return thinking in shapes pi-ai already parses or the
proxy already translates. The fix is purely declarative for opendesign-cloud,
and declarative + one proxy change for mistral-subscription.

## The gating chain (code-traced)

Picker visible requires, in order:

1. **`model.reasoning === true`** — materialized by dsh-llm-pi-ai
   `resolveModelReasoning` (lib/index.js:586-611):
   - `reasoningEfforts === undefined` → `{ reasoning: base?.reasoning ?? false }`
     — for a provider with no catalog entry, `base` is `undefined` → `false`.
   - `reasoningEfforts === false` → `{ reasoning: false }`.
   - declared dict → `{ reasoning: true, thinkingLevelMap }`.
2. **`reasoningInfo`** (lib/index.js:1831) — `!model.reasoning` → `{}` → no
   `reasoning` field in the models API → client picker hidden.
3. **Send path** (pi-ai openai-completions.js:720-725, generic branch for
   unknown providers): `reasoning_effort` is sent only when
   `model.reasoning && compat.supportsReasoningEffort`. With no effort
   requested, the `off` wire value is sent if declared as a string
   (line 724-728).

Both providers fail at step 1. mistral-subscription additionally fails step 3
(route `compat.supportsReasoningEffort: false`, set during the 422
extra_forbidden fixes — that flag was the **only** correct way to stop pi-ai
sending `reasoning_effort` to a Mistral API that rejected it; the API has since
grown native support).

Subtlety verified in code: an **undeclared** `off` in a ladder becomes
`map.off = null` → `getSupportedThinkingLevels` **excludes** it — so a ladder
must declare `off` explicitly when the model can actually stop thinking
(`off: "none"` sends `reasoning_effort: "none"`; `off: null` = selectable,
sends nothing).

## opendesign-cloud (live-probed, real key)

Gateway `https://amr-link.open-design.ai/v1` is OpenAI-compatible and accepts
`reasoning_effort` on every model probed — no 422s. Thinking returns as the
raw `reasoning` field (plain string) on stream deltas, which pi-ai already
parses into thinking blocks (first non-empty of
`reasoning_content`/`reasoning`/`reasoning_text`). **No proxy needed.**

Live-verified ladders:

| Model | reasoning_effort accepted | Notes |
|---|---|---|
| deepseek-v4.1-flash | low/medium/high/minimal/max + none/off | `none` = true off (no reasoning_details, no reasoning_tokens). Thinks by default even with no param (surfaces as `reasoning_details` summary). |
| glm-5.3-flash | low/high | `none` does NOT disable (still thinks). Omission = off. zai-style `thinking:{...}` param ignored. |
| glm-5.3-flashx | low | same can't-disable pattern for `none` |
| mimo-v2.6-flash | high ✓ | reasoning + reasoning_details text |
| kimi-k2.7-code | high ✓ | reasoning + reasoning_details text |
| hy4-preview | high ✓ | reasoning + reasoning_details text |
| minimax-m3.1-flash | high ✓ | reasoning + reasoning_details text |
| gpt-6-luna | high ✓ | **encrypted** reasoning only (`reasoning.encrypted`) — pi-ai treats reasoning_details as replay metadata, so no visible thinking; a ladder would show a picker that produces nothing visible |
| claude-haiku-5.5 | high (silently) | no reasoning fields surfaced at all — don't declare |

`reasoning_details` in responses is treated by pi-ai as **replay metadata**
(openai-completions.js:172): it ensures a thinking block exists and is
serialized into `thinkingSignature`, but the visible thinking text comes from
the raw `reasoning`/`reasoning_content` delta fields.

**Fix (declarative only)** — add to the profile's opendesign-cloud models:

```yaml
- id: deepseek-v4.1-flash
  reasoningEfforts:
    off: none
    low: low
    medium: medium
    high: high
- id: glm-5.3-flash
  reasoningEfforts:
    low: low
    high: high
```

(glm: no `off` — omission is the only off; pi-ai "off" → no reasoning option →
no param sent → gateway omits thinking. Leave claude-haiku-5.5 and gpt-6-luna
undeclared.)

## mistral-subscription (live-probed, real key)

`https://api.mistral.ai/v1/chat/completions` now accepts `reasoning_effort`
as a top-level string (the `thinking:{...}` object still 422s). The route
already runs through the plugin's localhost proxy (127.0.0.1:8477), which
passes request bodies through untouched after sanitizing replayed assistant
messages — so pi-ai's generic `reasoning_effort` branch works natively once
the profile declares ladders and the route's `compat.supportsReasoningEffort`
flips to `true` (or is dropped — default detection gives `true`).

Live-verified ladders:

| Model | accepted | ladder |
|---|---|---|
| mistral-medium-2604 | high, none | `{off: none, high: high}` |
| mistral-small-latest | high, none | `{off: none, high: high}` |
| deepseek-v4-1-flash-1017 | none/low/high/xhigh/max | `{off: none, low: low, high: high, xhigh: xhigh, max: max}` |
| zai-glm-5-3 | low/high/max (none ✗) | `{low: low, high: high, max: max}` — no off |
| zai-glm-5-3-flash | low/high/max | same |
| glm-5-2 | none/low/high/max | `{off: none, low: low, high: high, max: max}` |
| ministral-{14b,8b,3b}-2512, codestral-2508 | — | `reasoning_effort is not enabled for this model` — keep `false` |

**But there is a blocker**: with thinking ON, every model (Mistral-native
included) streams `content` as an **array** of
`{type:"thinking", thinking:[{type:"text",text}]}` blocks — the same shape
that broke pi-ai's parser ("text-delta text must be a string"). The proxy's
translation is keyed on `isGlmModel()` → `GLM_MODEL_PREFIXES =
["zai-glm", "glm-"]` only (lib/proxy.js:284), so Mistral-native models with
thinking ON would pass arrays through untranslated.

**Fix = declarative + one proxy change**:
1. Profile: declare the ladders above, flip route
   `compat.supportsReasoningEffort` to `true`.
2. Proxy: translate content arrays for **any** model when the response
   carries them — key on response shape, not model id (extend the
   translation trigger from `isGlmModel(model)` to a per-chunk/payload
   `Array.isArray(delta.content)` check, which the existing
   `translateGlmStreamChunk`/`translateGlmResponseBody` already do
   internally — only the *trigger* is model-keyed).

## Why the builtin catalog doesn't help

pi-ai's catalog has `mistral-medium-2604` / `zai-glm-5-3` / `glm-5-2` with
`reasoning: true` and correct thinkingLevelMaps — but under the catalog
provider key `mistral`, not the profile route key `mistral-subscription`.
`catalogModels("mistral-subscription")` is empty, so the base lookup misses
and the profile declaration is the only way to set the capability.
