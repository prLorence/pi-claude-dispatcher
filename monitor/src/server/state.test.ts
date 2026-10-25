import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  cleanup,
  ev,
  makePlansDir,
  writeEvents,
  writePlan,
} from "../../test/fixture.ts";
import type { RepoConfig } from "./repos.ts";
import { readRepo, readState } from "./state.ts";

const NOW = Date.parse("2026-10-23T10:05:00.000Z");
const T1 = "2026-10-23T10:00:00.000Z";
const T2 = "2026-10-23T10:01:00.000Z";
const T3 = "2026-10-23T10:02:00.000Z";
const T4 = "2026-10-23T10:03:00.000Z";

function repo(dir: string): RepoConfig {
  return { name: path.basename(dir), dir };
}

test("readRepo reads a running plan and its event times", () => {
  const dir = makePlansDir();
  try {
    writePlan(dir, "running", "p-r1", [{ id: "one" }], "trace-a");
    writeEvents(dir, "trace-a", [
      ev("task.start", "p-r1", T1, { task: "one", attempt: 1 }),
      ev("task.end", "p-r1", T2, { task: "one", attempt: 1, data: { state: "done" } }),
    ]);

    const view = readRepo(repo(dir), NOW);
    expect(view.active).toBe(true);
    expect(view.plan?.id).toBe("p-r1");
    expect(view.message).toBeNull();
    expect(view.startedAt).toBe(T1);
    expect(view.lastActivity).toBe(T2);
    expect(view.plan?.tasks[0].implementer.state).toBe("done");
  } finally {
    cleanup(dir);
  }
});

test("readRepo reads the latest finished plan of an idle repo", () => {
  const dir = makePlansDir();
  try {
    writePlan(dir, "done", "old-r1", [{ id: "one" }], "trace-old");
    writePlan(dir, "done", "new-r1", [{ id: "one" }], "trace-new");
    writeEvents(dir, "trace-old", [
      ev("plan.end", "old-r1", T1, { data: { gate_pass: true } }),
    ]);
    writeEvents(dir, "trace-new", [
      ev("plan.end", "new-r1", T3, { data: { gate_pass: false } }),
    ]);

    const view = readRepo(repo(dir), NOW);
    expect(view.active).toBe(false);
    expect(view.plan?.id).toBe("new-r1");
    expect(view.plan?.state).toBe("failed");
    expect(view.startedAt).toBe(T3);
    expect(view.lastActivity).toBe(T3);
  } finally {
    cleanup(dir);
  }
});

test("readRepo reports an empty plans folder", () => {
  const dir = makePlansDir();
  try {
    const view = readRepo(repo(dir), NOW);
    expect(view.plan).toBeNull();
    expect(view.active).toBe(false);
    expect(view.message).toBe("No plan has run yet");
    expect(view.startedAt).toBeNull();
    expect(view.lastActivity).toBeNull();
  } finally {
    cleanup(dir);
  }
});

test("readRepo reports a missing folder without throwing", () => {
  const dir = path.join(makePlansDir(), "does-not-exist");
  const parent = path.dirname(dir);
  try {
    const view = readRepo({ name: "gone", dir }, NOW);
    expect(view.name).toBe("gone");
    expect(view.plan).toBeNull();
    expect(view.active).toBe(false);
    expect(view.message).toBe("No plans folder found");
    expect(view.startedAt).toBeNull();
    expect(view.lastActivity).toBeNull();
  } finally {
    cleanup(parent);
  }
});

