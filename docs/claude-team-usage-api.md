# Claude Code team usage

## What is available

Claude Code exposes its plan limits through its own `/usage` command. The
supported headless path for a widget is:

```bash
claude -p '/usage' --output-format json
```

It exits 0 with a JSON envelope whose `result` contains:

```text
Current session: 13% used · resets Nov 5 at 8:09pm (Asia/Manila)
Current week (all models): 50% used · resets Nov 9 at 9:59pm (Asia/Manila)
```

It has `local_command: "usage"`, makes no model request, and costs nothing. The
CLI authenticates itself; the plugin never reads `~/.claude`, the keychain, or
any OAuth token.

The undocumented HTTP route used by the CLI is
`GET https://api.anthropic.com/api/oauth/usage`, but it requires Claude Code's
OAuth session and is rate-limited. Do not build against it as a public API.

## What does not exist

- **No public API-key route for Team subscription limits.** The Anthropic Admin
  API's `usage_report/messages` and `cost_report` cover Console/API-key
  organizations, not Claude Code Team subscriptions.
- **No API for the 5-hour/weekly windows.** The Admin API reports token/cost
  totals in buckets you choose; it has no utilization, reset, or allowance
  window. `rate_limits` there means API RPM/ITPM/OTPM, not Claude Code limits.
- The per-user `usage_report/claude_code` route is Console-only; Enterprise
  Analytics is not available on Team.
- The Claude Code Team spend-report CSV (email, product, model, tokens, USD,
  90 days) is the only per-user export; it is not live.

## What the usage plugin does

`harness-usage` has a `claude-code` provider with `kind: "claude-usage"`. It
runs the CLI with `-p /usage --output-format json`, parses the session and week
lines into 5h/week windows, and shows percent plus the reset text. Failures
surface as an `error` status; no token is read or stored.
