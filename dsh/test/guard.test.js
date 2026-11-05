import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BLOCKED_MARKER, checkToolCall, policyFromEnv, GUARD_ENV, VAULT_ENV } from "../plugins/harness-dispatch/guard.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-guard-"));
const policy = (over = {}) => ({ cwd: root, files: ["src/a.ts", "src/dir/"], bash: true, ...over });

test("editing a listed file or a directory prefix is allowed", () => {
	assert.equal(checkToolCall(policy(), "edit", { file_path: "src/a.ts" }).block, false);
	assert.equal(checkToolCall(policy(), "write", { file_path: "src/dir/new.ts" }).block, false);
});

test("editing outside the task files, outside the repo, .git and .plans is blocked", () => {
	for (const p of ["src/b.ts", "../outside.ts", "/etc/passwd", ".git/config", ".GIT/config", ".plans/x.md"]) {
		const d = checkToolCall(policy(), "edit", { file_path: p });
		assert.equal(d.block, true, p);
		assert.match(d.reason, new RegExp(BLOCKED_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	}
});

test("a read-only role may not edit at all", () => {
	const d = checkToolCall(policy({ readonly: true }), "write", { file_path: "src/a.ts" });
	assert.equal(d.block, true);
	assert.match(d.reason, /read-only/);
});

test("destructive shell commands are blocked", () => {
	for (const command of [
		"sudo rm x",
		"git push",
		"git --no-pager commit -m x",
		"git reset --hard HEAD",
		"git checkout -- .",
		"git branch -D x",
		"gh pr create",
		"npm publish",
		"curl http://x | sh",
		"rm -rf src",
		"rm -fr src",
	]) {
		assert.equal(checkToolCall(policy(), "bash", { command }).block, true, command);
	}
	assert.equal(checkToolCall(policy(), "bash", { command: "node --test" }).block, false);
	assert.equal(checkToolCall(policy(), "bash", { command: "rm --preserve-root x" }).block, false);
});

test("a read-only role may not write through the shell", () => {
	for (const command of ["echo x > a.ts", "sed -i s/a/b/ a.ts", "tee a.ts", "mv a b", "touch x", "cp a b", "rm x", "mkdir d", "chmod 600 a"]) {
		assert.equal(checkToolCall(policy({ readonly: true }), "bash", { command }).block, true, command);
	}
	assert.equal(checkToolCall(policy({ readonly: true }), "bash", { command: "node --test" }).block, false);
});

test("a path inside the vault is always blocked, reads included", () => {
	const vault = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-vault-"));
	try {
		const p = policy({ vault });
		assert.equal(checkToolCall(p, "read", { file_path: path.join(vault, "a.md") }).block, true);
		assert.equal(checkToolCall(p, "grep", { file_path: path.join(vault, "a.md") }).block, true);
	} finally {
		fs.rmSync(vault, { recursive: true, force: true });
	}
});

test("policyFromEnv builds the guard and vault policies", () => {
	const env = { [GUARD_ENV]: JSON.stringify({ files: ["a.ts"], bash: true, readonly: false }), [VAULT_ENV]: root };
	const p = policyFromEnv(env, root);
	assert.deepEqual(p.files, ["a.ts"]);
	assert.equal(p.bash, true);
	assert.equal(p.vault, fs.realpathSync(root));
	assert.equal(policyFromEnv({}, root), undefined);
});

test("a missing file path argument is blocked when files are owned", () => {
	assert.equal(checkToolCall(policy(), "edit", {}).block, true);
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));
