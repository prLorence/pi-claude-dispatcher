/** Run with: node --test dispatch-plan/preflight.test.mjs (Node 24+) */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const cli = path.join(import.meta.dirname, "preflight.mjs");
const dispatcher = path.resolve(import.meta.dirname, "..", "pi-plan-dispatch");

/** A temp repo and a temp HOME; the dispatcher symlink is opt-in. */
function setup({ link = true } = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-preflight-root-"));
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-preflight-home-"));
	if (link) fs.symlinkSync(dispatcher, path.join(root, "pi-plan-dispatch"), "dir");
	return { root, home };
}

/** Run the CLI with this machine's own HOME and PI_PLAN_DISPATCH_DIR out of the way. */
function run(ctx, args, extraEnv = {}) {
	const env = { ...process.env, HOME: ctx.home, ...extraEnv };
	delete env.PI_PLAN_DISPATCH_DIR;
	Object.assign(env, extraEnv);
	const r = spawnSync(process.execPath, [cli, ...args], { cwd: ctx.root, env, encoding: "utf8" });
	return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function writePlan(ctx, name, text) {
	const file = path.join(ctx.root, name);
	fs.writeFileSync(file, text);
	return file;
}

/** A plan the dispatcher accepts: one task, every verify command real. */
function cleanPlan(id = "p-r1") {
	return `---
id: ${id}
trace: p
round: 1
status: draft
spec: .plans/specs/p.md
verify: node --version
---

Shared context for every worker.

## task: a
files: docs/a.md
verify: node --version
Covers: R1.

Do the thing.
`;
}

const head = (extra = "") => `---\nid: p-r1\ntrace: p\nround: 1\nstatus: draft\n${extra}---\n\nShared context.\n\n`;

test("a clean plan passes", () => {
	const ctx = setup();
	const r = run(ctx, [writePlan(ctx, "p-r1.md", cleanPlan())]);
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.ok(r.stdout.includes("OK: p-r1, 1 tasks"), r.stdout);
	assert.equal(r.stdout.includes("ERROR"), false);
	assert.equal(r.stdout.includes("WARN"), false);
	// macOS resolves /var to /private/var, so compare the real paths.
	assert.ok(r.stderr.includes(`dispatcher: ${path.join(fs.realpathSync(ctx.root), "pi-plan-dispatch")}`), r.stderr);
});

test("an unknown dependency is an error", () => {
	const ctx = setup();
	const text = `${head()}## task: a\ndepends_on: ghost\nfiles: docs/a.md\nverify: node --version\n\nDo the thing.\n`;
	const r = run(ctx, [writePlan(ctx, "p-r1.md", text)]);
	assert.equal(r.status, 1, r.stdout + r.stderr);
	assert.ok(r.stdout.includes("ERROR: Task a depends on unknown task ghost"), r.stdout);
});

test("a files entry outside the repo is an error", () => {
	const ctx = setup();
	const text = `${head()}## task: a\nfiles: ../x\nverify: node --version\n\nDo the thing.\n`;
	const r = run(ctx, [writePlan(ctx, "p-r1.md", text)]);
	assert.equal(r.status, 1, r.stdout + r.stderr);
	assert.ok(r.stdout.includes('ERROR: Task a: files entry "../x" contains ".."; it must stay inside the repo'), r.stdout);
});

test("a files entry behind a symlink out of the repo is an error", () => {
	const ctx = setup();
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pi-preflight-outside-"));
	try {
		fs.symlinkSync(outside, path.join(ctx.root, "escape"), "dir");
		const text = `${head()}## task: a\nfiles: escape/new.md\nverify: node --version\n\nDo the thing.\n`;
		const r = run(ctx, [writePlan(ctx, "p-r1.md", text)]);
		assert.equal(r.status, 1, r.stdout + r.stderr);
		assert.ok(r.stdout.includes('ERROR: Task a: files entry "escape/new.md" leaves the repo through a symlink'), r.stdout);
	} finally {
		fs.rmSync(ctx.root, { recursive: true, force: true });
		fs.rmSync(ctx.home, { recursive: true, force: true });
		fs.rmSync(outside, { recursive: true, force: true });
	}
});

test("a missing task verify command is an error", () => {
	const ctx = setup();
	const text = `${head("verify: node --version\n")}## task: a\nfiles: docs/a.md\nverify: preflight-missing-cmd --flag\n\nDo the thing.\n`;
	const r = run(ctx, [writePlan(ctx, "p-r1.md", text)]);
	assert.equal(r.status, 1, r.stdout + r.stderr);
	assert.ok(r.stdout.includes("ERROR: task a: verify command not found: preflight-missing-cmd"), r.stdout);
});

test("a missing plan verify command is an error", () => {
	const ctx = setup();
	const text = `${head("verify: preflight-missing-plan-cmd\n")}## task: a\nfiles: docs/a.md\nverify: node --version\n\nDo the thing.\n`;
	const r = run(ctx, [writePlan(ctx, "p-r1.md", text)]);
	assert.equal(r.status, 1, r.stdout + r.stderr);
	assert.ok(r.stdout.includes("ERROR: plan: verify command not found: preflight-missing-plan-cmd"), r.stdout);
});

test("a task without instructions is an error", () => {
	const ctx = setup();
	const text = `${head("verify: node --version\n")}## task: a\nfiles: docs/a.md\nverify: node --version\n`;
	const r = run(ctx, [writePlan(ctx, "p-r1.md", text)]);
	assert.equal(r.status, 1, r.stdout + r.stderr);
	assert.ok(r.stdout.includes("ERROR: Task a has no instructions"), r.stdout);
});

test("an oversized task is an error", () => {
	const ctx = setup();
	const text = `${head("verify: node --version\n")}## task: a\nfiles: docs/a.md\nverify: node --version\n\n${"x".repeat(8100)}\n`;
	const r = run(ctx, [writePlan(ctx, "p-r1.md", text)]);
	assert.equal(r.status, 1, r.stdout + r.stderr);
	assert.ok(r.stdout.includes("ERROR: Task a: body is 8100 chars (max 8000); split it into smaller tasks"), r.stdout);
});

test("missing verify commands only warn", () => {
	const ctx = setup();
	const text = `${head()}## task: a\nfiles: docs/a.md\n\nDo the thing.\n`;
	const r = run(ctx, [writePlan(ctx, "p-r1.md", text)]);
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.equal(r.stdout.includes("ERROR"), false);
	assert.ok(r.stdout.includes("WARN: plan: no verify: command"), r.stdout);
	assert.ok(r.stdout.includes("WARN: task a: no verify: command"), r.stdout);
	assert.ok(r.stdout.includes("OK: p-r1, 1 tasks"), r.stdout);
});

test("a .md.draft file is accepted and its id is the name without the suffix", () => {
	const ctx = setup();
	const text = `---\ntrace: p\nround: 1\nstatus: draft\nverify: node --version\n---\n\nShared context.\n\n## task: a\nfiles: docs/a.md\nverify: node --version\n\nDo the thing.\n`;
	const r = run(ctx, [writePlan(ctx, "drafty-r1.md.draft", text)]);
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.ok(r.stdout.includes("OK: drafty-r1, 1 tasks"), r.stdout);
});

test("no plan file prints usage and exits 64", () => {
	const ctx = setup();
	const r = run(ctx, []);
	assert.equal(r.status, 64, r.stdout + r.stderr);
	assert.ok(r.stderr.includes("usage: node preflight.mjs <plan-file> [--root <repo>]"), r.stderr);
});

test("no dispatcher modules exits 2", () => {
	const ctx = setup({ link: false });
	const r = run(ctx, [writePlan(ctx, "p-r1.md", cleanPlan())]);
	assert.equal(r.status, 2, r.stdout + r.stderr);
	assert.equal(r.stdout, "");
	assert.ok(r.stderr.includes("cannot find the pi-plan-dispatch modules"), r.stderr);
});

test("PI_PLAN_DISPATCH_DIR finds the dispatcher outside the repo", () => {
	const ctx = setup({ link: false });
	const r = run(ctx, [writePlan(ctx, "p-r1.md", cleanPlan())], { PI_PLAN_DISPATCH_DIR: dispatcher });
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.ok(r.stderr.includes(`dispatcher: ${dispatcher}`), r.stderr);
	assert.ok(r.stdout.includes("OK: p-r1, 1 tasks"), r.stdout);
});

test("the settings packages list is a fallback and npm: entries are not folders", () => {
	const ctx = setup({ link: false });
	const agentDir = path.join(ctx.home, ".pi", "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	// A folder that happens to be named like the npm package would be found
	// first if the npm: entry were treated as a path.
	fs.symlinkSync(dispatcher, path.join(agentDir, "npm:pi-plan-dispatch"), "dir");
	const pkg = path.join(ctx.home, "pkg", "pi-plan-dispatch");
	fs.mkdirSync(path.dirname(pkg), { recursive: true });
	fs.symlinkSync(dispatcher, pkg, "dir");
	fs.writeFileSync(
		path.join(agentDir, "settings.json"),
		JSON.stringify({ packages: ["npm:pi-plan-dispatch", "../../pkg/pi-plan-dispatch"] }),
	);
	const r = run(ctx, [writePlan(ctx, "p-r1.md", cleanPlan())]);
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.ok(r.stderr.includes(`dispatcher: ${pkg}`), r.stderr);
	assert.equal(r.stderr.includes("npm:"), false);
});
