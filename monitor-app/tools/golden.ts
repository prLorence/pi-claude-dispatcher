#!/usr/bin/env bun
/**
 * Regenerates the parity fixtures and the golden JSON of the Go monitor port.
 *
 * The TypeScript server in monitor/ is the oracle: this script builds fixture
 * plans folders in a temporary folder, starts the real Bun server in this
 * process, fetches /api/state and the listed session pages, stops the server
 * again and writes the results under monitor-app/testdata/.
 *
 *   bun run tools/golden.ts           write testdata/trees, testdata/golden and testdata/manifest.json
 *   bun run tools/golden.ts --check   regenerate into a temporary folder and fail on any difference
 *
 * Nothing under monitor/ is written. Git cannot store empty folders, folder
 * modes or modification times, so the manifest describes them and both this
 * script and the Go parity test rebuild them from it in the same order: create
 * the folders, write the files, apply the mtimes deepest path first, apply the
 * modes last.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { STALL_MS } from "../../monitor/src/server/lanes.ts";
import { resolveRepos } from "../../monitor/src/server/repos.ts";
import { startServer } from "../../monitor/src/server/server.ts";
import {
  assistantMsg,
  ev,
  modelChange,
  sessionHeader,
  systemMsg,
  textPart,
  thinkingPart,
  toolCall,
  toolResult,
  userMsg,
  writeEvents,
  writePlan,
  writeSession,
} from "../../monitor/test/fixture.ts";

const TOOLS_DIR = import.meta.dir;
const TESTDATA = path.resolve(TOOLS_DIR, "..", "testdata");

/** The one clock the whole fixture set uses. */
const NOW = Date.parse("2026-10-23T10:05:00.000Z");

/** Event timestamps are offsets in minutes from 09:00Z the same day. */
const BASE_TS = Date.parse("2026-10-23T09:00:00.000Z");

/**
 * Session mtimes that decide a lane: this one is live, the other is stalled.
 * Both stay well away from the stall boundary NOW - STALL_MS, so a floating
 * point drift in utimes cannot flip a lane's state.
 */
const LIVE_MS = NOW - 5_000;
const STALLED_MS = NOW - 120_000;

/**
 * Other session mtimes: 40 seconds before NOW and further back in steps of
 * three seconds, so they never tie and never sit near the stall boundary.
 */
let sessionMtimeIndex = 0;

function nextMtime(): number {
  const value = NOW - 40_000 - sessionMtimeIndex * 3_000;
  sessionMtimeIndex += 1;
  return value;
}

/** Every mtime that is not named explicitly comes from this counter, far in the past. */
const OLD_BASE = NOW - 7_200_000;
const OLD_STEP = 61_000;

interface RepoRef {
  name: string;
  dir: string;
}

interface SessionRequest {
  repo: string;
  plan: string;
  id: string;
  after: number;
}

interface CaseSpec {
  name: string;
  message: string | null;
  repos: RepoRef[];
  modes: Record<string, number>;
  sessions: SessionRequest[];
  build: (root: string, explicit: Map<string, number>) => void;
}

function ts(minutes: number, seconds = 0): string {
  return new Date(BASE_TS + minutes * 60_000 + seconds * 1000).toISOString();
}

function plansFolder(root: string, rel: string): string {
  const dir = path.join(root, rel);
  for (const name of ["traces", "running", "done", "sessions", "inbox"]) {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
  }
  return dir;
}

function relPath(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join("/");
}

/** Writes a session file and records the mtime the manifest must restore. */
function addSession(
  root: string,
  explicit: Map<string, number>,
  dir: string,
  planId: string,
  id: string,
  lines: object[],
  mtimeMs: number,
  raw?: string,
): void {
  const file = writeSession(dir, planId, id, lines, { mtimeMs, raw });
  explicit.set(relPath(root, file), mtimeMs);
}

/** A session that stopped normally: it is ended, with usage and a last text. */
function endedSession(id: string, from: string, to: string, lastText: string): object[] {
  return [
    sessionHeader(id),
    modelChange("opencode-go/beam-free", from),
    userMsg("start the task", from),
    assistantMsg([textPart(lastText)], to, {
      stopReason: "stop",
      input: 1200,
      output: 340,
      cost: 0.0125,
    }),
  ];
}

/** A session still running: it ended on a tool call, so it is not ended. */
function runningSession(id: string, from: string, to: string): object[] {
  return [
    sessionHeader(id),
    modelChange("opencode-go/beam-free", from),
    userMsg("start the task", from),
    assistantMsg(
      [textPart("working on it"), toolCall("edit", { path: "lanes.ts" }, "call-1")],
      to,
      { stopReason: "toolUse", input: 800, output: 120, cost: 0.004 },
    ),
  ];
}

