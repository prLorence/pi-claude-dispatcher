import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createVaultCli, failureLine, parseResolve, VaultRejected } from "../plugins/harness-vault/vault-cli.js";
import { makeLog, makeSkillRoot, readCalls } from "../fixtures/vault-env.js";

function cliFor(env = {}, timeoutMs = 20_000) {
	const skill = makeSkillRoot();
	const log = makeLog();
	return { cli: createVaultCli({ skillRoot: skill.root, timeoutMs, env: { ...process.env, FAKE_VAULT_LOG: log.file, ...env } }), log, skill };
}

test("spawns vault.mjs with an argument array and records the argv", async () => {
	const { cli, log, skill } = cliFor();
	try {
		const r = await cli.run(["repo", "check", "--root", "/repo"]);
		assert.equal(r.code, 0);
		assert.match(r.stdout, /mode full/);
		const calls = readCalls(log.file);
		assert.deepEqual(calls[0].argv, ["repo", "check", "--root", "/repo"]);
	} finally {
		fs.rmSync(skill.root, { recursive: true, force: true });
		fs.rmSync(log.dir, { recursive: true, force: true });
	}
});

test("a subcommand outside the allow-list is rejected without spawning", async () => {
	const { cli, log, skill } = cliFor();
	try {
		await assert.rejects(() => cli.run(["rm", "-rf", "/"]), VaultRejected);
		assert.equal(readCalls(log.file).length, 0);
	} finally {
		fs.rmSync(skill.root, { recursive: true, force: true });
		fs.rmSync(log.dir, { recursive: true, force: true });
	}
});

test("a timeout kills the child and is reported as timedOut", async () => {
	const { cli, skill } = cliFor({ FAKE_VAULT_MODE: "timeout" }, 100);
	try {
		const r = await cli.run(["boot"]);
		assert.equal(r.timedOut, true);
		assert.equal(r.code, null);
		assert.match(failureLine("boot", r), /timed out/);
	} finally {
		fs.rmSync(skill.root, { recursive: true, force: true });
	}
});

test("a failing step becomes one plain line", async () => {
	const { cli, skill } = cliFor({ FAKE_VAULT_MODE: "fail", FAKE_VAULT_FAIL: "sync pull" });
	try {
		const r = await cli.run(["sync", "pull"]);
		assert.equal(r.code, 1);
		const line = failureLine("sync pull", r);
		assert.equal(line.split("\n").length, 1);
		assert.match(line, /failed \(exit 1\)/);
		assert.match(line, /on purpose/);
	} finally {
		fs.rmSync(skill.root, { recursive: true, force: true });
	}
});

test("stdin is forwarded to the CLI", async () => {
	const { cli, log, skill } = cliFor();
	try {
		await cli.run(["note", "new", "run", "x-run", "--body-stdin"], { stdin: "hello\n" });
		assert.equal(readCalls(log.file)[0].stdin, "hello\n");
	} finally {
		fs.rmSync(skill.root, { recursive: true, force: true });
		fs.rmSync(log.dir, { recursive: true, force: true });
	}
});

test("parseResolve reads JSON and text forms", () => {
	assert.deepEqual(parseResolve('{"path":"/v","host":"h"}'), { path: "/v", host: "h" });
	assert.deepEqual(parseResolve("path: /v\nhost: h\n"), { path: "/v", host: "h" });
});
