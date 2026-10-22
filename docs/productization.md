# Productization

An internal note on whether this harness could become a product, and what it
would take. It separates what we know from what we assume; not a market study.

## Summary

This system is a control layer above two harnesses: Claude Code for the
interactive side and the Claude models, Pi for headless workers on cheap
models. Sonnet 5.5 plans and orchestrates in the main session, Opus 5.5
reviews each plan before it runs, and the work is delegated and traced. The
hard rule is that Claude models never write code; workers write all of it.
Today it is a personal workflow tool: Phase 1 is built and dogfooded, with no
external users.

## The problem it addresses

The motivation, as the owner stated it:

- Expensive models are good at judgment but costly for bulk typing.
- Cheap models, such as DeepSeek V4.1 Flash, are cheap but can hallucinate:
  they invent file contents, APIs and test results, and they edit out of scope.
- Manual hand-offs between CLI tools are tedious.
- Headless agents are hard to watch.

## What is different here

Facts about this repository, true today unless marked planned:

- **Evidence instead of trust.** A gate compares the worker's report against
  Pi's tool-call stream and a git snapshot taken before and after the plan.
- **Plan audit before the run.** Opus checks the plan in a fresh context
  against the saved spec and the repository; fixes go back as a new draft, up
  to 3 audit rounds.
- **One trace per request**, linked across rounds, in `.plans/traces/`.
- **The exact worker prompts and the saved worker sessions are kept**, so a
  failure can be re-read rather than guessed at.
- **File-overlap scheduling** lets workers run in parallel without two of them
  touching the same files.
- **The contract is plain files** under `.plans/`, so it does not depend on one
  model, one provider or one harness.

Planned (in progress or drafted):

- `verify:` commands run by the dispatcher itself, independent of the worker.
- Live tool-call blocking inside workers.
- Plan preflight checks before any worker starts.
- A workflow-wide hook that stops Claude from editing code at all.
- A read-only monitor web app.

## Landscape, from our own research

This was a quick scan, not a market study. We read the pages below and verified
nothing beyond what they say.

- [agent-pi](https://github.com/crichalchemist/agent-pi): a Claude Code plugin
  that delegates to Pi agents over MCP.
- [A Claude Code orchestrator driving scoped Pi
  workers](https://dotzlaw.com/projects/ultimate-workflow-claude-pi/), with
  durable stage files, fresh-context reviewers and worktrees.
- [The Claude Code orchestrator pattern](https://andresleiva.com/blog/claude-code-orchestrator-pattern/)
  with cheaper subagent models.
- [pi-orchestration](https://github.com/0xKobold/pi-orchestration):
  worker, reviewer and coordinator agents inside Pi.
- [pi-subagents](https://github.com/nicobailon/pi-subagents).

Observation, hedged: in the pages we read, the common pattern is an expensive
model plans and cheap models write. We did not find one that combines an
evidence gate computed from tool calls and git with a plan audit and a user
approval step before any worker runs, but we did not search exhaustively.
Claude Code itself ships subagents and hooks, so some of this could be absorbed
by the platform.

## Possible product shapes

(a) **Open-source skill pack and installer for individual developers.** The
closest to today. Ship the extension, the `plan-auditor` agent and the
orchestrator rules block with one install command and a short setup guide. Work
is mostly packaging, documentation and support.

(b) **Hosted control plane with workers on a VPS or in containers.** Removes
the requirement that the user keep Pi open locally. Needs queueing, isolation
per job, secrets management, auth and metered API billing.

(c) **Team or enterprise offering centred on the audit trail and evidence.**
Sells the record rather than the typing: who changed what, on whose
instruction, and what the review found. Needs retention, access control and
integration with existing review tooling.

## Gaps before any productization

- **Isolation.** All workers share one checkout today. Git worktrees per task
  are needed before parallel work is safe on a stranger's repository.
- **Durable queue and crash resume.** A plan left in `running/` after a crash is
  not resumed.
- **Auth and a safe monitor.** The monitor is loopback-only and read-only.
- **Multi-repo support.**
- **Secrets handling and cost caps.**
- **Coupling to Pi.** CLI flags, event names and the session format need an
  abstraction layer.
- **Shell writes by workers cannot be fully policed.**
- **Real long-run validation.** Only small documentation tasks have run so far.
- **Packaging as a Claude Code plugin.**
- **OpenTelemetry export of traces.**

## Risks

- **Provider terms and billing.** This setup deliberately keeps Claude models
  inside Claude Code on the owner's subscription. A hosted service could not
  assume that: it would face metered API costs, and the terms for third-party
  use of subscriptions must be checked. We have not checked them.
- **Harness churn.** The Pi and Claude Code interfaces change.
- **Platform absorption.** See the landscape section.
- **Security.** Running model-written code on shared infrastructure is a
  serious risk on its own.
- **Support burden.** Every extra harness and provider multiplies the setups
  that can break.

## Assumptions to validate

- [ ] There is a paying audience for a verified cheap-worker workflow.
- [ ] Developers care about the plan audit and the evidence more than about raw
      cost saving.
- [ ] The cost saving versus an all-Opus workflow is real and large enough
      (to be measured).
- [ ] The gate and pair review catch a meaningful share of worker mistakes,
      and the plan audit catches plan mistakes before the run (to be measured).
- [ ] Users would adopt a plan-approval workflow instead of free-form chat.
- [ ] Hosted use is allowed by the model providers' terms.

## Measurements already available, and what to collect

The dispatcher records per task tokens, cost, duration, tool calls, retries and
faults, and per trace the rounds, gate result and plan-audit result.

One early data point, an anecdote: a six-task documentation plan cost $0.0994
in worker spend and took 193 seconds; a five-task fix round cost $0.0482.

Collect over the next ten or more real tasks: worker cost, plan-audit tokens,
rounds to pass, gate failure rate, plan-audit failure rate, and what the plan
audit caught before the run that the gate would not have. Compare against doing
the same tasks with Opus alone.

## Next steps

1. Finish the guardrails and the monitor.
2. Dogfood on real feature work and record the measurements above.
3. Write down the findings in this file.
4. Decide between shapes (a), (b) and (c) only after that.
5. Check provider terms before any hosted design.

Last reviewed: 2026-10-20
