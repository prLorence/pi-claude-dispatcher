import { test } from "node:test";
import assert from "node:assert/strict";
import { buildVaultArgs } from "../plugins/harness-vault/tools.js";

const root = "/repo";

test("vault_search builds a search command with optional flags", () => {
	assert.deepEqual(buildVaultArgs("vault_search", { query: "lock wait", all: true, limit: 5, trace: "T" }, root), [
		"search",
		"lock wait",
		"--all",
		"--limit",
		"5",
		"--trace",
		"T",
		"--root",
		root,
	]);
});

test("vault_note builds new/set/status/supersede with sets and stdin", () => {
	assert.deepEqual(buildVaultArgs("vault_note", { subcommand: "new", type: "plan", basename: "p", sets: ["status=draft", "trace=T"], body: "x" }, root), [
		"note",
		"new",
		"plan",
		"p",
		"--set",
		"status=draft",
		"--set",
		"trace=T",
		"--body-stdin",
		"--root",
		root,
	]);
	assert.deepEqual(buildVaultArgs("vault_note", { subcommand: "set", basename: "p", sets: ["status=done"] }, root).slice(0, 4), ["note", "set", "p", "--set"]);
	assert.deepEqual(buildVaultArgs("vault_note", { subcommand: "status", basename: "p", status: "open" }, root).slice(0, 4), ["note", "status", "p", "open"]);
	assert.deepEqual(buildVaultArgs("vault_note", { subcommand: "supersede", old: "a", new: "b" }, root).slice(0, 4), ["note", "supersede", "a", "b"]);
});

test("work, log, sync, restore and config build their argv", () => {
	assert.deepEqual(buildVaultArgs("vault_work", { action: "add", trace: "T", probes: true }, root), ["work", "add", "--trace", "T", "--probes", "--root", root]);
	assert.deepEqual(buildVaultArgs("vault_work", { action: "pending" }, root), ["work", "pending", "--root", root]);
	assert.deepEqual(buildVaultArgs("vault_log", { text: "hello", repo: "r", trace: "T" }, root), ["log", "append", "--repo", "r", "--trace", "T", "hello", "--root", root]);
	assert.deepEqual(buildVaultArgs("vault_sync", { action: "push" }, root), ["sync", "push", "--root", root]);
	assert.deepEqual(buildVaultArgs("vault_restore", {}, root), ["restore", "--root", root]);
	assert.deepEqual(buildVaultArgs("vault_config", { action: "pull", force: true }, root), ["config", "pull", "--force", "--root", root]);
});
