import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  cleanup,
  ev,
  makePlansDir,
  writeEvents,
  writePlan,
} from "../../test/fixture";
import { parsePlan, readTraceEvents, selectPlan } from "./plans.ts";

function planText(extra: string, tasks = ""): string {
  return [
    "---",
    "id: 20261023-monitor-r1",
    "trace: 20261023-monitor",
    "round: 2",
    "status: ready",
    "---",
    "## Context",
    "",
    "Body text.",
    extra,
    tasks,
    "",
  ].join("\n");
}

test("parsePlan reads frontmatter and both depends_on forms", () => {
  const tasks = [
    "",
    "## task: one",
    "files: a.ts",
    "depends_on: [two, three]",
    "pair: reviewer",
    "role: implement",
    "",
    "Body.",
    "",
    "## task: two",
    "files: b.ts",
    "depends_on: []",
    "",
    "Body.",
    "",
    "## task: three",
    "files: c.ts",
    "depends_on: one, two",
    "",
    "Body.",
  ].join("\n");
  const parsed = parsePlan(planText("", tasks));
  expect(parsed).not.toBeNull();
  if (parsed === null) {
    return;
  }
  expect(parsed.id).toBe("20261023-monitor-r1");
  expect(parsed.trace).toBe("20261023-monitor");
  expect(parsed.round).toBe(2);
  expect(parsed.tasks.length).toBe(3);
  expect(parsed.tasks[0]).toEqual({
    id: "one",
    role: "implement",
    pair: "reviewer",
    dependsOn: ["two", "three"],
  });
  expect(parsed.tasks[1].dependsOn).toEqual([]);
  expect(parsed.tasks[1].pair).toBeNull();
  expect(parsed.tasks[2].dependsOn).toEqual(["one", "two"]);
});

test("parsePlan defaults role, trace and round", () => {
  const text = [
    "---",
    "id: p1",
    "---",
    "## task: t1",
    "files: a.ts",
    "",
    "Body.",
  ].join("\n");
  const parsed = parsePlan(text);
  expect(parsed).not.toBeNull();
  if (parsed === null) {
    return;
  }
  expect(parsed.trace).toBe("p1");
  expect(parsed.round).toBe(1);
  expect(parsed.tasks[0].role).toBe("implement");
  expect(parsed.tasks[0].pair).toBeNull();
  expect(parsed.tasks[0].dependsOn).toEqual([]);
});

test("parsePlan strips a trailing comment from pair and treats empty pair as null", () => {
  const text = [
    "---",
    "id: p1",
    "---",
    "## task: t1",
    "pair: review # the pair role",
    "",
    "Body.",
    "## task: t2",
    "pair:",
    "",
    "Body.",
  ].join("\n");
  const parsed = parsePlan(text);
  expect(parsed).not.toBeNull();
  if (parsed === null) {
    return;
  }
  expect(parsed.tasks[0].pair).toBe("review");
  expect(parsed.tasks[1].pair).toBeNull();
});

test("parsePlan stops metadata at the first non key line", () => {
  const text = [
    "---",
    "id: p1",
    "---",
    "## task: t1",
    "depends_on: [a]",
    "This is prose, not metadata.",
    "role: qa",
    "",
    "Body.",
  ].join("\n");
  const parsed = parsePlan(text);
  expect(parsed).not.toBeNull();
  if (parsed === null) {
    return;
  }
  expect(parsed.tasks[0].dependsOn).toEqual(["a"]);
  expect(parsed.tasks[0].role).toBe("implement");
});

test("parsePlan returns null without an id and handles no tasks", () => {
  expect(parsePlan("---\ntrace: t\n---\n## task: a\n")).toBeNull();
  expect(parsePlan("no frontmatter at all")).toBeNull();
  const parsed = parsePlan("---\nid: p1\n---\n## Context\n\nNothing.\n");
  expect(parsed).not.toBeNull();
  if (parsed !== null) {
    expect(parsed.tasks).toEqual([]);
  }
});