function buildRunningPair(root: string, explicit: Map<string, number>): void {
  const dir = plansFolder(root, "trees/running-pair/alpha");
  const plan = "20261023-0958-pair-r1";
  writePlan(
    dir,
    "running",
    plan,
    [
      { id: "one", pair: "review" },
      { id: "two" },
      { id: "three", dependsOn: ["one", "two"] },
    ],
    plan,
  );
  const sid = (suffix: string): string => `${plan}.${suffix}`;
  writeEvents(dir, plan, [
    ev("task.start", plan, ts(0), {
      task: "one",
      attempt: 1,
      data: { session_id: sid("one.a1"), model: "opencode-go/beam-free", thinking: "high" },
    }),
    ev("task.start", plan, ts(1), {
      task: "two",
      attempt: 1,
      data: { session_id: sid("two.a1"), model: "opencode-go/beam-free", thinking: "low" },
    }),
    ev("task.end", plan, ts(2), {
      task: "one",
      attempt: 1,
      data: { state: "retry", ok: true },
    }),
    ev("task.review", plan, ts(3), {
      task: "one",
      attempt: 1,
      data: {
        round: 1,
        session_id: sid("one.review1.a1"),
        verdict: "changes",
        findings: 2,
        ok: true,
        model: "opencode-go/beam-free",
        thinking: "high",
      },
    }),
    ev("task.start", plan, ts(4), {
      task: "one",
      attempt: 2,
      data: { session_id: sid("one.a2"), model: "opencode-go/beam-free", thinking: "high" },
    }),
    ev("task.end", plan, ts(5), {
      task: "one",
      attempt: 2,
      data: { state: "done", ok: true },
    }),
    ev("task.review", plan, ts(6), {
      task: "one",
      attempt: 1,
      data: {
        round: 2,
        session_id: sid("one.review2.a1"),
        verdict: "approve",
        findings: 0,
        ok: true,
      },
    }),
  ]);
  addSession(
    root,
    explicit,
    dir,
    plan,
    sid("one.a1"),
    endedSession(sid("one.a1"), ts(0), ts(2, 30), "first pass done"),
    nextMtime(),
  );
  addSession(
    root,
    explicit,
    dir,
    plan,
    sid("one.a2"),
    endedSession(sid("one.a2"), ts(4), ts(5, 20), "second pass done"),
    nextMtime(),
  );
  addSession(
    root,
    explicit,
    dir,
    plan,
    sid("one.review1.a1"),
    endedSession(sid("one.review1.a1"), ts(3), ts(3, 40), "two findings, please fix"),
    nextMtime(),
  );
  addSession(
    root,
    explicit,
    dir,
    plan,
    sid("one.review2.a1"),
    endedSession(sid("one.review2.a1"), ts(6), ts(6, 30), "approved"),
    nextMtime(),
  );
  addSession(
    root,
    explicit,
    dir,
    plan,
    sid("two.a1"),
    runningSession(sid("two.a1"), ts(1), ts(1, 40)),
    LIVE_MS,
  );
}

function buildFinishedPass(root: string, explicit: Map<string, number>): void {
  const dir = plansFolder(root, "trees/finished-pass/beta");
  const plan = "20261023-0900-pass-r1";
  writePlan(
    dir,
    "done",
    plan,
    [{ id: "build", pair: "review" }, { id: "lint", dependsOn: ["build"] }],
    plan,
  );
  const sid = (suffix: string): string => `${plan}.${suffix}`;
  writeEvents(dir, plan, [
    ev("task.start", plan, ts(0), {
      task: "build",
      attempt: 1,
      data: { session_id: sid("build.a1"), model: "opencode-go/beam-free", thinking: "high" },
    }),
    ev("task.end", plan, ts(2), {
      task: "build",
      attempt: 1,
      data: { state: "done", ok: true },
    }),
    ev("task.review", plan, ts(3), {
      task: "build",
      attempt: 1,
      data: {
        round: 1,
        session_id: sid("build.review1.a1"),
        verdict: "approve",
        findings: 0,
        ok: true,
      },
    }),
    ev("task.start", plan, ts(4), {
      task: "lint",
      attempt: 1,
      data: {
        session_id: sid("lint.a1"),
        model: "opencode-go/beam-free",
        thinking: "low",
      },
    }),
    ev("task.end", plan, ts(5), {
      task: "lint",
      attempt: 1,
      data: { state: "done", ok: true },
    }),
    ev("plan.end", plan, ts(6), { data: { gate_pass: true, done: 2, total: 2 } }),
  ]);
  addSession(
    root,
    explicit,
    dir,
    plan,
    sid("build.a1"),
    endedSession(sid("build.a1"), ts(0), ts(2, 20), "built the thing"),
    nextMtime(),
  );
  addSession(
    root,
    explicit,
    dir,
    plan,
    sid("build.review1.a1"),
    endedSession(sid("build.review1.a1"), ts(3), ts(3, 30), "all good"),
    nextMtime(),
  );
  addSession(
    root,
    explicit,
    dir,
    plan,
    sid("lint.a1"),
    endedSession(sid("lint.a1"), ts(4), ts(5, 10), "lint is clean"),
    nextMtime(),
  );
}

function buildFailedGate(root: string, explicit: Map<string, number>): void {
  const dir = plansFolder(root, "trees/failed-gate/gamma");
  const plan = "20261023-0910-gate-r1";
  writePlan(dir, "done", plan, [{ id: "one" }, { id: "two", dependsOn: ["one"] }], plan);
  const sid = (suffix: string): string => `${plan}.${suffix}`;
  writeEvents(dir, plan, [
    ev("task.start", plan, ts(10), {
      task: "one",
      attempt: 1,
      data: { session_id: sid("one.a1"), model: "opencode-go/beam-free", thinking: "high" },
    }),
    ev("task.end", plan, ts(12), {
      task: "one",
      attempt: 1,
      data: { state: "failed", ok: false },
    }),
    ev("task.start", plan, ts(13), {
      task: "two",
      attempt: 1,
      data: { session_id: sid("two.a1"), model: "opencode-go/beam-free", thinking: "high" },
    }),
    ev("task.end", plan, ts(15), {      task: "two",
      attempt: 1,
      data: { state: "retry", ok: false },
    }),
    ev("plan.end", plan, ts(16), { data: { gate_pass: false, done: 0, total: 2 } }),
  ]);
  const errorLine = {
    type: "message",
    timestamp: ts(12, 20),
    message: {
      role: "assistant",
      content: [textPart("gave up")],
      stopReason: "error",
      errorMessage: "provider dropped the stream",
      usage: { input: 500, output: 40, cost: { total: 0.002 } },
    },
  };
  addSession(
    root,
    explicit,
    dir,
    plan,
    sid("one.a1"),
    [
      sessionHeader(sid("one.a1")),
      modelChange("opencode-go/beam-free", ts(10)),
      userMsg("start the task", ts(10)),
      errorLine,
    ],
    nextMtime(),
  );
  addSession(
    root,
    explicit,
    dir,
    plan,
    sid("two.a1"),
    endedSession(sid("two.a1"), ts(13), ts(15, 20), "tried again"),
    nextMtime(),
  );
}

