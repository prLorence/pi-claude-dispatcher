/** Run with: node --test dispatch-plan/preflight-agent.test.mjs (Node 24+) */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const cli = path.join(import.meta.dirname, "preflight.mjs");
const dispatcher = path.resolve(import.meta.dirname, "..", "pi-plan-dispatch");

/** A temp repo and a temp HOME, with the dispatcher symlinked into the repo. */
function setup() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-preflight-agent-root-"));
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-preflight-agent-home-"));
	fs.symlinkSync(dispatcher, path.join(root, "pi-plan-dispatch"), "dir");
	return { root, home };
}

/** Run the CLI with this machine's own HOME and PI_PLAN_DISPATCH_DIR out of the way. */
function run(ctx, args) {
	const env = { ...process.env, HOME: ctx.home };
	delete env.PI_PLAN_DISPATCH_DIR;
	const r = spawnSync(process.execPath, [cli, ...args], { cwd: ctx.root, env, encoding: "utf8" });
	return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function writePlan(ctx, name, text) {
	const file = path.join(ctx.root, name);
	fs.writeFileSync(file, text);
	return file;
}

/** Write the dispatcher config the CLI loads from the temp repo. */
function writeConfig(ctx, cfg) {
	const dir = path.join(ctx.root, ".plans");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(cfg));
}

/** One task in the named role; the plan itself is otherwise clean. */
function rolePlan(role = "qa") {
	return `---
id: p-r1
trace: p
round: 1
status: draft
verify: node --version
---

Shared context for every worker.

## task: a
role: ${role}
files: docs/a.md
verify: node --version
Covers: R1.

Do the thing.
`;
}

test("a role whose agent is unknown rejects the plan", () => {
	const ctx = setup();
	writeConfig(ctx, { roles: { qa: { agent: "omp" } } });
	const r = run(ctx, [writePlan(ctx, "p-r1.md", rolePlan("qa"))]);
	assert.equal(r.status, 1, r.stdout + r.stderr);
	assert.ok(
		r.stdout.includes('ERROR: role "qa" names agent "omp", which is not available (known agents: pi)'),
		r.stdout,
	);
	assert.equal(r.stdout.includes("OK:"), false, r.stdout);
});

test("a role whose agent is pi passes", () => {
	const ctx = setup();
	writeConfig(ctx, { roles: { qa: { agent: "pi" } } });
	const r = run(ctx, [writePlan(ctx, "p-r1.md", rolePlan("qa"))]);
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.ok(r.stdout.includes("OK: p-r1, 1 tasks"), r.stdout);
	assert.equal(r.stdout.includes("names agent"), false, r.stdout);
	assert.equal(r.stdout.includes("ERROR"), false, r.stdout);
});

test("a config with no agent passes and prints no agent line", () => {
	const ctx = setup();
	writeConfig(ctx, { roles: { qa: { thinking: "low" } } });
	const r = run(ctx, [writePlan(ctx, "p-r1.md", rolePlan("qa"))]);
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.ok(r.stdout.includes("OK: p-r1, 1 tasks"), r.stdout);
	assert.equal(r.stdout.includes("names agent"), false, r.stdout);
	assert.equal(r.stdout.includes("ERROR"), false, r.stdout);
});
