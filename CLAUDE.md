# Pi Harness: pi-plan-dispatch

Full history, decisions and open questions: [docs/pi-harness-context.md](docs/pi-harness-context.md). Read it before changing the design.

## Goal

Get rid of the manual back-and-forth between CLI tools.

- **Orchestrator:** Claude Opus 5.5 at medium effort, in Claude Code on the user's subscription. It plans, splits, reviews and commits.
- **Workers:** cheap headless Pi workers (`opencode-go/deepseek-v4.1-flash`, through the user's OpenCode Go subscription). They implement.
- **Hand-off:** files under `.plans/`.

This is "Option 2" from the design discussion. Opus stays in Claude Code on purpose, so it avoids the unofficial `pi-claude-bridge` and its billing gray zone. Don't route Opus through Pi.

## Layout

| Path | What it is |
|---|---|
| `pi-plan-dispatch/core.ts` | Pure logic, no Pi imports, testable alone: config, plan parsing, file-overlap scheduling, worker spawn (`pi --mode json -p --no-session`), result files |
| `pi-plan-dispatch/index.ts` | Pi extension: watches `.plans/inbox/` from `session_start`, runs a queue of one plan at a time, footer and widget UI, `/plans` commands |
| `pi-plan-dispatch/README.md` | User-facing install, usage, config, scheduling rules, limits |
| `dispatch-plan/SKILL.md` | Claude Code skill that teaches Opus the plan format, the atomic drop, the wait loop and the review steps |

Targets `@earendil-works/pi-coding-agent >=1.3.0`. Extensions load through jiti, so there's no build step.

## Settled decisions

- Phased delivery. Phase 1 is a Pi extension, and it's built. Phase 2 is a standalone worker so no Pi window has to stay open. Start Phase 2 only after Phase 1 is proven on the Mac, and confirm its scope with the user first.
- Isolation uses file-overlap scheduling in one shared checkout, not a git worktree per task.
- Workers run with `PI_PLAN_DISPATCH_WORKER=1` and must never start their own watcher.
- Pi exits 0 on errors like "No API key found", so a worker with no assistant output counts as failed. Keep that check.

## Status (Phase 1)

- **Verified in a Linux sandbox:** strict `tsc`, the core unit tests with a fake `pi`, and live TUI tests in tmux.
- **Not verified yet:**
  - a real DeepSeek/OpenCode Go run
  - macOS `fs.watch` behaviour
  - the skill used by real Claude Code
  - LSP extensions reaching workers
  - real cost reporting
- **Suggested next step:** install both parts and log Pi into OpenCode Go. Run a tiny plan with `/plans dry on`, then one small real task with `/plans dry off`.

## Open questions

- Phase 2 scope.
- ~~How to set up the OpenCode Go key in Pi.~~ Resolved: pi has a built-in `opencode-go` provider; key lives in `~/.pi/agent/auth.json`, models smoke-tested. See [docs/pi-migration.md](docs/pi-migration.md).
- Whether other OpenCode Go models should also serve as workers.
- Whether to `git init` this repo.