function buildSkippedTask(root: string, explicit: Map<string, number>): void {
  const dir = plansFolder(root, "trees/skipped-task/delta");
  const plan = "20261023-0920-skip-r1";
  writePlan(
    dir,
    "done",
    plan,
    [
      { id: "first", pair: "review" },
      { id: "later", dependsOn: ["first"], pair: "review" },
    ],
    plan,
  );
  const sid = (suffix: string): string => `${plan}.${suffix}`;
  writeEvents(dir, plan, [
    ev("task.start", plan, ts(20), {
      task: "first",
      attempt: 1,
      data: { session_id: sid("first.a1"), model: "opencode-go/beam-free", thinking: "high" },
    }),
    ev("task.end", plan, ts(22), {
      task: "first",
      attempt: 1,
      data: { state: "done", ok: true },
    }),
    ev("task.review", plan, ts(23), {
      task: "first",
      attempt: 1,
      data: {
        round: 1,
        session_id: sid("first.review1.a1"),
        verdict: "approve",
        findings: 0,
        ok: true,
      },
    }),
    ev("plan.end", plan, ts(24), { data: { gate_pass: true, done: 1, total: 2 } }),
  ]);
  addSession(
    root,
    explicit,
    dir,
    plan,
    sid("first.a1"),
    endedSession(sid("first.a1"), ts(20), ts(22, 10), "first is done"),
    nextMtime(),
  );
  addSession(
    root,
    explicit,
    dir,
    plan,
    sid("first.review1.a1"),
    endedSession(sid("first.review1.a1"), ts(23), ts(23, 20), "approved"),
    nextMtime(),
  );
}

function buildStalledLane(root: string, explicit: Map<string, number>): void {
  const dir = plansFolder(root, "trees/stalled-lane/epsilon");
  const plan = "20261023-0930-stall-r1";
  writePlan(dir, "running", plan, [{ id: "slow" }], plan);
  const id = `${plan}.slow.a1`;
  writeEvents(dir, plan, [
    ev("task.start", plan, ts(30), {
      task: "slow",
      attempt: 1,
      data: { session_id: id, model: "opencode-go/beam-free", thinking: "low" },
    }),
  ]);
  addSession(
    root,
    explicit,
    dir,
    plan,
    id,
    runningSession(id, ts(30), ts(30, 40)),
    STALLED_MS,
  );
}

function buildDeciderEffortAudit(root: string, explicit: Map<string, number>): void {
  const dir = plansFolder(root, "trees/decider-effort-audit/zeta");
  const plan = "20261023-0940-decider-r1";
  writePlan(dir, "done", plan, [{ id: "audited" }, { id: "plain" }], plan);
  const sid = (suffix: string): string => `${plan}.${suffix}`;
  writeEvents(dir, plan, [
    ev("decision.effort", plan, ts(40), {
      task: "audited",
      data: {
        task: "audited",
        suggested: "high",
        probabilities: { low: 0.1, high: 0.8, max: 0.1 },
        confidence: 0.8,
        complexity: 3,
        model: "some/decider",
        cost: 0.0001,
        mode: "apply",
      },
    }),
    ev("task.start", plan, ts(40, 30), {
      task: "audited",
      attempt: 1,
      data: { session_id: sid("audited.a1"), model: "opencode-go/beam-free", thinking: "high" },
    }),
    ev("task.end", plan, ts(42), {
      task: "audited",
      attempt: 1,
      data: { state: "done", ok: true },
    }),
    ev("task.start", plan, ts(43), {
      task: "plain",
      attempt: 1,
      data: {
        session_id: sid("plain.a1"),
        model: "opencode-go/beam-free",
        thinking: "low",
      },
    }),
    ev("task.end", plan, ts(44), {
      task: "plain",
      attempt: 1,
      data: { state: "done", ok: true },
    }),
    ev("decision.audit", plan, ts(45), {
      data: {
        audit_round: 2,
        verdict: "pass",
        proposal: "approve",
        aggregate: 0.25,
        findings: [
          { id: "f1", severity: "major", p: 0.3 },
          { id: "f2", severity: "minor", p: 0.1 },
          { id: "f3", severity: "info", p: 0 },
        ],
      },
    }),
    ev("plan.end", plan, ts(46), { data: { gate_pass: true, done: 2, total: 2 } }),
  ]);
  addSession(
    root,
    explicit,
    dir,
    plan,
    sid("audited.a1"),
    endedSession(sid("audited.a1"), ts(40, 30), ts(42, 10), "audited work is done"),
    nextMtime(),
  );
  addSession(
    root,
    explicit,
    dir,
    plan,
    sid("plain.a1"),
    endedSession(sid("plain.a1"), ts(43), ts(44, 10), "plain work is done"),
    nextMtime(),
  );
}

