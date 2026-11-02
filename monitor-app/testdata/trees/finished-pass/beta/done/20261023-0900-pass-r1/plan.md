---
id: 20261023-0900-pass-r1
trace: 20261023-0900-pass-r1
round: 1
status: ready
---
## Context

Fixture plan for the monitor tests.

## task: build
files: x.ts
depends_on: []
pair: review

Body line for build.

## task: lint
files: x.ts
depends_on: [build]

Body line for lint.
