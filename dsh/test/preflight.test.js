import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { preflightPlan } from "../plugins/harness-dispatch/preflight.js";
import { DEFAULT_CONFIG, loadConfig, getDirs } from "../plugins/harness-dispatch/config.js";
import { parsePlan } from "../plugins/harness-dispatch/plan.js";

function cfg(over = {}) {
	return { ...DEFAULT_CONFIG, ...over };
}

function planFor(files, body = "body") {
	return parsePlan(`---\nid: x\n---\n## task: a\nfiles: ${files}\n${body}\n`, "x");
}

test("a clean plan passes preflight", () => {
	assert.deepEqual(preflightPlan(planFor("src/a.ts"), cfg()), []);
});

test("absolute, tilde, URL and .. files entries are rejected", () => {
	for (const entry of ["/etc/passwd", "~/x", "@x", "https://x/y", "src/../x"]) {
		const errors = preflightPlan(planFor(entry), cfg());
		assert.ok(errors.length > 0, entry);
	}
});

test("entries under .git/ and .plans/ are rejected case-insensitively", () => {
	for (const entry of [".git/config", ".GIT/config", ".plans/inbox/x.md"]) {
		const errors = preflightPlan(planFor(entry), cfg());
		assert.ok(errors.some((e) => /may touch|planner owns/.test(e)), entry);
	}
});

test("maxFilesPerTask and maxTaskChars are enforced", () => {
	const many = Array.from({ length: 3 }, (_, i) => `f${i}.ts`).join(", ");
	assert.ok(preflightPlan(planFor(many), cfg({ maxFilesPerTask: 2 })).some((e) => /files listed/.test(e)));
	const long = parsePlan(`---\nid: x\n---\n## task: a\nfiles: a.ts\n${"x".repeat(20)}\n`, "x");
	assert.ok(preflightPlan(long, cfg({ maxTaskChars: 10 })).some((e) => /body is/.test(e)));
});

test("unknown role, read-only role as a task, and bad pair roles are rejected", () => {
	const unknown = parsePlan("---\nid: x\n---\n## task: a\nfiles: a.ts\nrole: nope\nbody\n", "x");
	assert.ok(preflightPlan(unknown, cfg()).some((e) => /unknown role/.test(e)));
	const readonly = parsePlan("---\nid: x\n---\n## task: a\nfiles: a.ts\nrole: review\nbody\n", "x");
	assert.ok(preflightPlan(readonly, cfg()).some((e) => /read-only/.test(e)));
	const badPair = parsePlan("---\nid: x\n---\n## task: a\nfiles: a.ts\npair: implement\nbody\n", "x");
	assert.ok(preflightPlan(badPair, cfg()).some((e) => /not read-only/.test(e)));
	const pairRounds = parsePlan("---\nid: x\n---\n## task: a\nfiles: a.ts\npair: review\npair_rounds: 4\nbody\n", "x");
	assert.ok(preflightPlan(pairRounds, cfg()).some((e) => /pair_rounds must be 1 to 3/.test(e)));
});

test("a files entry that leaves the repo through a symlink is rejected", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-preflight-"));
	fs.mkdirSync(path.join(root, "src"));
	fs.symlinkSync(os.tmpdir(), path.join(root, "src", "out"));
	try {
		const errors = preflightPlan(planFor("src/out/x.ts"), cfg(), root);
		assert.ok(errors.some((e) => /leaves the repo through a symlink/.test(e)), errors.join("\n"));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("pairDefault problems are reported", () => {
	const p = planFor("src/a.ts");
	assert.ok(preflightPlan(p, cfg({ pairDefault: "nope" })).some((e) => /pairDefault names unknown role/.test(e)));
	assert.ok(preflightPlan(p, cfg({ pairDefault: "none" })).some((e) => /cannot be "none"/.test(e)));
	assert.ok(preflightPlan(p, cfg({ pairDefault: "implement" })).some((e) => /not read-only/.test(e)));
});

test("an unknown role agent is reported", () => {
	const p = planFor("src/a.ts");
	const c = loadConfig({ root: path.join(os.tmpdir(), "no-such-plans") });
	c.roles.implement = { ...c.roles.implement, agent: "claude-code" };
	assert.ok(preflightPlan(p, c).some((e) => /agent "claude-code"/.test(e)));
});

test("loadConfig repairs resilience keys and reads prices", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-config-"));
	const d = getDirs(root);
	fs.mkdirSync(d.root, { recursive: true });
	fs.writeFileSync(
		path.join(d.root, "config.json"),
		JSON.stringify({ retries: 2, backoffSeconds: [1, 2], stallMinutes: -1, probeUrls: ["http://x"], prices: { "m/x": { in: 1, out: 2 } } }),
	);
	const c = loadConfig(d);
	assert.equal(c.retries, 2);
	assert.deepEqual(c.backoffSeconds, [1, 2]);
	assert.equal(c.stallMinutes, DEFAULT_CONFIG.stallMinutes);
	assert.deepEqual(c.probeUrls, ["http://x"]);
	assert.deepEqual(c.prices["m/x"], { in: 1, out: 2 });
	fs.rmSync(root, { recursive: true, force: true });
});