function buildRetryTwoAttempts(root: string, explicit: Map<string, number>): void {
  const dir = plansFolder(root, "trees/retry-two-attempts/eta");
  const plan = "20261023-0950-retry-r1";
  writePlan(dir, "running", plan, [{ id: "again" }], plan);
  const sid = (suffix: string): string => `${plan}.${suffix}`;
  writeEvents(dir, plan, [
    ev("task.start", plan, ts(50), {
      task: "again",
      attempt: 1,
      data: { session_id: sid("again.a1"), model: "opencode-go/beam-free", thinking: "high" },
    }),
    ev("task.end", plan, ts(51), {
      task: "again",
      attempt: 1,
      data: { state: "failed", ok: false },
    }),
    ev("task.start", plan, ts(52), {
      task: "again",
      attempt: 2,
      data: { session_id: sid("again.a2"), model: "opencode-go/beam-free", thinking: "max" },
    }),
    ev("task.end", plan, ts(54), {
      task: "again",
      attempt: 2,
      data: { state: "done", ok: true },
    }),
  ]);
  addSession(
    root,
    explicit,
    dir,
    plan,
    sid("again.a1"),
    endedSession(sid("again.a1"), ts(50), ts(51, 20), "first try gave up"),
    nextMtime(),
  );
  addSession(
    root,
    explicit,
    dir,
    plan,
    sid("again.a2"),
    endedSession(sid("again.a2"), ts(52), ts(54, 10), "second try worked"),
    nextMtime(),
  );
}

function buildIdleAndActive(root: string, explicit: Map<string, number>): void {
  const activeOld = plansFolder(root, "trees/idle-and-active/active-old");
  const activeNew = plansFolder(root, "trees/idle-and-active/active-new");
  const idleOld = plansFolder(root, "trees/idle-and-active/idle-old");
  const idleNew = plansFolder(root, "trees/idle-and-active/idle-new");

  const oldActivePlan = "20261023-0850-active-old-r1";
  writePlan(activeOld, "running", oldActivePlan, [{ id: "task" }], oldActivePlan);
  writeEvents(activeOld, oldActivePlan, [
    ev("task.start", oldActivePlan, ts(-10), { task: "task", attempt: 1 }),
  ]);

  const newActivePlan = "20261023-0930-active-new-r1";
  writePlan(activeNew, "running", newActivePlan, [{ id: "task" }], newActivePlan);
  writeEvents(activeNew, newActivePlan, [
    ev("task.start", newActivePlan, ts(30), { task: "task", attempt: 1 }),
  ]);

  const oldIdlePlan = "20261023-0840-idle-old-r1";
  writePlan(idleOld, "done", oldIdlePlan, [{ id: "task" }], oldIdlePlan);
  writeEvents(idleOld, oldIdlePlan, [
    ev("task.start", oldIdlePlan, ts(20), { task: "task", attempt: 1 }),
    ev("task.end", oldIdlePlan, ts(21), {
      task: "task",
      attempt: 1,
      data: { state: "done", ok: true },
    }),
  ]);

  const newIdlePlan = "20261023-0945-idle-new-r1";
  writePlan(idleNew, "done", newIdlePlan, [{ id: "task" }], newIdlePlan);
  writeEvents(idleNew, newIdlePlan, [
    ev("task.start", newIdlePlan, ts(40), { task: "task", attempt: 1 }),
    ev("task.end", newIdlePlan, ts(41), {
      task: "task",
      attempt: 1,
      data: { state: "done", ok: true },
    }),
    ev("plan.end", newIdlePlan, ts(45), { data: { gate_pass: true, done: 1, total: 1 } }),
  ]);

  addSession(
    root,
    explicit,
    idleNew,
    newIdlePlan,
    `${newIdlePlan}.note`,
    endedSession(`${newIdlePlan}.note`, ts(42), ts(43), "a note for the transcript"),
    nextMtime(),
  );
}

function buildMissingFolder(root: string): void {
  fs.mkdirSync(path.join(root, "trees/missing-folder"), { recursive: true });
}

function buildUnreadableFolder(root: string, explicit: Map<string, number>): void {
  const dir = plansFolder(root, "trees/unreadable-folder/sealed");
  const plan = "20261023-0900-sealed-r1";
  writePlan(dir, "running", plan, [{ id: "hidden" }], plan);
  const id = `${plan}.hidden.a1`;
  writeEvents(dir, plan, [
    ev("task.start", plan, ts(0), {
      task: "hidden",
      attempt: 1,
      data: { session_id: id, model: "opencode-go/beam-free", thinking: "high" },
    }),
  ]);
  addSession(
    root,
    explicit,
    dir,
    plan,
    id,
    endedSession(id, ts(0), ts(2), "hidden work"),
    nextMtime(),
  );
}

function buildOverCap(root: string, explicit: Map<string, number>): void {
  const dir = plansFolder(root, "trees/over-cap/plans");
  const plan = "20261023-0905-over-cap-r1";
  writePlan(dir, "done", plan, [{ id: "task" }], plan);
  const sid = `${plan}.extra`;
  writeEvents(dir, plan, [
    ev("task.start", plan, ts(5), {
      task: "task",
      attempt: 1,
      data: { session_id: `${plan}.task.a1`, thinking: "low" },
    }),
    ev("task.end", plan, ts(6), {
      task: "task",
      attempt: 1,
      data: { state: "done", ok: true },
    }),
    ev("plan.end", plan, ts(7), { data: { gate_pass: true, done: 1, total: 1 } }),
  ]);
  addSession(root, explicit, dir, plan, sid, endedSession(sid, ts(5), ts(6), "over cap"), nextMtime());
}

