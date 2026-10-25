import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  cleanup,
  ev,
  makePlansDir,
  writeEvents,
  writePlan,
  writeSession,
  sessionHeader,
} from "../../test/fixture.ts";
import type { RepoConfig } from "./repos.ts";
import { repoSignature, signature } from "./watch.ts";

const T1 = "2026-10-23T10:00:00.000Z";

function repo(name: string, dir: string): RepoConfig {
  return { name, dir };
}

function runningRepo(): string {
  const dir = makePlansDir();
  writePlan(dir, "running", "p-r1", [{ id: "one" }], "trace-a");
  writeEvents(dir, "trace-a", [ev("task.start", "p-r1", T1, { task: "one" })]);
  return dir;
}

test("repoSignature keeps its old results for one plans folder", () => {
  const dir = makePlansDir();
  try {
    expect(repoSignature(dir, null)).not.toBe("");
    const before = repoSignature(dir, "p-r1");
    writePlan(dir, "running", "p-r1", [{ id: "one" }], "trace-a");
    expect(repoSignature(dir, "p-r1")).not.toBe(before);
    expect(repoSignature(path.join(dir, "missing"), null)).toBe("");
  } finally {
    cleanup(dir);
  }
});

test("signature is empty for no repos", () => {
  expect(signature([])).toBe("");
});

test("signature is stable between calls with no change", () => {
  const dir = runningRepo();
  try {
    const repos = [repo("one", dir)];
    expect(signature(repos)).toBe(signature(repos));
  } finally {
    cleanup(dir);
  }
});

test("signature changes when a file of any repo changes", () => {
  const a = runningRepo();
  const b = runningRepo();
  try {
    const repos = [repo("a", a), repo("b", b)];
    const before = signature(repos);
    writeEvents(b, "trace-a", [ev("task.end", "p-r1", T1, { task: "one" })]);
    expect(signature(repos)).not.toBe(before);
  } finally {
    cleanup(a);
    cleanup(b);
  }
});

test("signature changes when a session file of the shown plan appears", () => {
  const dir = runningRepo();
  try {
    const repos = [repo("one", dir)];
    const before = signature(repos);
    writeSession(dir, "p-r1", "p-r1.one.a1", [sessionHeader("p-r1.one.a1")]);
    expect(signature(repos)).not.toBe(before);
  } finally {
    cleanup(dir);
  }
});

test("signature differs between repos with the same content", () => {
  const a = runningRepo();
  const b = runningRepo();
  try {
    expect(signature([repo("a", a)])).not.toBe(signature([repo("b", b)]));
    expect(signature([repo("a", a), repo("b", b)])).toContain("\n");
  } finally {
    cleanup(a);
    cleanup(b);
  }
});

test("signature keeps a repo without a plans folder in the list", () => {
  const dir = runningRepo();
  const missing = path.join(makePlansDir(), "nope");
  const parent = path.dirname(missing);
  try {
    const text = signature([repo("one", dir), repo("gone", missing)]);
    expect(text).toContain("gone=");
    expect(text.split("\n").length).toBe(2);
  } finally {
    cleanup(dir);
    cleanup(parent);
  }
});

test("signature ignores a change in a session folder of an unshown plan", () => {
  const dir = runningRepo();
  try {
    const repos = [repo("one", dir)];
    const before = signature(repos);
    writeSession(dir, "other-plan", "other-plan.one.a1", [
      sessionHeader("other-plan.one.a1"),
    ]);
    expect(signature(repos)).toBe(before);
    writePlan(dir, "done", "other-plan", [{ id: "one" }], "trace-other");
    expect(signature(repos)).not.toBe(before);
  } finally {
    cleanup(dir);
  }
});

test("signature notices a new done folder name", () => {
  const dir = runningRepo();
  try {
    const repos = [repo("one", dir)];
    const before = signature(repos);
    fs.mkdirSync(path.join(dir, "done", "another"), { recursive: true });
    expect(signature(repos)).not.toBe(before);
  } finally {
    cleanup(dir);
  }
});
