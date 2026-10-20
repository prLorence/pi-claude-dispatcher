<!-- Pulled 2026-10-20 from Claude Code cloud session cse_01R4rZfrv2W7JuFqXesGzKVt ("Pi Harness") via `claude --teleport`. Written by that session from its own history. -->

# Handoff: Pi Harness / `pi-plan-dispatch`

## 0. Who and where

- **User:** Paul. Timezone Asia/Manila (UTC+8).
- **Repo location:** probably `/Users/phetoush/Documents/repos/pi-plan-dispatch-phase1`. I'm inferring this from the current session's scratchpad path; nobody stated it.
- **Where Phase 1 was built and tested:** a Linux cloud sandbox, not on the Mac. It was delivered as the zip `pi-plan-dispatch-phase1.zip`.
- **Pi version targeted and tested:** `@earendil-works/pi-coding-agent@1.3.0`. The old `@mariozechner/pi-coding-agent` stops at 0.73.1.

## 1. First message and goal

The first user message, verbatim. It came through speech-to-text, so "cloud code" means Claude Code:

> https://pi.dev/
>
> Yeah, about this tool, it mentioned that it can use cloud code and other, coding agents. So I was thinking that if we could use this that like harness, this would be the interface and I would set up the cloud code and open code to have its own tools, set of tools, etcetera. Is that even possible? So yeah, it's something like an orchestrator or some sort.

**Overall goal as it evolved:** one smooth workflow with no manual back-and-forth between CLI tools.

- A strong, expensive orchestrator plans: Claude Opus 5.5 at medium effort.
- Cheap workers implement: DeepSeek V4.1 Flash on the user's OpenCode Go subscription.

The user stated the main pain point directly: "the back and forth between CLI tools."

## 2. Decision log, in order, with reasons

1. **Pi can orchestrate other agents, but only through packages.** Pi has no built-in subagents or orchestration. Packages found:
   - `pi-harness-delegate`: Claude, Codex, OpenCode, Amp, Devin.
   - `pi-external-agent`: pi, claude, codex.
   - `pi-agent-bridge`: Codex and Claude, an early foundation.
   - `@yorch/pi-claude-delegate`: deprecated, now a wrapper around pi-harness-delegate.
2. **User's proposed stack:** Pi as interface, Opus 5.5 medium as orchestrator, DeepSeek V4.1 Flash as workhorse, plus the OpenCode Go subscription. ("Deep Six" in the transcript means DeepSeek.)
   - I first suggested Opus as Pi's main model, with workers as Pi subagents through `@tintinweb/pi-subagents`, or through `pi-harness-delegate` to OpenCode.
   - This was later superseded by decision 7.
3. **LSP.** The user has OpenCode set up with LSP servers and asked whether Pi can do the same.
   - Pi can, through `lsp-pi` or `pi-lsp-extension`. Both use language servers already on `PATH`.
   - Recommendation: keep one tool setup in Pi instead of separate tool sets per agent, to avoid config drift.
   - Caveat: OpenCode may have auto-downloaded its servers into its own cache, so they may not be on `PATH`.
4. **User: "replace open code, the CLI tool with Pi and Claude code with also Pi… just going to use their subscriptions."**
   - OpenCode Go works cleanly in Pi with an API key.
   - The Claude subscription only works in Pi through `pi-claude-bridge`, which is unofficial and risky.