test("readTraceEvents keeps only the plan's events and skips bad lines", () => {
  const dir = makePlansDir();
  try {
    const trace = "tr";
    fs.writeFileSync(
      path.join(dir, "traces", `${trace}.jsonl`),
      [
        JSON.stringify(ev("task.start", "p1", "2026-10-22T10:00:00.000Z", { task: "a" })),
        "not json at all",
        JSON.stringify(ev("task.end", "p2", "2026-10-22T10:01:00.000Z", { task: "a" })),
        JSON.stringify([1, 2, 3]),
        JSON.stringify("just a string"),
        JSON.stringify(null),
        JSON.stringify(ev("task.end", "p1", "2026-10-22T10:02:00.000Z", { task: "a" })),
        "",
      ].join("\n"),
    );
    const events = readTraceEvents(dir, trace, "p1");
    expect(events.length).toBe(2);
    expect(events[0].kind).toBe("task.start");
    expect(events[1].kind).toBe("task.end");
    expect(events[1].ts).toBe("2026-10-22T10:02:00.000Z");
  } finally {
    cleanup(dir);
  }
});

test("readTraceEvents returns an empty list for a missing trace file", () => {
  const dir = makePlansDir();
  try {
    expect(readTraceEvents(dir, "nope", "p1")).toEqual([]);
  } finally {
    cleanup(dir);
  }
});

test("selectPlan prefers a running plan over a finished one", () => {
  const dir = makePlansDir();
  try {
    writePlan(dir, "done", "old-plan", [{ id: "a" }], "old-trace");
    writePlan(dir, "running", "live-plan", [{ id: "a" }], "live-trace");
    fs.writeFileSync(path.join(dir, "running", "broken.md"), "not a plan");
    const selected = selectPlan(dir);
    expect(selected.message).toBeNull();
    expect(selected.running).toBe(true);
    expect(selected.plan?.id).toBe("live-plan");
  } finally {
    cleanup(dir);
  }
});

test("selectPlan picks the newest finished plan by plan.end timestamp", () => {
  const dir = makePlansDir();
  try {
    writePlan(dir, "done", "first-plan", [{ id: "a" }], "first-trace");
    writePlan(dir, "done", "second-plan", [{ id: "a" }], "second-trace");
    writeEvents(dir, "first-trace", [
      ev("plan.end", "first-plan", "2026-10-22T20:00:00.000Z", { data: { gate_pass: true } }),
    ]);
    writeEvents(dir, "second-trace", [
      ev("plan.end", "second-plan", "2026-10-22T21:00:00.000Z", { data: { gate_pass: true } }),
    ]);
    const older = new Date("2026-10-22T20:30:00.000Z");
    const newer = new Date("2026-10-22T19:00:00.000Z");
    fs.utimesSync(path.join(dir, "done", "first-plan"), older, older);
    fs.utimesSync(path.join(dir, "done", "second-plan"), newer, newer);

    const selected = selectPlan(dir);
    expect(selected.running).toBe(false);
    expect(selected.message).toBeNull();
    expect(selected.plan?.id).toBe("second-plan");
  } finally {
    cleanup(dir);
  }
});

test("selectPlan falls back to the folder mtime without a plan.end event", () => {
  const dir = makePlansDir();
  try {
    writePlan(dir, "done", "mtime-old", [{ id: "a" }], "trace-old");
    writePlan(dir, "done", "mtime-new", [{ id: "b" }], "trace-new");
    const older = new Date("2026-10-22T10:00:00.000Z");
    const newer = new Date("2026-10-22T12:00:00.000Z");
    fs.utimesSync(path.join(dir, "done", "mtime-old"), newer, newer);
    fs.utimesSync(path.join(dir, "done", "mtime-new"), older, older);

    const selected = selectPlan(dir);
    expect(selected.plan?.id).toBe("mtime-old");
  } finally {
    cleanup(dir);
  }
});

test("selectPlan reports both messages", () => {
  const dir = makePlansDir();
  try {
    const empty = selectPlan(dir);
    expect(empty.plan).toBeNull();
    expect(empty.running).toBe(false);
    expect(empty.message).toBe("No plan has run yet");
  } finally {
    cleanup(dir);
  }

  const missing = path.join(dir, "does-not-exist");
  const absent = selectPlan(missing);
  expect(absent.plan).toBeNull();
  expect(absent.running).toBe(false);
  expect(absent.message).toBe("No plans folder found");
});