/** 2400 UTF-16 code units: CJK text and an emoji, so the cap cuts at 2000. */
const LONG_RESULT = "漢字🙂".repeat(600);

const LONG_COMMAND = `echo ${"x".repeat(9000)}`;

function buildTranscriptEdge(root: string, explicit: Map<string, number>): void {
  const dir = plansFolder(root, "trees/transcript-edge/theta");
  const plan = "20261023-1000-edge-r1";
  writePlan(dir, "done", plan, [{ id: "edge" }], plan);
  const id = `${plan}.edge.a1`;
  writeEvents(dir, plan, [
    ev("task.start", plan, ts(60), {
      task: "edge",
      attempt: 1,
      data: { session_id: id },
    }),
    ev("task.end", plan, ts(62), {
      task: "edge",
      attempt: 1,
      data: { state: "done", ok: true },
    }),
    ev("plan.end", plan, ts(63), { data: { gate_pass: true, done: 1, total: 1 } }),
  ]);

  const thinkingLine = {
    type: "thinking_level_change",
    timestamp: ts(60, 1),
    thinkingLevel: "high",
  };
  const partial =
    '{"type":"message","timestamp":"2026-10-23T10:00:30.000Z","message":{"role":"assistant","content":[{"type":"text","text":"still writing';

  addSession(
    root,
    explicit,
    dir,
    plan,
    id,
    [
      sessionHeader(id),
      modelChange("moonshotai/kimi-k2", ts(60)),
      thinkingLine,
      systemMsg(ts(60, 2)),
      userMsg("inspect the file and report", ts(60, 3)),
      assistantMsg(
        [
          thinkingPart("checking the arguments before the edit"),
          toolCall("edit", { zeta: 1, alpha: "<a&b>", middle: 0.5 }, "call-edge-1"),
        ],
        ts(60, 10),
        { stopReason: "toolUse", input: 100, output: 20, cost: 0.001 },
      ),
      toolResult("edit", LONG_RESULT, ts(60, 20), true),
      assistantMsg([toolCall("bash", { command: LONG_COMMAND }, "call-edge-2")], ts(60, 30), {
        stopReason: "toolUse",
        input: 200,
        output: 30,
        cost: 0.002,
      }),
      assistantMsg([textPart("done")], ts(60, 40), {
        stopReason: "stop",
        input: 300,
        output: 40,
        cost: 0.003,
      }),
    ],
    nextMtime(),
    partial,
  );
}

const OVER_CAP_TOTAL = 26;

/**
 * The list a resolver hands the server for the over-cap case: the first
 * `MAX_REPOS` entries plus the message about the rest. `checkOverCap` proves
 * this is what `resolveRepos` of the TypeScript server returns.
 */
const OVER_CAP_REPOS: RepoRef[] = Array.from({ length: 24 }, (_, index) => ({
  name: `repo-${String(index + 1).padStart(2, "0")}`,
  dir: "trees/over-cap/plans",
}));

const OVER_CAP_MESSAGE = "2 more repos ignored (limit 24)";

/**
 * Proves the over-cap case against the real resolver: 26 requested repos
 * resolve to the 24 of the manifest and the message, so the golden records the
 * cap of the TypeScript server and not a guess.
 */
function checkOverCap(root: string): void {
  const dir = path.join(root, "trees/over-cap/plans");
  const flags = Array.from(
    { length: OVER_CAP_TOTAL },
    (_, index) => `repo-${String(index + 1).padStart(2, "0")}=${dir}`,
  );
  const resolved = resolveRepos({ flags }, root);
  const names = resolved.repos.map((repo) => repo.name).join(",");
  const expected = OVER_CAP_REPOS.map((repo) => repo.name).join(",");
  if (names !== expected || resolved.message !== OVER_CAP_MESSAGE) {
    throw new Error(
      `the resolver no longer caps at 24: got ${names.length}, ` +
        `message ${JSON.stringify(resolved.message)}`,
    );
  }
  for (const repo of resolved.repos) {
    if (repo.dir !== dir) {
      throw new Error(`the resolver returned an unexpected folder: ${repo.dir}`);
    }
  }
}

