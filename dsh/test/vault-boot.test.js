import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { loadVaultBoot } from "../plugins/harness-vault/boot.js";
import { createVaultCli } from "../plugins/harness-vault/vault-cli.js";
import { makeLog, makeSkillRoot, readCalls } from "../fixtures/vault-env.js";

async function boot(mode, extra = {}) {
	const skill = makeSkillRoot();
	const log = makeLog();
	const cli = createVaultCli({ skillRoot: skill.root, env: { ...process.env, FAKE_VAULT_MODE: mode, FAKE_VAULT_LOG: log.file, ...extra }, timeoutMs: 500 });
	const result = await loadVaultBoot({ cli, root: "/repo", repo: "github.com/a/b" });
	return { result, log, skill, cleanup: () => {
		fs.rmSync(skill.root, { recursive: true, force: true });
		fs.rmSync(log.dir, { recursive: true, force: true });
	} };
}

test("boot resolves, checks, pulls and boots, and caches the section text", async () => {
	const h = await boot("success");
	try {
		assert.equal(h.result.mode, "full");
		assert.match(h.result.text, /BOOT TEXT/);
		assert.match(h.result.text, /pulled/);
		const calls = readCalls(h.log.file).map((c) => c.argv[0]);
		assert.deepEqual(calls, ["resolve", "repo", "sync", "boot"]);
	} finally {
		h.cleanup();
	}
});

test("repo check exit 3 means mode none and skips sync and boot", async () => {
	const h = await boot("none");
	try {
		assert.equal(h.result.mode, "none");
		assert.match(h.result.text, /mode is none/);
		const calls = readCalls(h.log.file).map((c) => c.argv[0]);
		assert.deepEqual(calls, ["resolve", "repo"]);
	} finally {
		h.cleanup();
	}
});

test("a failed step is one plain line and does not throw", async () => {
	const h = await boot("fail", { FAKE_VAULT_FAIL: "sync pull" });
	try {
		assert.equal(h.result.mode, "full");
		assert.match(h.result.text, /vault sync pull: failed \(exit 1\)/);
		assert.match(h.result.text, /BOOT TEXT/);
	} finally {
		h.cleanup();
	}
});

test("a timeout is one plain line, never a rejection", async () => {
	const skill = makeSkillRoot();
	const log = makeLog();
	const cli = createVaultCli({ skillRoot: skill.root, env: { ...process.env, FAKE_VAULT_MODE: "timeout", FAKE_VAULT_LOG: log.file }, timeoutMs: 100 });
	try {
		const result = await loadVaultBoot({ cli, root: "/repo", timeoutMs: 100 });
		assert.match(result.text, /vault resolve: timed out/);
	} finally {
		fs.rmSync(skill.root, { recursive: true, force: true });
		fs.rmSync(log.dir, { recursive: true, force: true });
	}
});
