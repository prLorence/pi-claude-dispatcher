import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_CONFIG, costOf, ensureDirs, getDirs, loadConfig } from "../plugins/harness-dispatch/config.js";

test("defaults carry the existing keys and the dsh additions", () => {
	assert.equal(DEFAULT_CONFIG.maxParallel, 3);
	assert.equal(DEFAULT_CONFIG.retries, 1);
	assert.equal(DEFAULT_CONFIG.verifyTimeoutMinutes, 10);
	assert.equal(DEFAULT_CONFIG.maxFilesPerTask, 10);
	assert.deepEqual(DEFAULT_CONFIG.backoffSeconds, [15, 30, 60, 120, 300, 300]);
	assert.equal(DEFAULT_CONFIG.decider.effort, "off");
	assert.deepEqual(DEFAULT_CONFIG.prices, {});
});

test("a missing config falls back to the defaults, and config.json is never written", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-config-default-"));
	const d = getDirs(root);
	fs.mkdirSync(d.root, { recursive: true });
	const cfg = loadConfig(d);
	assert.equal(cfg.model, DEFAULT_CONFIG.model);
	assert.equal(fs.existsSync(path.join(d.root, "config.json")), false);
	ensureDirs(d);
	assert.equal(fs.existsSync(d.inbox), true);
	fs.rmSync(root, { recursive: true, force: true });
});

test("costOf uses the prices table and returns undefined for an unknown model", () => {
	const cfg = { prices: { "m/x": { in: 1, out: 2 } } };
	assert.equal(costOf(cfg, "m/x", 1_000_000, 1_000_000), 3);
	assert.equal(costOf(cfg, "m/y", 1, 1), undefined);
});

test("dshPairDefault overrides pairDefault for dsh without changing the shared config key", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-config-pair-"));
	const d = getDirs(root);
	fs.mkdirSync(d.root, { recursive: true });
	fs.writeFileSync(path.join(d.root, "config.json"), JSON.stringify({ pairDefault: "review", dshPairDefault: "pair-omp" }));
	try {
		assert.equal(loadConfig(d).pairDefault, "pair-omp");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
