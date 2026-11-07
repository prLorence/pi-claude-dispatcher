# OpenDesign Cloud usage and credits

## Bottom line

OpenDesign's **model API** accepts an API key, but its **credits/balance API is
cookie-only**. An API key can spend credits; it cannot read them. Do not treat a
key-authenticated usage route as supported.

## Hosts

| Purpose | Base | Auth |
|---|---|---|
| Model API | `https://amr-link.open-design.ai/v1` | `Authorization: Bearer <key>` |
| Console API | `https://amr-api.open-design.ai/api` | browser session cookie + `x-vela-workspace-id` |

`api.amr.dev` appears in old console copy but does **not resolve** (NXDOMAIN).

## Console credit routes

These were found in the console bundle and are called with
`credentials: "include"`:

```text
GET /v1/workspaces/{id}/credits/me
GET /v1/workspaces/{id}/wallet/balance
GET /v1/workspaces/{id}/billing/snapshot
GET /v1/workspaces/{id}/billing/ledger
GET /v1/workspaces/{id}/billing/usage
GET /v1/workspaces/{id}/billing/coding-plan-usage
GET /v1/billing/summary
```

Unauthenticated calls return `401 {"error":"unauthenticated"}`. The response is
identical with or without a Bearer header, so the API key is not consulted at
all. The exact success payload was not observed.

## What the usage widget does

`opendesign-cloud` is a known provider with an empty `usageUrl`. It shows
`no-endpoint` and the message "OpenDesign credits are console-only; an API key
cannot read the balance." If a cookie-backed proxy or a future API route is
available, set `usageUrl` on the provider; the usage parser understands
`balance`, `credits`, `remaining`, `used`, `limit`, `currency` and nested
`data`/`billing` wrappers.

The public API does expose model prices at
`GET https://amr-api.open-design.ai/api/v1/public/model-prices` (no auth); that
is a price list, not a balance.
