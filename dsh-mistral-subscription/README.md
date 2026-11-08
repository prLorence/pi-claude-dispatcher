# dsh-mistral-subscription

A DSH plugin that adds a Mistral **subscription** sign-in and a matching provider
route, so a Mistral plan's included Vibe Code quota pays for the session instead
of pay-as-you-go API credits.

## Why this exists

DSH's built-in `mistral` route (`@deepseek-ai/dsh-llm-pi-ai`) authenticates with
`apiKeyEnv: MISTRAL_API_KEY`. That is a console API key, and everything it sends
bills to API credits. A Mistral subscription's included quota lives on the **Vibe
Code** surface, which is reached by signing in on `console.mistral.ai` — something
that route has no way to do.

This plugin closes that gap:

- It registers the authorization flow `llm-pi-ai/mistral-subscription`, which runs
  the Vibe browser sign-in (PKCE + poll + exchange) and stores the key Mistral
  returns in the DSH credential store as `llm-pi-ai/mistral-subscription`.
- It pairs with a provider route of the same name that authenticates from that
  stored credential rather than from an environment variable, so no key ever
  lands in a profile or config file.

It is a standalone package, not a patch to a shipped one, so a DSH update cannot
remove it.

## Requirements

- Node 20 or newer (the plugin uses the global `fetch`; the repository's own
  tests run on Node 24).
- A Mistral plan that includes **Vibe Code** quota.
- The owner's plan is a **Student** subscription. Student eligibility for the Vibe
  Code quota is not documented here and is not assumed by this plugin: **confirm
  that the plan exposes Vibe Code quota in the Mistral admin panel before relying
  on this route.** If the panel shows no Vibe Code quota for the plan, sign-in may
  succeed and requests may still bill — see "Confirming billing" below.

## Install

1. Link the package into the DSH profile. It declares no dependencies at all, so
   there is no install step inside it: `npm link ./dsh-mistral-subscription` (or a
   `file:` reference) from the profile, or point the profile row at this
   directory's `lib/index.js` directly the way `harness-dispatch` is loaded. The
   profile's plugin row loads `main` from `package.json`, which is `lib/index.js`.
2. Add the provider route and the subagent allowlist entry. The exact snippet is
   in `dsh-mistral-subscription/route.example.yml`; apply it to the profile patch
   that declares `llm-pi-ai` (`~/.dsh/profiles/desktop/cordis.patch.yml` on the
   owner's machine). The route deliberately carries no `apiKeyEnv` — the stored
   credential is the only source of auth for it.
3. Restart DSH. The route and the sign-in flow appear together; a profile without
   the sign-in flow simply never starts an authorization attempt.

`route.example.yml` is the authoritative form of both edits. This README does not
duplicate it.

## Sign in

The plugin ships its own settings card in the DSH web UI (lower settings
section: **Mistral subscription**). The card's **Sign in** button starts the
flow; if the browser popup is blocked, use the **Copy link** fallback and open
the URL manually — the card keeps polling for the outcome either way. The same
flow also appears in the harness's own sign-in surface as provider
**Mistral subscription**, with one method: **Sign in with console.mistral.ai**.

1. Starting it opens (or asks you to open) a URL the Mistral server issues,
   carrying the PKCE challenge and the sign-in process id. The plugin never builds
   that URL itself; it forwards whatever `console.mistral.ai` returned, after
   checking the URL stays on that origin.
2. In the browser you authenticate with the Mistral account that holds the
   subscription and approve the sign-in.
3. The plugin polls the server's `poll_url` for the outcome and, once the browser
   side reports `completed`, exchanges the returned exchange token plus the PKCE
   verifier for an API key.
4. The key is committed to the credential store before the flow resolves. It is
   never logged, printed, or written anywhere else — error messages carry no token
   material.

Outcomes you may see:

- **Completed** — the flow finishes and the route is usable.
- **Expired** — the sign-in window closed (the server also answers `410` once a
  process has expired). Start the flow again.
- **Denied / declined** — you said no in the browser, or the attempt was
  withdrawn. The flow settles as cancelled and nothing is exchanged or stored.
- **Error** — the server reported a failure; its message is surfaced, not the
  token.

Nothing is prompted in the terminal: the protocol is machine-driven once the
browser opens. A headless composition that never starts an authorization attempt
is unaffected.

## Models offered

The active route (authoritative form in `route.example.yml`) declares seven
models. **`deepseek-v4-1-flash-1017` is the primary model — this route exists
to serve it** (1M context window, vision input). The rest:

| id | context window | max tokens | stream verdict |
|---|---|---|---|
| `deepseek-v4-1-flash-1017` | 1048576 | 32768 | strings without thinking; arrays once thinking engages |
| `mistral-medium-2604` | 262144 | 32768 | strings without thinking; arrays with thinking (pinned alias of `mistral-medium-latest`) |
| `mistral-small-latest` | 262144 | 32768 | strings without thinking; arrays with thinking |
| `ministral-14b-2512` | 131072 | 32768 | strings (non-reasoning) |
| `ministral-8b-2512` | 131072 | 32768 | strings (non-reasoning) |
| `ministral-3b-2512` | 131072 | 32768 | strings (non-reasoning) |
| `codestral-2508` | 256000 | 32768 | strings (non-reasoning) |

Mistral's catalog carries more chat-capable models than the route exposes. The
complete inventory, with per-model stream verdicts, lives at the bottom of
`route.example.yml`. `mistral-large-2512` is held out pending a stream-shape
probe; `mistral-large-4` and the `zai-glm-*` models stream typed-array blocks
and are excluded.

### Reasoning pickers, live-verified per model

Mistral's API now accepts `reasoning_effort` as a top-level string (probed
2026-11-08). The route sets `compat.supportsReasoningEffort: true` and each
model declares only the levels its API actually takes:

