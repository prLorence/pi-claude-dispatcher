---
id: 20261023-0920-skip-r1
trace: 20261023-0920-skip-r1
round: 1
status: ready
---
## Context

Fixture plan for the monitor tests.

## task: first
files: x.ts
depends_on: []
pair: review

Body line for first.

## task: later
files: x.ts
depends_on: [first]
pair: review

Body line for later.