test("readRepo applies the decider overlay", () => {
  const dir = makePlansDir();
  try {
    writePlan(dir, "running", "p-r1", [{ id: "one" }], "trace-a");
    writeEvents(dir, "trace-a", [
      ev("decision.effort", "p-r1", T1, {
        task: "one",
        data: {
          task: "one",
          suggested: "high",
          probabilities: { high: 0.7 },
          confidence: 0.6,
          complexity: 4,
          mode: "apply",
        },
      }),
      ev("task.start", "p-r1", T2, {
        task: "one",
        attempt: 1,
        data: { thinking: "low" },
      }),
      ev("decision.audit", "p-r1", T3, {
        data: {
          audit_round: 1,
          verdict: "pass",
          proposal: "approve",
          aggregate: 0.25,
          findings: [{ id: "f1", severity: "major", p: 0.3 }],
        },
      }),
    ]);

    const view = readRepo(repo(dir), NOW);
    expect(view.plan?.tasks[0].decider?.suggested).toBe("high");
    expect(view.plan?.tasks[0].decider?.ran).toBe("low");
    expect(view.plan?.audit?.proposal).toBe("approve");
    expect(view.plan?.audit?.findings.length).toBe(1);
  } finally {
    cleanup(dir);
  }
});

test("readState orders active repos by start, then idle repos by last activity", () => {
  const old = makePlansDir();
  const young = makePlansDir();
  const idle = makePlansDir();
  try {
    writePlan(old, "running", "old-r1", [{ id: "one" }], "trace-old");
    writeEvents(old, "trace-old", [ev("task.start", "old-r1", T1, { task: "one" })]);
    writePlan(young, "running", "young-r1", [{ id: "one" }], "trace-young");
    writeEvents(young, "trace-young", [
      ev("task.start", "young-r1", T4, { task: "one" }),
    ]);
    writePlan(idle, "done", "idle-r1", [{ id: "one" }], "trace-idle");
    writeEvents(idle, "trace-idle", [
      ev("plan.end", "idle-r1", T3, { data: { gate_pass: true } }),
    ]);

    const state = readState(
      [
        { name: "idle", dir: idle },
        { name: "old", dir: old },
        { name: "young", dir: young },
      ],
      NOW,
      "a note",
    );
    expect(state.repos.map((entry) => entry.name)).toEqual(["young", "old", "idle"]);
    expect(state.message).toBe("a note");
    expect(state.now).toBe(new Date(NOW).toISOString());
  } finally {
    cleanup(old);
    cleanup(young);
    cleanup(idle);
  }
});

test("readState puts a repo without a plan last and keeps the configured order on ties", () => {
  const first = makePlansDir();
  const second = makePlansDir();
  const empty = path.join(makePlansDir(), "missing");
  const parent = path.dirname(empty);
  try {
    writePlan(first, "done", "a-r1", [{ id: "one" }], "trace-a");
    writeEvents(first, "trace-a", [ev("plan.end", "a-r1", T2, { data: {} })]);
    writePlan(second, "done", "b-r1", [{ id: "one" }], "trace-b");
    writeEvents(second, "trace-b", [ev("plan.end", "b-r1", T2, { data: {} })]);

    const state = readState(
      [
        { name: "first", dir: first },
        { name: "second", dir: second },
        { name: "empty", dir: empty },
      ],
      NOW,
    );
    expect(state.repos.map((entry) => entry.name)).toEqual(["first", "second", "empty"]);
    expect(state.message).toBeNull();
  } finally {
    cleanup(first);
    cleanup(second);
    cleanup(parent);
  }
});

test("readState returns no repos for an empty configuration", () => {
  const state = readState([], NOW);
  expect(state.repos).toEqual([]);
  expect(state.message).toBeNull();
});

test("readRepo keeps reading when a session file is unreadable", () => {
  const dir = makePlansDir();
  try {
    writePlan(dir, "running", "p-r1", [{ id: "one" }], "trace-a");
    writeEvents(dir, "trace-a", [ev("task.start", "p-r1", T1, { task: "one" })]);
    fs.mkdirSync(path.join(dir, "sessions", "p-r1"), { recursive: true });

    const view = readRepo(repo(dir), NOW);
    expect(view.plan?.id).toBe("p-r1");
    expect(view.active).toBe(true);
  } finally {
    cleanup(dir);
  }
});