| id | ladder |
|---|---|
| `deepseek-v4-1-flash-1017` | `off: none`, low, high, xhigh, max |
| `mistral-medium-2604` | `off: none`, high |
| `mistral-small-latest` | `off: none`, high |
| `glm-5-2` | `off: none`, low, high, max |
| `zai-glm-5-3`, `zai-glm-5-3-flash` | low, high, max — **no `off`**: `none` does not disable GLM thinking, so the level is omitted (an undeclared level is excluded from the picker) |
| `ministral-*`, `codestral-2508` | `reasoningEfforts: false` — the API answers `reasoning_effort is not enabled for this model` |

With thinking on, every model streams typed-array content blocks — which
pi-ai's `openai-completions` parser rejects with `text-delta text must be a
string` (it reads only STRING content). The normalizer translates them (see
below). The parser that would read them natively
(`mistral-conversations`) is not reachable from a hand-declared route: DSH's
`PROTOCOLS` registry only maps `openai-completions`, `openai-responses` and
`anthropic-messages`.

## Signing out

Sign out through the **plugin's own settings card** (the **Sign out** button
next to Sign in), not the harness's credential UI. That removes the stored
`llm-pi-ai/mistral-subscription` record; signing out of the browser session as
well is optional but revokes nothing on its own.

After a sign-out, the route has no auth to resolve. Requests on
`mistral-subscription` fail closed with `No API key for provider:
mistral-subscription` — there is no `MISTRAL_API_KEY` fallback, by design, so a
signed-out route is noisy, not quietly billed. Restore service by running the
sign-in flow again. The built-in `mistral` route is untouched by either action.

One consequence to know: if the profile's `agent-default-model` points at this
route (the owner's choice — see the rollback doc), a signed-out default model
fails too, and every session that starts without picking another model sees
the error until you sign in again.

## Confirming billing

Two checks, both in the Mistral admin panel:

1. Confirm the account's plan exposes **Vibe Code** quota, and note its remaining
   balance before a test run.
2. Run one small request on a `mistral-subscription` model, then re-check the
   panel: **Vibe Code usage should move and the API credit balance should not.**

If API credits move instead, the request went out as a console key (a different
route, or a stale credential from before this plugin) — stop and check which
provider id the session used. Usage moving against neither bucket means the plan
has no Vibe Code entitlement at all; the subscription does not cover this path.

The plugin itself has no usage endpoint. It only makes the request
authenticate with the subscription's key; nothing in it reports spend.

## Request normalizer (why the baseURL is localhost)

pi-ai replays session history verbatim. A conversation previously run on another
provider can carry `reasoning_content` on assistant messages, and Mistral's API
rejects that field on requests with `422 extra_forbidden`. The plugin therefore
starts a localhost-only normalizer (`lib/proxy.js`) on `proxyPort` (default
8477, set in the bundle config), and the route's `baseURL` points at it:
`http://127.0.0.1:8477/v1`. It deletes `reasoning_content`, `reasoning` and
`reasoning_text` from assistant messages before forwarding to
`https://api.mistral.ai`. Guards: 127.0.0.1 bind, `/v1/*` paths only, the
`Authorization` header passes through untouched (the key is never read here),
non-JSON bodies forward byte-for-byte, and streaming (SSE) is line-buffered
per event (translated when an event carries content blocks, otherwise passed
through unchanged). If the port is already bound — a previous copy of the same proxy —
the new instance does not own it and lets it serve. The proxy must run inside
the harness runtime: Mistral's TLS edge rejects standalone node and bun
clients with 401, while the Electron network stack passes.