5. **OpenCode as the harness instead was compared.**
   - OpenCode removed Anthropic OAuth on March 19, 2026 (PR #18186), after legal demands from Anthropic. So a Claude subscription doesn't work in OpenCode.
   - OpenCode has subagents and LSP built in.
6. **Billing of `pi-claude-bridge`, including a correction.**
   - I first said that since June 15, 2026, Agent SDK use draws from separate monthly credits ($20 Pro / $100 Max 5x / $200 Max 20x).
   - I then corrected this: Anthropic paused that change, per Digital Applied (updated June 16, 2026) and DevOps.com. I found no later reinstatement.
   - Current understanding: the bridge draws from normal Pro/Max subscription limits.
   - Risks:
     - Requests that look like third-party use may be billed as Extra Usage. The bridge blocks turns whose system prompt contains Pi's built-in text.
     - Session rebuilds (abort, `/compact`, `/tree`) re-send the whole conversation and miss the prompt cache.
     - The 1M context needs Max or Extra Usage.
     - The bridge blocks MCP from `~/.claude.json` and `.mcp.json` by default.
     - Anthropic says it will give notice before any revised change.
7. **The user's idea: a file-based hand-off.** A Pi extension watches a directory. Opus drops a plan document there, and the extension fans tasks out to DeepSeek workers. I presented two options:
   - **Option 1:** everything inside Pi.
   - **Option 2:** Opus runs in Claude Code, on the official subscription with full quota and no bridge. It writes plan files. Pi's extension runs the workers and writes results back as files.

   **User chose Option 2: "yes the option 2 is my vision."** The main reason: it removes both the CLI back-and-forth and the gray-zone Opus billing.
8. **Runner question.** I offered a standalone script (my recommendation) or a Pi extension. User answered:

   > "let's do it in phases, pi extension first and then once that proves to be working, we would work on the worker"

   So Phase 1 is a Pi extension.
9. **Isolation question.** User chose "File-overlap scheduling (Recommended)" over a git worktree per task. Workers share one checkout, and tasks whose files overlap never run at the same time.

## 3. Architecture

```
Claude Code (Opus 5.5, user's subscription) --writes--> .plans/inbox/<id>.md
Pi session + pi-plan-dispatch extension --spawns--> headless `pi` workers (DeepSeek V4.1 Flash via opencode-go)
                                        --writes--> .plans/done/<id>/_summary.md + <task>.md
Claude Code (Opus) --reads/reviews--> git diff, tests, commit
```

### Components

**`pi-plan-dispatch/core.ts`.** No Pi imports, so it can be tested on its own.

- **`DEFAULT_CONFIG`:**
  - `model: "opencode-go/deepseek-v4.1-flash"`
  - `thinking: "low"`
  - `maxParallel: 3`
  - `timeoutMinutes: 20`
  - `retries: 1`
  - `tools: []`
  - `piCommand: "pi"`
  - `dryRun: false`
- **`getDirs` / `ensureDirs`:** paths under `<cwd>/.plans/`.
- **`loadConfig`:** merges `.plans/config.json` over the defaults.
- **`parsePlan`:**
  - Frontmatter is required. Keys: `id`, `status`, `max_parallel`, `model`, `thinking`. Inline `# comments` are stripped.
  - Text before the first task becomes shared context.
  - Tasks are `## task: <id>` sections with leading lines `files:`, `depends_on:`, `model:`, `thinking:`. Lists may be comma-separated or `[a, b]`.
  - Throws `PlanParseError` on: missing frontmatter, no tasks, duplicate id, empty body, unknown dependency, or a dependency cycle (`detectCycle`).
- **`readStatus`:** cheap check of `status`.
- **`filesOverlap`:** two file lists overlap if they share a path, or one is a directory prefix of the other.
- **`pickRunnable(plan, limit)`:** picks tasks that can start now.
  - A task's dependencies must all be done.
  - It must not overlap with running or already-picked tasks.
  - A task with no `files:` runs only alone.
  - Tasks whose dependency failed or was skipped are marked skipped.
- **`buildWorkerPrompt`:** plan context, the task, ownership rules ("You own ONLY these paths…", no git commits), and a required final format: `STATUS: done | failed`, `CHANGED:`, `TESTS:`, `NOTES:`, `NEEDS:`.
- **`runWorker`:** spawns `pi --mode json -p --no-session --model <m> --thinking <t> [--tools a,b] <prompt>` with env `PI_PLAN_DISPATCH_WORKER=1`.
  - It parses JSONL `message_end` assistant messages: the last text, cost from `usage.cost.total`, `stopReason`, and `errorMessage`.
  - Non-JSON stdout lines are collected as error text.
  - On timeout or abort: SIGTERM, then SIGKILL after 5 s.
  - A run counts as failed on any of: non-zero exit, `stopReason` error or aborted, `errorMessage`, a self-reported `STATUS: failed`, or no assistant output. The last condition was a fix: Pi exits 0 on "No API key found".
  - Dry-run mode simulates a worker in 1.5–3 s and echoes the prompt it would have sent.
- **`writeTaskResult` / `writeSummary`:** write `<task>.md` and `_summary.md`. The summary has a table plus a total cost.

**`pi-plan-dispatch/index.ts`** (the extension):

- **Flag:** `--plans-dry-run`.
- **On `session_start`:**
  - Skips everything if `PI_PLAN_DISPATCH_WORKER=1`, so workers don't start their own watchers.
  - Creates the directories and warns about stale files in `running/`.
  - Watches `inbox/` with `fs.watch`, debounced 750 ms.
- **On `session_shutdown`:** closes the watcher and aborts the running plan.
- **Queue:** runs one plan at a time, oldest `mtime` first. Only `.md` files that don't start with `.` and have `status: ready` are picked up.
- **Rejected plans** move to `failed/<base>.md`, with the reason in `failed/<base>.error.md`.
- **Plan lifecycle:**
  - The plan moves to `running/<id>.md` while it runs.
  - Retries follow `retries`. Leftover pending tasks become skipped.
  - At the end, the plan moves to `done/<id>/plan.md`.
- **UI:**
  - Footer status: `plans: watching` / `plans: <id> n/m`.
  - A widget (`belowEditor`) shows per-task icons `· ▶ ✓ ✗ −` and each running task's latest line.
- **On finish:**
  - `ctx.ui.notify`.
  - `pi.sendMessage({customType:"plan-dispatch", display:true})`. It deliberately does not trigger a turn.
- **Commands:** `/plans` (status), `/plans scan`, `/plans dry on|off`, `/plans stop`.

**`pi-plan-dispatch/package.json`:**

- name `pi-plan-dispatch`, v0.1.0, `"type":"module"`
- `keywords:["pi-package"]`, `"pi":{"extensions":["./index.ts"]}`
- peerDependency `@earendil-works/pi-coding-agent >=1.3.0`
- `tsconfig.json` was used only for typechecking and removed from the bundle.

**`pi-plan-dispatch/README.md`:** install, usage, config, scheduling rules, folders, limits.

**`dispatch-plan/SKILL.md`** (Claude Code skill, installed to `~/.claude/skills/dispatch-plan/`):

- **When to dispatch:** work that splits into tasks, each touching a known, small set of files.
- **Plan format and rules:** as below.
- **Atomic drop:** write `.plans/inbox/.<id>.md.tmp`, then `mv` it to `<id>.md`. Use `status: draft` to hold a plan back.
- **Wait loop:** 120 × 15 s (about 30 min), polling for `.plans/done/$id/_summary.md` or `.plans/failed/$id.error.md`.
- **Review:** read the summary and failed or `NEEDS` reports, check `git diff`, run the tests, fix or write a follow-up plan, and report the cost.

### Plan file format

```markdown
---
id: feature-x
status: ready        # only "ready" is picked up; "draft" is ignored
max_parallel: 3      # optional
model: ...           # optional, overrides config
thinking: ...        # optional
---
Shared context for every worker.

## task: api
files: src/api/users.ts
depends_on: []
Instructions...
```

### Folders

- `.plans/inbox/`
- `.plans/running/`
- `.plans/done/<id>/` containing `plan.md`, `_summary.md`, `<task>.md`
- `.plans/failed/`
- `.plans/config.json` (optional)
- Advice given: add `.plans/` to `.gitignore`.

### Config: `.plans/config.json`

Keys: `model`, `thinking`, `maxParallel`, `timeoutMinutes`, `retries`, `tools`, `piCommand`, `dryRun`.

- Empty `tools` means Pi's defaults plus the user's installed extensions, for example `lsp-pi`.

### Models and providers

- **Orchestrator:** Claude Opus 5.5, medium effort, running in Claude Code on the user's subscription. The exact model ID in Claude Code is unknown.
- **Worker:** `opencode-go/deepseek-v4.1-flash`, per the pi.dev model page `pi.dev/models/opencode-go/deepseek-v4-1-flash`.
  - 1M context, 384K max output.
  - Thinking levels: only `low`, `high`, `max`. `medium` and others map to null.
- In a test, Pi 1.3.0 resolved the `opencode-go` provider and returned "No API key found for opencode-go." The exact steps to authenticate OpenCode Go in Pi are unknown; the README says `/login` or Pi's providers docs.

### Pi API facts used

- **Extension shape:** default export `(pi: ExtensionAPI)`, loaded by jiti, so no compile step.
- **Lifecycle rule from the docs:** don't start watchers in the factory. Start them in `session_start` and clean up in `session_shutdown`.
- **APIs used:** `ctx.ui.setStatus`, `setWidget(key, string[], {placement})`, `notify`; `pi.registerCommand`, `registerFlag`, `getFlag`, `sendMessage`.
- **Loading:** `pi --extension ./index.ts` during development, `pi install ./pi-plan-dispatch`, `pi remove`.
- **Reference examples in the package:** `examples/extensions/file-trigger.ts` and `examples/extensions/subagent/` (spawns `pi --mode json -p --no-session`).

## 4. Roadmap

**Phase 1 (built):** the Pi extension, which watches, parses, schedules and dispatches `pi -p` workers, plus the Claude Code skill. Its job is to prove the hand-off works.

**Phase 2 ("the worker"):** run only once Phase 1 is proven on the Mac. The user's wording was "once that proves to be working, we would work on the worker." My working interpretation is a standalone watcher or worker runner that removes the need to keep a Pi window open. Its exact scope is unknown or unconfirmed, so confirm it with the user.

**Later ideas** (mentioned, not committed):

- Git worktree per task. Rejected for now in favour of file-overlap scheduling.
- Resuming crashed plans.
- Enforcing file ownership instead of relying on prompt instructions.
- Delegating to the OpenCode or Claude Code harness through `pi-harness-delegate` for specialist tasks.
- Confirming that LSP tools pass through to workers.

## 5. Status of what's built

Delivered: `pi-plan-dispatch-phase1.zip`, containing `dispatch-plan/SKILL.md` and `pi-plan-dispatch/{index.ts, core.ts, README.md, package.json}`.

**Verified in the Linux sandbox with Pi 1.3.0:**

- `tsc` strict typecheck passes. The config used was NodeNext with `allowImportingTsExtensions`.
- **Core unit test** (tsx, with a fake `pi` script emitting JSONL), all passing:
  - parsing, overlap including directory prefixes, the parse-error cases
  - scheduling order: `a#1 a#2 b#1 c#1 d#1 e#1 e#2`
  - retry once, then fail, then dependent skipped
- **Live TUI tests in tmux:**
  - The extension loads both with `--extension` and when installed as a package.
  - Footer shows `plans: watching`.
  - An atomically written plan ran 3/3. Drafts were ignored.
  - A broken plan (unknown dependency) was rejected with an error file.
  - The widget showed parallel and overlap scheduling.
  - `/plans` status and `/plans dry on` worked.
  - The finish message appears in the transcript.
- **Real `pi` worker spawn:** reached the provider and failed cleanly with "No API key found." This is what exposed the no-output bug, now fixed.

**Not verified:**

- A real DeepSeek or OpenCode Go run (no key in the sandbox).
- Running on macOS. `fs.watch` behaviour on macOS is unknown.
- The skill used by Opus inside real Claude Code.
- Whether LSP extensions such as `lsp-pi` are available to workers.
- Cost reporting with real usage.

**Next step suggested to the user:**

1. Install both parts and log Pi into OpenCode Go.
2. Run `/plans dry on` and have Opus write a tiny plan.
3. Run `/plans dry off` and try one small real task.

I also offered to commit the files to a connected Mac folder; none was connected.

## 6. Known limits, risks, open questions

- **Phase 1 needs a Pi window open** in that repo.
- **Shared checkout:** overlap scheduling prevents edit collisions, but parallel tests or builds can interfere with each other.
- **Ownership isn't enforced:** workers are only told to stay inside their files. Review `git diff`.
- **No crash resume:** a plan left in `running/` must be moved back to `inbox/` by hand, and it reruns whole.
- **One plan at a time:** plans don't run concurrently.
- **Worker extension guard:** if the extension is installed globally, workers load it too. The env guard `PI_PLAN_DISPATCH_WORKER=1` prevents recursive watchers.
- **Billing / terms:** check Anthropic's current Help Center terms. The Option 2 design deliberately keeps Opus inside Claude Code to avoid the bridge.
- **Open questions:**
  - The exact scope of Phase 2.
  - Where the repo lives and whether to git-init it (unknown).
  - The Opus 5.5 model ID and effort setting in Claude Code (unknown).
  - The OpenCode Go key setup in Pi (unknown).
  - Whether other OpenCode Go models should serve as extra workers (the user mentioned "other open code go subscription"; unspecified).

## 7. User preferences and constraints

- Wants a single interface and no manual back-and-forth between CLI tools.
- Has a Claude subscription (Pro or Max tier unknown) and an OpenCode Go subscription, and wants to use the subscriptions rather than API billing where possible.
- **Orchestrator:** Opus 5.5 at "medium". **Workhorse:** DeepSeek V4.1 Flash.
- Already has OpenCode configured with LSP servers and values LSP as a base tool for agents.
- Wants phased delivery: prove the Pi extension first, then build the worker.
- Chose file-overlap scheduling over worktrees.
- Prefers reasonably concise responses.

## Sources referenced

- pi.dev
- pi.dev/packages/pi-harness-delegate
- github.com/yorch/pi-claude-delegate
- github.com/keen99/pi-external-agent
- github.com/jakeryderv/pi-agent-bridge
- github.com/elidickinson/pi-claude-bridge
- pi.dev/packages/@tintinweb/pi-subagents
- pi.dev/packages/lsp-pi
- pi.dev/packages/pi-lsp-extension
- pi.dev/models/opencode-go/deepseek-v4-1-flash
- opencode.ai/go
- opencode.ai/docs/agents
- falcao.org (Anthropic crackdown timeline)
- digitalapplied.com (June 15 change paused)
- devops.com
- yage.ai (Pi billing article)
- codex.danielvaughan.com (meta-harness pattern)
