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

The flow appears in the harness's own sign-in surface as provider
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

| id | context window | max tokens |
|---|---|---|
| `zai-glm-5-3` | 1048576 | 32768 |
| `mistral-medium-2604` | 262144 | 32768 |
| `mistral-small-latest` | 262144 | 32768 |

These are the only models the route declares. Mistral offers more on the Vibe
Code surface; they are not exposed here, and adding one means adding it to the
route and its context limits explicitly.

## Signing out

Sign the **Mistral subscription** provider out through the harness's credential
UI. That removes the stored `llm-pi-ai/mistral-subscription` record; signing out
of the browser session as well is optional but revokes nothing on its own.

After a sign-out, the route has no auth to resolve. Requests on
`mistral-subscription` fail closed with the harness's missing-credential error
rather than silently falling back to `MISTRAL_API_KEY` or to an unauthenticated
call — so a signed-out route is noisy, not quietly billed. Restore service by
running the sign-in flow again. The built-in `mistral` route is untouched by
either action.

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

## Limitations

- **No reasoning-effort control is assumed for `zai-glm-5-3`.** Do not send a
  reasoning-effort parameter on this route and do not rely on one being honored.
  Behavior that depends on a specific effort level (cost, latency, thinking
  depth) is unverified here.
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
