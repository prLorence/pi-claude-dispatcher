---
name: dispatch-plan
description: Hand implementation work to cheap parallel workers. Use when a task splits into several independent edits. Write a plan file to .plans/inbox/, wait for the Pi dispatcher to run it, then review the results.
---

# Dispatch a plan to Pi workers

You are the orchestrator. A Pi session in this repo runs the `pi-plan-dispatch`
extension. It watches `.plans/inbox/`, runs each task on a cheap worker model
(DeepSeek V4.1 Flash), and writes results to `.plans/done/<id>/`.
Your job is to plan, split, dispatch, and review. Leave bulk implementation to the workers.

## When to dispatch

- Dispatch work that splits into tasks that each touch a known, small set of files.
- Do it yourself when the job is tiny, needs judgment across the whole codebase, or one step depends on seeing the result of the last.

## 1. Write the plan

Use this exact format:

```markdown
---
id: <kebab-case-id, unique>
status: ready
max_parallel: 3
---
<Shared context every worker needs: goal, conventions, key types/interfaces,
commands to run tests. Workers see ONLY this plus their own task. Be explicit.>

## task: <task-id>
files: path/one.ts, path/two.test.ts
depends_on: []
<Instructions. Name the exact function signatures, behaviour, edge cases,
and the test command to run. Write it for a capable but context-free engineer.>

## task: <another-id>
files: src/other/
depends_on: [<task-id>]
...
```

Rules:

- `files:` lists every path the task may edit. A directory (`src/other/`) covers everything under it. Tasks whose files overlap never run at the same time. A task with no `files:` runs alone, so always list files.
- `depends_on:` holds task ids that must finish first. If a dependency fails, its dependents are skipped.
- Optional per-task overrides: `model:` and `thinking:` (for example `thinking: high` for a tricky task).
- Put shared interfaces in the plan context, or in an early task that others depend on, so parallel workers agree on them.
- Workers don't commit. You review and commit.

## 2. Drop it atomically

Never write straight into the inbox, because the dispatcher may read a half-written file:

```bash
mkdir -p .plans/inbox
# write the file to .plans/inbox/.<id>.md.tmp first, then:
mv .plans/inbox/.<id>.md.tmp .plans/inbox/<id>.md
```

To write a draft without running it, use `status: draft`, then change it to `ready`.

## 3. Wait for results

```bash
id=<id>; for i in $(seq 1 120); do
  [ -f ".plans/done/$id/_summary.md" ] && break
  [ -f ".plans/failed/$id.error.md" ] && break
  sleep 15
done; cat ".plans/done/$id/_summary.md" 2>/dev/null || cat ".plans/failed/$id.error.md"
```

- `.plans/failed/<id>.error.md` means the plan was rejected (a format error). Fix the plan and drop it again.
- If nothing happens after about a minute, the Pi session probably isn't running. Tell the user.

## 4. Review

1. Read `_summary.md`, then each `<task>.md` for failed tasks or any task whose `NEEDS:` isn't `none`.
2. Check the actual changes with `git diff` and run the tests yourself. Don't trust worker reports blindly.
3. Fix small issues directly. For larger rework, write a follow-up plan with a new id.
4. Report to the user: what was done, what failed, and the cost line from the summary.