The normalizer also repairs two cross-provider history-replay failure modes
and Mistral's own capacity errors:

- **Foreign tool-call markup.** Conversations previously run on DeepSeek/GLM
  models carry that family's native tool-call syntax (`｜DSML｜ invoke …`) in
  assistant text. A non-DSML model imitates the pattern instead of emitting
  proper tool calls, and the unparsable imitation surfaces as raw text. For
  models whose ids do not start with `deepseek`, the normalizer cuts
  assistant content at the first DSML marker.
- **Capacity 429 failover.** A `429 backend_out_of_capacity` (Mistral code
  3505) or rate-limit response on `/v1/chat/completions` is retried down the
  `failoverModels` order (default `mistral-medium-2604` →
  `mistral-small-latest`; the requested model is always tried first). A
  failover answer carries `x-mistral-proxy-model: <id>` naming the model that
  actually served it. Non-capacity 429s do not switch models.
- **Content-block translation, keyed on the response shape.** With thinking
  on, *any* model this route serves — the Z.ai GLM family
  (`zai-glm-5-3`, `zai-glm-5-3-flash`, `glm-5-2`) but also
  `mistral-medium-2604`, `mistral-small-latest` and
  `deepseek-v4-1-flash-1017` — returns `content` as typed array blocks:
  `{type: "thinking", …}` for reasoning, a final plain string or
  `{type: "text"}` block for the answer. pi-ai reads only string content and
  would fail with `text-delta text must be a string`. The normalizer
  translates on every response (the translators are no-ops for plain-string
  content): thinking text maps to the standard `reasoning_content` field,
  answer text stays `content`, on both the stream and non-stream paths.
- **Reasoning effort on failover.** When the request switches to a failover
  model, the normalizer deletes `reasoning_effort` before forwarding: the
  failover model may not accept the requested model's level (mistral-medium
  and mistral-small take only `high`/`none` and would answer 400 code 3051),
  so it answers with its default — no thinking — instead of hard-failing.

## Limitations

- **Reasoning levels are per model, not free-form.** Each model offers only the
  levels its API accepts (see "Reasoning pickers, live-verified per model");
  a model outside the ladder set stays `reasoningEfforts: false`. A failover
  answer does not carry the requested level — it runs at the failover model's
  default.
- **Partner-purchased plans cannot enable pay-as-you-go.** With such a plan, when
  the included quota is exhausted there is no overflow billing to fall back on:
  it is a hard stop, not a slower path. Requests fail until the quota resets or
  the plan changes.
- The route has no key in config, by design. Anything that expects to find
  `MISTRAL_API_KEY` for this provider will not find one, and it would not be the
  subscription key anyway.
- Sign-in is interactive. There is no headless credential provisioning in this
  package, by design: the key can only be minted by a human completing the
  browser step.

## Deliberate divergences from the omp reference extension

The sign-in protocol is modeled on the reference `omp-mistral-subscription`
extension. Where this package diverges, the divergence is deliberate and
annotated in code; the model-list divergence is annotated in
`route.example.yml`:

- **A denial settles as cancelled**, not as a failed attempt — you said no, so
  nothing failed.
- **`encodeURIComponent(processId)`** on every URL that carries the process id;
  the reference interpolates it raw.
- **A path-boundary check** on the returned sign-in URL (origin AND path prefix)
  where the reference checks the origin only.
- **The model list is narrower than the reference provider's** — see "Models
  offered" above for why.
