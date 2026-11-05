import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { findingBasename, readSyncPush, recordRun } from "../plugins/harness-vault/record.js";
import { createVaultCli } from "../plugins/harness-vault/vault-cli.js";
import { makeLog, makeSkillRoot, readCalls } from "../fixtures/vault-env.js";

function env(syncPush = "auto", mode = "success") {
	const skill = makeSkillRoot();
	const log = makeLog();
	const vault = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "dsh-vault-home-"));
	fs.writeFileSync(path.join(vault, "harness.json"), JSON.stringify({ sync_push: syncPush }));
	const cli = createVaultCli({ skillRoot: skill.root, env: { ...process.env, FAKE_VAULT_MODE: mode, FAKE_VAULT_LOG: log.file, FAKE_VAULT_PATH: vault } });
	return {
		cli,
		log,
		vault,
		skill,
		cleanup: () => {
			fs.rmSync(skill.root, { recursive: true, force: true });
			fs.rmSync(log.dir, { recursive: true, force: true });
			fs.rmSync(vault, { recursive: true, force: true });
		},
	};
}

const finding = { fingerprint: "github.com/a/b:a.ts:bug", severity: "warn", source: "gate", title: "Bug", file: "a.ts", text: "body" };

test("finding basenames use the first 8 hex of the fingerprint sha1", () => {
	assert.equal(findingBasename("t1", "x"), findingBasename("t1", "x"));
	assert.match(findingBasename("t1", "x"), /^t1-f-[0-9a-f]{8}$/);
	assert.notEqual(findingBasename("t1", "x"), findingBasename("t1", "y"));
});

test("records in the fixed order and pushes when auto", async () => {
	const h = env("auto");
	const order = [];
	try {
		const result = await recordRun({
			cli: h.cli,
			args: { trace: "T", root: "/repo", repo: "github.com/a/b", plan: "T-r1", spec: "T", gate: "pass", vault: h.vault, findings: [finding] },
			runReport: async (trace) => {
				order.push(`report:${trace}`);
				return { code: 0 };
			},
		});
		const commands = readCalls(h.log.file).map((c) => c.argv.slice(0, 2).join(" "));
		assert.deepEqual(commands, [
			"note new",
			"note new",
			"work add",
			"note set",
			"note set",
			"log append",
			"sync push",
		]);
		const first = readCalls(h.log.file)[0];
		assert.equal(first.argv[2], "run");
		assert.ok(first.argv.includes("trace=T"));
		assert.ok(first.argv.includes("gate=pass"));
		assert.match(first.stdin, /gate pass/);
		const second = readCalls(h.log.file)[1];
		assert.equal(second.argv[2], "finding");
		assert.match(second.argv[3], /^t-f-[0-9a-f]{8}$/);
		assert.equal(result.pushed, true);
		assert.deepEqual(order, ["report:T"]);
	} finally {
		h.cleanup();
	}
});

test("does not push when sync_push is manual", async () => {
	const h = env("manual");
	try {
		const result = await recordRun({ cli: h.cli, args: { trace: "T", root: "/repo", repo: "-", plan: "T-r1", gate: "fail", vault: h.vault } });
		const commands = readCalls(h.log.file).map((c) => c.argv.slice(0, 2).join(" "));
		assert.equal(commands.includes("sync push"), false);
		assert.equal(result.pushed, false);
		assert.equal(result.status, "failed");
	} finally {
		h.cleanup();
	}
});

test("work add exit 6 is reported, not retried", async () => {
	const h = env("manual", "exit6");
	try {
		const result = await recordRun({ cli: h.cli, args: { trace: "T", root: "/repo", repo: "-", plan: "T-r1", gate: "pass", vault: h.vault } });
		const work = result.steps.find((s) => s.label === "work add");
		assert.equal(work.code, 6);
	} finally {
		h.cleanup();
	}
});

test("readSyncPush defaults to manual for a missing or unreadable harness.json", () => {
	assert.equal(readSyncPush("/no/such/vault"), "manual");
});
