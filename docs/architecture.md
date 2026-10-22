# Architecture

You talk to Sonnet 5.5, the orchestrator, in the main Claude Code session, and it writes plans but never code. Opus 5.5 reviews plans as the read-only `plan-auditor`, cheap Pi workers implement them, files under `.plans/` are the hand-off, and in the diagrams a solid edge is built while a dashed edge is planned.

## Components and data flow

```mermaid
flowchart TB
  user["You"]

  subgraph cc["Claude Code (your subscription)"]
    orch["Orchestrator<br/>Sonnet 5.5, main session<br/>writes only .plans/ artifacts"]
    aud["plan-auditor<br/>Opus 5.5, read-only<br/>reviews plans, never results"]
  end

  subgraph plans[".plans/ in the repo (local, gitignored)"]
    spec["specs/TRACE.md"]
    draft["inbox/ID.md.draft"]
    ready["inbox/ID.md (ready)"]
    results["done/ID/<br/>reports, evidence.json"]
    traces["traces/TRACE.jsonl"]
  end

  subgraph pi["Pi window: pi-plan-dispatch extension"]
    disp["Dispatcher<br/>queue, file-overlap scheduling,<br/>preflight, verify, gate"]
    w["Workers 1..3<br/>DeepSeek via OpenCode Go<br/>headless, guarded"]
    rev["Pair and security reviewers<br/>read-only"]
  end

  repo[("Source repo")]

  user -->|"request, approves plan"| orch
  orch -->|"grilling, then writes"| spec
  orch -->|"writes atomically"| draft
  orch -->|"spawns with plan and spec"| aud
  aud -->|"findings, verdict, logs plan.audit"| orch
  orch -->|"flip after your approval"| ready
  ready -->|"picked up"| disp
  disp -->|"spawns one per task"| w
  w -->|"edits only its files"| repo
  disp -->|"after verify passes"| rev
  rev -->|"approve or changes"| w
  disp -->|"snapshots, verify, gate"| results
  disp --> traces
  orch --> traces
  aud --> traces
  results -->|"wait, gate, report"| orch
  orch -->|"gate, faults, cost"| user

  subgraph vault["agent-vault (built): Obsidian vault in its own git repo"]
    cli["vault.mjs CLI<br/>schema, allowlist, lock, sync"]
    notes["Notes: plan, run, finding,<br/>lesson, decision, codebase"]
    remote["Private git remote"]
  end
  gfy["Graphify (planned)<br/>code graph, per machine"]

  orch -->|"only write path"| cli
  cli --> notes
  notes -->|"sync pull and push"| remote
  aud -->|"boot, read only"| notes
  disp -.->|"Phase 2: plan queue"| notes
  gfy -.->|"distilled into codebase notes"| cli
  guard["Permissions and hook (planned)<br/>orchestrator: Write only .plans/,<br/>Agent only plan-auditor"]
  guard -.->|"enforces"| orch
```

## One request in order

```mermaid
sequenceDiagram
  actor U as You
  participant O as Orchestrator (Sonnet)
  participant A as plan-auditor (Opus)
  participant D as Dispatcher (Pi)
  participant W as Workers (DeepSeek)

  U->>O: request
  O->>U: grilling questions
  U->>O: answers, spec confirmed
  O->>O: write spec, write plan as .md.draft
  loop at most 3 audit rounds
    O->>A: plan and spec
    A-->>O: findings and verdict
    O->>O: revise plan if blockers or majors
  end
  O->>U: plan, requirement trace, audit result
  U->>O: approve
  O->>D: flip draft to ready
  D->>D: preflight, claim plan
  D->>W: spawn tasks (up to 3 in parallel)
  W-->>D: edit files, report
  D->>D: run verify commands, pair review, gate
  D-->>O: results, evidence, faults
  O->>U: gate result, faults, cost
  alt gate fails
    O->>O: draft fix plan, same loop, max 3 fix rounds
  end
```

## How to read it

- Three trust levels. The orchestrator plans and approves, the `plan-auditor` checks the plan, and the workers write the code, but the dispatcher does not trust their claims: it re-runs the `verify:` commands, takes git snapshots and the gate decides.
- Files are the hand-off. Nothing talks to anything else directly, except the orchestrator spawning the `plan-auditor`.
- The planned layers. The plan queue, Graphify and the permissions hook are what is left. The vault is built: it is the orchestrator's and the reviewer's memory across machines, and the plan queue on top of it is Phase 2. Graphify feeds code knowledge into it, and the permissions hook makes "the orchestrator may only write under `.plans/`, the vault through the CLI, and spawn the `plan-auditor`" a real capability.

## Built and planned

Built:

- The orchestrator and `plan-auditor` flow.
- The dispatcher, with its queue, file-overlap scheduling and preflight.
- The workers.
- The pair and security reviewers.
- `verify:` commands, the gate, the guards and the traces.
- The preflight CLI.
- The agent-vault: CLI, notes and sync.

Planned:

- Graphify.
- The permissions hook.
- The agent-vault plan queue (Phase 2).
- A web monitor for worker sessions.
