# oh-my-pi on OpenCode Go

## The failure

Without a session header, OpenCode Go rejects every request:

```text
400 Request is missing x-opencode-session and cannot be routed efficiently.
```

The header is a per-conversation routing id. dsh already adds it in
`@earendil-works/pi-ai/dist/providers/opencode-headers.js`; omp 15.7.3 had the
`sessionId` available in its stream options but never wrote it as a header.

## The fix

Two small patches in the installed omp packages:

1. `@oh-my-pi/pi-agent-core/src/agent-loop.ts` already spreads `...config`
   into the stream options, so `sessionId` reaches `pi-ai`.
2. `@oh-my-pi/pi-ai/src/providers/openai-completions.ts` now adds the header
   for `opencode-go` and `opencode-zen`:

```ts
{
  ...options?.headers,
  ...(model.provider === "opencode-go" || model.provider === "opencode-zen"
    ? options?.sessionId
      ? { "x-opencode-session": options.sessionId }
      : {}
    : {}),
}
```

The value is omp's session id, so each omp process gets its own routing id.

## Verify

```bash
omp --model opencode-go/beam-free --no-tools --no-session -p 'Reply with exactly OK'
```

It should print `OK`. The same works for `opencode-go/deepseek-v4.1-flash` and
`opencode-go/deepseek-v4-pro`.

## Fallback after an omp update

`omp update` replaces the installed packages and removes the patch. The
persistent fallback is in `~/.omp/agent/models.yml`:

```yaml
providers:
  opencode-go:
    headers:
      x-opencode-session: "!uuidgen"
```

omp sends that literal value as the header. It satisfies the routing check even
though it is not a real UUID; the dynamic patch overrides it when present.
Keep this fallback, or reapply the two-line patch after an update.

## Using omp as the pair reviewer

The dispatcher has a read-only `pair-omp` role:

```json
{
  "model": "opencode-go/beam-free",
  "thinking": "low",
  "readonly": true,
  "agent": "omp"
}
```

Enable it globally for a repository:

```json
{
  "pairDefault": "review",
  "dshPairDefault": "pair-omp"
}
```

`dshPairDefault` is read only by the dsh dispatcher; the shared Pi preflight
continues to see `pairDefault: "review"` and does not reject the omp role.

or per task:

```md
pair: pair-omp
```

The dispatcher then runs the implementer as a dsh subagent and the reviewer as
`omp --mode json -p --no-session --model opencode-go/beam-free --thinking low
--tools read,grep,glob`.