const CASES: CaseSpec[] = [
  {
    name: "running-pair",
    message: null,
    repos: [{ name: "alpha", dir: "trees/running-pair/alpha" }],
    modes: {},
    sessions: [
      { repo: "alpha", plan: "20261023-0958-pair-r1", id: "20261023-0958-pair-r1.two.a1", after: 0 },
      {
        repo: "alpha",
        plan: "20261023-0958-pair-r1",
        id: "20261023-0958-pair-r1.one.review1.a1",
        after: 0,
      },
      { repo: "alpha", plan: "20261023-0958-pair-r1", id: "20261023-0958-pair-r1.one.a1", after: 1 },
    ],
    build: buildRunningPair,
  },
  {
    name: "finished-pass",
    message: null,
    repos: [{ name: "beta", dir: "trees/finished-pass/beta" }],
    modes: {},
    sessions: [
      {
        repo: "beta",
        plan: "20261023-0900-pass-r1",
        id: "20261023-0900-pass-r1.build.a1",
        after: 0,
      },
    ],
    build: buildFinishedPass,
  },
  {
    name: "failed-gate",
    message: null,
    repos: [{ name: "gamma", dir: "trees/failed-gate/gamma" }],
    modes: {},
    sessions: [
      {
        repo: "gamma",
        plan: "20261023-0910-gate-r1",
        id: "20261023-0910-gate-r1.one.a1",
        after: 0,
      },
    ],
    build: buildFailedGate,
  },
  {
    name: "skipped-task",
    message: null,
    repos: [{ name: "delta", dir: "trees/skipped-task/delta" }],
    modes: {},
    sessions: [
      {
        repo: "delta",
        plan: "20261023-0920-skip-r1",
        id: "20261023-0920-skip-r1.first.a1",
        after: 0,
      },
    ],
    build: buildSkippedTask,
  },
  {
    name: "stalled-lane",
    message: null,
    repos: [{ name: "epsilon", dir: "trees/stalled-lane/epsilon" }],
    modes: {},
    sessions: [
      {
        repo: "epsilon",
        plan: "20261023-0930-stall-r1",
        id: "20261023-0930-stall-r1.slow.a1",
        after: 0,
      },
    ],
    build: buildStalledLane,
  },
  {
    name: "decider-effort-audit",
    message: null,
    repos: [{ name: "zeta", dir: "trees/decider-effort-audit/zeta" }],
    modes: {},
    sessions: [
      {
        repo: "zeta",
        plan: "20261023-0940-decider-r1",
        id: "20261023-0940-decider-r1.audited.a1",
        after: 0,
      },
    ],
    build: buildDeciderEffortAudit,
  },
  {
    name: "retry-two-attempts",
    message: null,
    repos: [{ name: "eta", dir: "trees/retry-two-attempts/eta" }],
    modes: {},
    sessions: [
      {
        repo: "eta",
        plan: "20261023-0950-retry-r1",
        id: "20261023-0950-retry-r1.again.a1",
        after: 0,
      },
      {
        repo: "eta",
        plan: "20261023-0950-retry-r1",
        id: "20261023-0950-retry-r1.again.a2",
        after: 0,
      },
    ],
    build: buildRetryTwoAttempts,
  },
  {
    name: "idle-and-active",
    message: null,
    repos: [
      { name: "idle-new", dir: "trees/idle-and-active/idle-new" },
      { name: "active-old", dir: "trees/idle-and-active/active-old" },
      { name: "idle-old", dir: "trees/idle-and-active/idle-old" },
      { name: "active-new", dir: "trees/idle-and-active/active-new" },
    ],
    modes: {},
    sessions: [
      {
        repo: "idle-new",
        plan: "20261023-0945-idle-new-r1",
        id: "20261023-0945-idle-new-r1.note",
        after: 0,
      },
    ],
    build: buildIdleAndActive,
  },
  {
    name: "missing-folder",
    message: null,
    repos: [{ name: "gone", dir: "trees/missing-folder/absent" }],
    modes: {},
    sessions: [],
    build: buildMissingFolder,
  },
  {
    name: "unreadable-folder",
    message: null,
    repos: [{ name: "sealed", dir: "trees/unreadable-folder/sealed" }],
    modes: { "trees/unreadable-folder/sealed": 0o000 },
    sessions: [],
    build: buildUnreadableFolder,
  },
  {
    name: "over-cap",
    message: OVER_CAP_MESSAGE,
    repos: OVER_CAP_REPOS,
    modes: {},
    sessions: [
      {
        repo: "repo-01",
        plan: "20261023-0905-over-cap-r1",
        id: "20261023-0905-over-cap-r1.extra",
        after: 0,
      },
    ],
    build: buildOverCap,
  },
  {
    name: "transcript-edge",
    message: null,
    repos: [{ name: "theta", dir: "trees/transcript-edge/theta" }],
    modes: {},
    sessions: [
      { repo: "theta", plan: "20261023-1000-edge-r1", id: "20261023-1000-edge-r1.edge.a1", after: 0 },
      { repo: "theta", plan: "20261023-1000-edge-r1", id: "20261023-1000-edge-r1.edge.a1", after: 3 },
      { repo: "theta", plan: "20261023-1000-edge-r1", id: "20261023-1000-edge-r1.edge.a1", after: 9 },
    ],
    build: buildTranscriptEdge,
  },
];

interface TreeRecord {
  dirs: string[];
  files: { rel: string; data: Buffer }[];
}

function walkTree(root: string): TreeRecord {
  const dirs: string[] = [];
  const files: { rel: string; data: Buffer }[] = [];
  const visit = (abs: string, rel: string): void => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const childAbs = path.join(abs, entry.name);
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        dirs.push(childRel);
        visit(childAbs, childRel);
      } else if (entry.isFile()) {
        files.push({ rel: childRel, data: fs.readFileSync(childAbs) });
      }
    }
  };
  visit(root, "");
  dirs.sort();
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  return { dirs, files };
}

/**
 * Every file and folder gets an mtime. Named session mtimes win; everything
 * else comes from the counter, so no value ties and none sits on the stall
 * boundary.
 */
