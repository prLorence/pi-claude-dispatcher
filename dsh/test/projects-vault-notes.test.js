import { test } from "node:test";
import assert from "node:assert/strict";
import { composeWarm, noteRecord, parseNote, projectFor, sortFindings } from "../plugins/harness-projects/vault-notes.js";

const FINDING = `---
type: finding
created: 2026-11-02
updated: 2026-11-02
trace: 20261101-1923-dispatch-effort
repo: github.com/prlorence/pi-claude-dispatcher
severity: major
fingerprint: github.com/prlorence/pi-claude-dispatcher:-:leak
source: security
status: open
---
A world-readable key file is accepted silently.
`;

const PROJECT = `---
type: project
created: 2026-10-22
updated: 2026-10-22
repos:
  - github.com/prlorence/pi-claude-dispatcher
  - local-side
---
Claude Code is the single interface.

- Gate: all tasks done and zero error faults.
`;

test("parseNote reads scalars and list properties", () => {
	const { data, body } = parseNote(PROJECT);
	assert.equal(data.type, "project");
	assert.deepEqual(data.repos, ["github.com/prlorence/pi-claude-dispatcher", "local-side"]);
	assert.match(body, /single interface/);
	const finding = parseNote(FINDING);
	assert.equal(finding.data.severity, "major");
	assert.equal(finding.data.status, "open");
});

test("noteRecord carries the match keys", () => {
	const record = noteRecord({ basename: "b", type: "findings", path: "p", data: parseNote(FINDING).data, body: "x" });
	assert.equal(record.repo, "github.com/prlorence/pi-claude-dispatcher");
	assert.equal(record.type, "finding");
	assert.equal(record.severity, "major");
	assert.deepEqual(record.repos, []);
});

test("projectFor matches a project note by repo slug", () => {
	const project = noteRecord({ basename: "project-pi", type: "projects", path: "p", data: parseNote(PROJECT).data, body: "x" });
	assert.equal(projectFor([project], "github.com/prlorence/pi-claude-dispatcher"), project);
	assert.equal(projectFor([project], "github.com/other/repo"), undefined);
});

test("sortFindings ranks severity before recency", () => {
	const make = (severity, updated, basename) => ({ severity, updated, basename });
	const sorted = sortFindings([make("minor", "2026-11-05", "c"), make("blocker", "2026-11-01", "a"), make("major", "2026-11-02", "b")], 2);
	assert.deepEqual(sorted.map((note) => note.basename), ["a", "b"]);
});

test("composeWarm renders identity, git, project, findings and runs", () => {
	const text = composeWarm({
		slug: "github.com/prlorence/pi-claude-dispatcher",
		mode: "full",
		git: { root: "/Users/paul/repos/pi", branch: "main", upstream: "origin/main", ahead: 1, behind: 0, dirty: 2, untracked: 0, lastCommit: { short: "abc1234", subject: "Add the plugin", date: "2 hours ago" } },
		project: { basename: "project-pi-plan-dispatch", body: "Claude Code is the single interface.\n- Gate: all tasks done." },
		findings: [{ basename: "20261101-f-1", severity: "blocker", status: "open", title: "A world-readable key file", updated: "2026-11-02" }],
		runs: [{ basename: "20261101-run", gate: "pass", status: "done", updated: "2026-11-01" }],
		decisions: [{ basename: "decision-workflow", updated: "2026-11-01" }],
		logLines: ["2026-11-01 [host] github.com/prlorence/pi-claude-dispatcher r1: gate PASS"],
		budget: 4000,
	});
	assert.match(text, /## Project context — github\.com\/prlorence\/pi-claude-dispatcher/);
	assert.match(text, /on main/);
	assert.match(text, /Project note \[\[project-pi-plan-dispatch\]\]/);
	assert.match(text, /\[blocker\] 20261101-f-1/);
	assert.match(text, /gate pass, done/);
	assert.match(text, /\[\[decision-workflow\]\]/);
	assert.match(text, /Last log: 2026-11-01/);
});

test("composeWarm never exceeds a tight budget and marks the trim", () => {
	const text = composeWarm({
		slug: "local-x",
		mode: "none",
		git: { root: "/srv/x", branch: "main", dirty: 0, untracked: 0 },
		project: { basename: "project-x", body: "One.\nTwo.\nThree.\nFour." },
		findings: [{ basename: "f", severity: "info", status: "open", title: "t".repeat(200), updated: "2026-01-01" }],
		runs: [{ basename: "r", gate: "fail", status: "failed", updated: "2026-01-01" }],
		logLines: ["l".repeat(200)],
		budget: 500,
	});
	assert.ok(text.length <= 510, `budget exceeded: ${text.length}`);
	assert.match(text, /truncated/);
});

test("composeWarm says nothing without a slug", () => {
	assert.equal(composeWarm({}), "");
});
