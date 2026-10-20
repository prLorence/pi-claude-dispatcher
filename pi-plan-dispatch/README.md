# pi-plan-dispatch (Phase 1)

A Pi extension that watches `.plans/inbox/` in your repo. When an orchestrator, such as Opus 5.5 in Claude Code, drops a plan there, the extension fans the tasks out to headless Pi workers (DeepSeek V4.1 Flash on OpenCode Go by default) and writes the results back as files.

```
Claude Code (Opus) --writes--> .plans/inbox/<id>.md
Pi + this extension --runs tasks--> pi -p workers (DeepSeek)
                     --writes--> .plans/done/<id>/_summary.md + <task>.md
Claude Code (Opus) --reads + reviews--> git diff, tests, commit
```

## Install

```bash
# 1. Pi with your OpenCode Go key
pi            # then /login and pick OpenCode Go, or set the key per Pi's providers docs

# 2. The extension: pick one
pi install ./pi-plan-dispatch                        # as a package
cp -r pi-plan-dispatch ~/.pi/agent/extensions/       # or as a global extension

# 3. The Claude Code skill
cp -r dispatch-plan ~/.claude/skills/
```

Add `.plans/` to your `.gitignore`.

## Use

1. Open Pi in the repo and leave it running. The footer shows `plans: watching`.
2. In Claude Code, ask Opus to do the work "using dispatch-plan".
3. Opus writes the plan, the Pi window shows the tasks running, and Opus picks up the results.

Commands inside Pi:

| Command | What it does |
|---|---|
| `/plans` | Status: running plan, queue, worker settings |
| `/plans dry on` / `off` | Simulate workers (no model calls), handy for testing |
| `/plans stop` | Abort the running plan |
| `/plans scan` | Re-scan the inbox now |
| `pi --plans-dry-run` | Start in dry-run mode |

## Config: `.plans/config.json` (optional, per repo)

```json
{
  "model": "opencode-go/deepseek-v4.1-flash",
  "thinking": "low",
  "maxParallel": 3,
  "timeoutMinutes": 20,
  "retries": 1,
  "tools": [],
  "dryRun": false
}
```

- **`thinking`:** DeepSeek V4.1 Flash only supports `low`, `high` and `max`.
- **`tools`:** empty means workers get Pi's defaults plus your installed extensions, such as lsp-pi.
- **Overrides:** a plan's frontmatter, or an individual task, can override `model` and `thinking`.

## How scheduling works

- Plans run one at a time, oldest first. Only plans with `status: ready` are picked up.
- A task starts when its `depends_on` tasks are done and none of its `files:` overlap with a running task. A directory covers everything under it.
- A task without `files:` runs alone.
- Failed tasks retry `retries` times. If a task still fails, its dependents are skipped.
- A malformed plan (unknown dependency, cycle, no tasks) moves to `.plans/failed/` with an `.error.md` explaining why.
- Workers run with `PI_PLAN_DISPATCH_WORKER=1`, so they never start their own watcher.

## Folders

```
.plans/inbox/      drop plans here (write .tmp, then rename)
.plans/running/    plan currently executing
.plans/done/<id>/  plan.md, _summary.md, one <task>.md per task
.plans/failed/     rejected plans + reason
```

## Known limits (Phase 1)

- Pi must be open in that repo. Phase 2 (the standalone worker) removes this.
- Workers share one checkout. File-overlap scheduling prevents edit collisions, but parallel test runs or builds can still interfere with each other.
- A plan left in `running/` after a crash isn't resumed. Move it back to `inbox/` to rerun the whole plan.
- Workers are told to stay inside their files, but nothing enforces it. Review `git diff`.