function assignMtimes(
  dirs: string[],
  files: string[],
  explicit: Map<string, number>,
): Record<string, number> {
  const result: Record<string, number> = {};
  let step = 0;
  const ordered = [...dirs, ...files].sort();
  for (const rel of ordered) {
    const named = explicit.get(rel);
    if (named !== undefined) {
      result[rel] = named;
      continue;
    }
    result[rel] = OLD_BASE - step * OLD_STEP;
    step += 1;
  }

  const used = new Set<number>();
  const boundary = NOW - STALL_MS;
  for (const [rel, value] of Object.entries(result)) {
    if (used.has(value)) {
      throw new Error(`two paths share the mtime ${value}: ${rel}`);
    }
    used.add(value);
    if (Math.abs(value - boundary) < 2_000) {
      throw new Error(`mtime of ${rel} is too close to the stall boundary: ${value}`);
    }
  }
  return result;
}

function depth(rel: string): number {
  return rel.split("/").length;
}

/** Deepest path first: writing a child changes its parent's mtime. */
function applyMtimes(root: string, mtimes: Record<string, number>): void {
  const ordered = Object.keys(mtimes).sort(
    (a, b) => depth(b) - depth(a) || a.localeCompare(b),
  );
  for (const rel of ordered) {
    const seconds = mtimes[rel] / 1000;
    fs.utimesSync(path.join(root, rel), seconds, seconds);
  }
}

function applyModes(root: string, modes: Record<string, number>): void {
  for (const [rel, mode] of Object.entries(modes)) {
    fs.chmodSync(path.join(root, rel), mode);
  }
}

function materialize(
  root: string,
  record: TreeRecord,
  mtimes: Record<string, number>,
  modes: Record<string, number>,
): void {
  for (const rel of record.dirs) {
    fs.mkdirSync(path.join(root, rel), { recursive: true });
  }
  for (const file of record.files) {
    const abs = path.join(root, file.rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, file.data);
  }
  applyMtimes(root, mtimes);
  applyModes(root, modes);
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function fetchState(base: string): Promise<unknown> {
  const res = await fetch(`${base}/api/state`);
  if (res.status !== 200) {
    throw new Error(`GET /api/state answered ${res.status}`);
  }
  return res.json();
}

async function fetchSession(
  base: string,
  request: SessionRequest,
): Promise<{ page: unknown; golden: string }> {
  const url =
    `${base}/api/session/${encodeURIComponent(request.repo)}` +
    `/${encodeURIComponent(request.plan)}/${encodeURIComponent(request.id)}` +
    `?after=${request.after}`;
  const res = await fetch(url);
  if (res.status !== 200) {
    throw new Error(`GET ${url} answered ${res.status}`);
  }
  return { page: await res.json(), golden: "" };
}

interface GeneratedCase {
  name: string;
  message: string | null;
  repos: RepoRef[];
  dirs: string[];
  modes: Record<string, number>;
  sessions: SessionRequest[];
  state: unknown;
  pages: unknown[];
}

async function runOracle(
  cases: CaseSpec[],
  oracleRoot: string,
  modes: Record<string, number>,
): Promise<GeneratedCase[]> {
  const generated: GeneratedCase[] = [];
  const originalNow = Date.now;
  try {
    Date.now = () => NOW;
    for (const spec of cases) {
      const repos: RepoRef[] = spec.repos.map((repo) => ({
        name: repo.name,
        dir: path.join(oracleRoot, repo.dir),
      }));
      const handle = startServer({
        repos,
        message: spec.message,
        staticDir: oracleRoot,
        port: 0,
        host: "127.0.0.1",
      });
      try {
        const base = `http://127.0.0.1:${handle.port}`;
        const state = await fetchState(base);
        const pages: unknown[] = [];
        for (const request of spec.sessions) {
          const result = await fetchSession(base, request);
          pages.push(result.page);
        }
        generated.push({
          name: spec.name,
          message: spec.message,
          repos: spec.repos,
          dirs: [],
          modes: spec.modes,
          sessions: spec.sessions,
          state,
          pages,
        });
      } finally {
        handle.stop();
      }
    }
  } finally {
    Date.now = originalNow;
  }
  // Modes were applied before the server ran; hand them back for a safe cleanup.
  for (const rel of Object.keys(modes)) {
    try {
      fs.chmodSync(path.join(oracleRoot, rel), 0o755);
    } catch {
      // The path may already be back to a readable mode.
    }
  }
  return generated;
}

function collectFiles(root: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const visit = (abs: string, rel: string): void => {
    if (!fs.existsSync(abs)) {
      return;
    }
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const childAbs = path.join(abs, entry.name);
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        visit(childAbs, childRel);
      } else if (entry.isFile()) {
        files.set(childRel, fs.readFileSync(childAbs));
      }
    }
  };
  visit(root, "");
  return files;
}

function compareFiles(expectedRoot: string, actualRoot: string): string[] {
  const expected = collectFiles(expectedRoot);
  const actual = collectFiles(actualRoot);
  const problems: string[] = [];
  for (const rel of [...expected.keys()].sort()) {
    const want = expected.get(rel);
    const have = actual.get(rel);
    if (have === undefined) {
      problems.push(`missing: ${rel}`);
    } else if (want === undefined || !want.equals(have)) {
      problems.push(`different: ${rel}`);
    }
  }
  for (const rel of [...actual.keys()].sort()) {
    if (!expected.has(rel)) {
      problems.push(`unexpected: ${rel}`);
    }
  }
  return problems;
}

function segmentProblem(rel: string): string | null {
  const parts = rel.split("/");
  for (const part of parts) {
    if (part === ".plans" || part === "node_modules") {
      return `${rel} has an ignored folder segment (${part})`;
    }
    if (part.endsWith(".log")) {
      return `${rel} ends in .log`;
    }
  }
  return null;
}

/** Fails when git would ignore one of the written paths (root .gitignore). */
function gitIgnored(root: string, rels: string[]): string[] {
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: root,
    encoding: "utf8",
  });
  if (top.status !== 0 || top.stdout.trim() === "") {
    return [];
  }
  const repoRoot = top.stdout.trim();
  const paths = rels.map((rel) =>
    path.relative(repoRoot, path.join(root, rel)).split(path.sep).join("/"),
  );
  const result = spawnSync("git", ["check-ignore", "--stdin"], {
    cwd: repoRoot,
    input: `${paths.join("\n")}\n`,
    encoding: "utf8",
  });
  if (result.status === 1) {
    return [];
  }
  if (result.status !== 0) {
    throw new Error(`git check-ignore failed: ${result.stderr.trim()}`);
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * Fails on a path the root `.gitignore` would hide or that carries an ignored
 * segment. The git check always runs against the testdata folder, because only
 * that path is inside the repository; `--check` writes its files elsewhere.
 */
function guardPaths(rels: string[]): void {
  const problems: string[] = [];
  for (const rel of rels) {
    const problem = segmentProblem(rel);
    if (problem !== null) {
      problems.push(problem);
    }
  }
  for (const ignored of gitIgnored(TESTDATA, rels)) {
    problems.push(`git ignores a written path: ${ignored}`);
  }
  if (problems.length > 0) {
    throw new Error(problems.join("\n"));
  }
}

async function main(): Promise<number> {
  const check = process.argv.includes("--check");
  const srcRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-monitor-golden-src-"));
  const oracleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-monitor-golden-oracle-"));
  const outputRoot = check
    ? fs.mkdtempSync(path.join(os.tmpdir(), "pi-monitor-golden-out-"))
    : TESTDATA;
  const modes: Record<string, number> = {};

  try {
    const explicit = new Map<string, number>();
    for (const spec of CASES) {
      spec.build(srcRoot, explicit);
      Object.assign(modes, spec.modes);
    }
    checkOverCap(srcRoot);

    const record = walkTree(srcRoot);
    if (record.files.length === 0) {
      throw new Error("the fixture tree is empty");
    }
    const mtimes = assignMtimes(
      record.dirs,
      record.files.map((file) => file.rel),
      explicit,
    );

    if (!check) {
      fs.rmSync(path.join(TESTDATA, "trees"), { recursive: true, force: true });
      fs.rmSync(path.join(TESTDATA, "golden"), { recursive: true, force: true });
    }

    // The committed copy stays readable; the oracle copy gets the modes.
    materialize(outputRoot, record, mtimes, {});
    materialize(oracleRoot, record, mtimes, modes);

    const generated = await runOracle(CASES, oracleRoot, modes);

    for (const item of generated) {
      const prefix = `trees/${item.name}`;
      item.dirs = record.dirs.filter(
        (rel) => rel === prefix || rel.startsWith(`${prefix}/`),
      );
    }

    const sessionsByCase = new Map<string, string[]>();
    for (const item of generated) {
      writeJson(path.join(outputRoot, "golden", `${item.name}.state.json`), item.state);
      const goldenFiles: string[] = [];
      item.pages.forEach((page, index) => {
        const golden = `golden/${item.name}.session.${index + 1}.json`;
        writeJson(path.join(outputRoot, golden), page);
        goldenFiles.push(golden);
      });
      sessionsByCase.set(item.name, goldenFiles);
    }

    const manifest = {
      nowMs: NOW,
      cases: generated.map((item) => ({
        name: item.name,
        message: item.message,
        repos: item.repos,
        dirs: item.dirs,
        modes: item.modes,
        state: `golden/${item.name}.state.json`,
        sessions: item.sessions.map((request, index) => ({
          repo: request.repo,
          plan: request.plan,
          id: request.id,
          after: request.after,
          golden: `golden/${item.name}.session.${index + 1}.json`,
        })),
      })),
      mtimes,
    };
    writeJson(path.join(outputRoot, "manifest.json"), manifest);

    const written = [
      ...record.files.map((file) => file.rel),
      ...record.dirs,
      ...generated.flatMap((item) => [
        `golden/${item.name}.state.json`,
        ...(sessionsByCase.get(item.name) ?? []),
      ]),
      "manifest.json",
    ];
    guardPaths(written);

    if (!check) {
      console.log(`wrote ${generated.length} cases to monitor-app/testdata`);
      console.log(`cases: ${generated.map((item) => item.name).join(", ")}`);
      console.log(`files: ${record.files.length}, folders: ${record.dirs.length}`);
      return 0;
    }

    const problems = compareFiles(TESTDATA, outputRoot);
    if (problems.length > 0) {
      console.error("golden files differ from the committed ones:");
      for (const problem of problems.slice(0, 40)) {
        console.error(`  ${problem}`);
      }
      if (problems.length > 40) {
        console.error(`  ... and ${problems.length - 40} more`);
      }
      return 1;
    }
    const fileCount =
      record.files.length +
      generated.length +
      generated.reduce((total, item) => total + item.pages.length, 0) +
      1;
    console.log(`ok: ${fileCount} generated files match the committed ones`);
    return 0;
  } finally {
    for (const rel of Object.keys(modes)) {
      try {
        fs.chmodSync(path.join(oracleRoot, rel), 0o755);
      } catch {
        // Already restored, or never materialized.
      }
    }
    for (const dir of [srcRoot, oracleRoot]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // A temporary folder must never hide the real error.
      }
    }
    if (check) {
      fs.rmSync(outputRoot, { recursive: true, force: true });
    }
  }
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
