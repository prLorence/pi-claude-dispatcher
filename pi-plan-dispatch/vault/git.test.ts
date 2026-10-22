/** Run with: cd pi-plan-dispatch && node --test vault/git.test.ts (Node 24+) */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { lintVault, scanSecrets, syncPull, syncPush } from "./git.ts";

// syncPull and syncPush inherit process.env, so the identity and the isolated
// git config are set here, once, before any git call.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_AUTHOR_NAME = "Vault Test";
process.env.GIT_AUTHOR_EMAIL = "vault-test@example.com";
process.env.GIT_COMMITTER_NAME = "Vault Test";
process.env.GIT_COMMITTER_EMAIL = "vault-test@example.com";

const REPO = "github.com/owner/repo";
const NONE_REPO = "github.com/secret/none";
const TYPE_FOLDERS = ["plans", "runs", "findings", "decisions", "lessons", "projects", "codebases", "templates"];

function parts(...items: string[]): string {
	return items.join("");
}

function gitRun(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function gitHead(cwd: string): string {
	return gitRun(cwd, ["rev-parse", "HEAD"]).trim();
}

async function withTemp(fn: (root: string) => void | Promise<void>): Promise<void> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "vault-git-"));
	try {
		await fn(root);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

function writeRepos(vault: string, modes: Record<string, string>): void {
	const repos: Record<string, { mode: string }> = {};
	for (const slug of Object.keys(modes)) repos[slug] = { mode: modes[slug] };
	fs.writeFileSync(path.join(vault, "repos.json"), `${JSON.stringify({ repos, aliases: {} }, null, 2)}\n`);
}

function writeVault(vault: string, modes: Record<string, string> = { [REPO]: "full" }): void {
	for (const folder of TYPE_FOLDERS) {
		fs.mkdirSync(path.join(vault, folder), { recursive: true });
		if (folder !== "templates") fs.writeFileSync(path.join(vault, folder, ".gitkeep"), "");
	}
	fs.writeFileSync(path.join(vault, "CLAUDE.md"), "# Vault schema\n");
	fs.writeFileSync(path.join(vault, "README.md"), "# Vault\n");
	fs.writeFileSync(path.join(vault, "log.md"), "- base\n");
	fs.writeFileSync(
		path.join(vault, "harness.json"),
		`${JSON.stringify({ schema: 1, harness_repo: "https://example.com/harness.git", boot_budget_tokens: 4000, min_node: 24, sync_push: "auto" }, null, 2)}\n`,
	);
	fs.writeFileSync(path.join(vault, ".gitattributes"), "log.md merge=union\n");
	fs.writeFileSync(path.join(vault, ".gitignore"), "index.md\n.obsidian/workspace*\n");
	fs.writeFileSync(path.join(vault, "bootstrap.sh"), "#!/bin/sh\n");
	fs.writeFileSync(path.join(vault, "templates", "vault.base"), "views:\n");
	writeRepos(vault, modes);
}

function initVault(vault: string, modes?: Record<string, string>): void {
	fs.mkdirSync(vault, { recursive: true });
	gitRun(vault, ["init", "-b", "main"]);
	writeVault(vault, modes);
	gitRun(vault, ["add", "-A"]);
	gitRun(vault, ["commit", "-m", "init"]);
}

function makeRemote(root: string): string {
	const remote = path.join(root, "remote.git");
	fs.mkdirSync(remote, { recursive: true });
	gitRun(remote, ["init", "--bare", "-b", "main"]);
	return remote;
}

function publish(vault: string, remote: string): void {
	gitRun(vault, ["remote", "add", "origin", remote]);
	gitRun(vault, ["push", "-u", "origin", "HEAD"]);
}

function clone(root: string, remote: string, name: string): string {
	const dir = path.join(root, name);
	gitRun(root, ["clone", "-q", remote, name]);
	return dir;
}

function noteText(type: string, props: Record<string, string>, body = ""): string {
	const lines = ["---", `type: ${type}`, "created: 2026-01-01", "updated: 2026-01-02"];
	for (const key of Object.keys(props)) lines.push(`${key}: ${props[key]}`);
	lines.push("---", body);
	return `${lines.join("\n")}\n`;
}

function planProps(): Record<string, string> {
	return { trace: "trace-1", round: "1", repo: REPO, status: "done" };
}

function writeDecision(vault: string, basename: string, body = "A decision.\n", repo = REPO): void {
	fs.writeFileSync(path.join(vault, "decisions", `${basename}.md`), noteText("decision", { project: "demo", repo }, body));
}

function writePlan(vault: string, basename: string, body = "A plan.\n"): void {
	fs.writeFileSync(path.join(vault, "plans", `${basename}.md`), noteText("plan", planProps(), body));
}

function rebaseDirExists(vault: string): boolean {
	return (
		fs.existsSync(path.join(vault, ".git", "rebase-merge")) || fs.existsSync(path.join(vault, ".git", "rebase-apply"))
	);
}

function read(vault: string, file: string): string {
	return fs.readFileSync(path.join(vault, file), "utf8");
}

function secretText(): string {
	return parts("ghp_", "a".repeat(30));
}

test("scanSecrets names every secret pattern, in table order", () => {
	const cases: { name: string; text: string }[] = [
		{ name: "private-key", text: parts("-----BEGIN ", "OPENSSH ", "PRIVATE KEY-----") },
		{ name: "aws-access-key", text: parts("AKIA", "Q".repeat(16)) },
		{ name: "github-token", text: parts("ghp_", "a".repeat(24)) },
		{ name: "github-pat", text: parts("github_pat_", "b".repeat(24)) },
		{ name: "anthropic-key", text: parts("sk-ant-", "c".repeat(12)) },
		{ name: "api-key", text: parts("sk-", "d".repeat(24)) },
		{ name: "slack-token", text: parts("xoxb-", "1".repeat(12)) },
		{ name: "base64-near-secret", text: parts("token", " = \"", "Z".repeat(48), "\"") },
	];
	for (const item of cases) {
		assert.deepEqual(scanSecrets(`x ${item.text} y`), [item.name], item.name);
	}
	assert.deepEqual(scanSecrets("nothing to see here"), []);
	assert.deepEqual(scanSecrets(""), []);
});

test("scanSecrets reports matched names in table order", () => {
	const text = parts("AKIA", "Q".repeat(16), " ", "ghp_", "a".repeat(24));
	assert.deepEqual(scanSecrets(text), ["aws-access-key", "github-token"]);
});

test("scanSecrets ignores near misses", () => {
	assert.deepEqual(scanSecrets(parts("AKIA", "Q".repeat(15))), []);
	assert.deepEqual(scanSecrets(parts("sk-", "d".repeat(19))), []);
	assert.deepEqual(scanSecrets("-----BEGIN rsa private key-----"), []);
	assert.deepEqual(scanSecrets(parts("ghp_", "a".repeat(10))), []);
});

test("a clean vault gives no error findings", async () => {
	await withTemp((root) => {
		const vault = path.join(root, "vault");
		initVault(vault);
		writeDecision(vault, "decision-demo-one");
		const errors = lintVault(vault).filter((finding) => finding.severity === "error");
		assert.deepEqual(errors, []);
	});
});

test("lintVault reports a secret in a working-tree file", async () => {
	await withTemp((root) => {
		const vault = path.join(root, "vault");
		initVault(vault);
		writePlan(vault, "trace-1-r1", `Leaked ${secretText()}\n`);
		const secrets = lintVault(vault).filter((finding) => finding.code === "secret");
		assert.equal(secrets.length, 1);
		assert.equal(secrets[0].severity, "error");
		assert.equal(secrets[0].file, "plans/trace-1-r1.md");
		assert.match(secrets[0].message, /github-token/);
	});
});

test("lintVault skips .git and index.md in the secret scan", async () => {
	await withTemp((root) => {
		const vault = path.join(root, "vault");
		initVault(vault);
		fs.writeFileSync(path.join(vault, "index.md"), `generated ${secretText()}\n`);
		fs.writeFileSync(path.join(vault, ".git", "leaked-object"), `committed ${secretText()}\n`);
		const secrets = lintVault(vault).filter((finding) => finding.code === "secret");
		assert.deepEqual(secrets, []);
	});
});

test("lintVault reports a note that parseNote throws on", async () => {
	await withTemp((root) => {
		const vault = path.join(root, "vault");
		initVault(vault);
		fs.writeFileSync(path.join(vault, "plans", "broken.md"), "no frontmatter here\n");
		const parse = lintVault(vault).filter((finding) => finding.code === "parse");
		assert.equal(parse.length, 1);
		assert.equal(parse[0].severity, "error");
		assert.equal(parse[0].file, "plans/broken.md");
	});
});

test("lintVault reports schema violations and a type that does not match the folder", async () => {
	await withTemp((root) => {
		const vault = path.join(root, "vault");
		initVault(vault);
		const props = planProps();
		delete props.status;
		fs.writeFileSync(path.join(vault, "plans", "trace-1-r2.md"), noteText("plan", props));
		fs.writeFileSync(
			path.join(vault, "plans", "wrong-run.md"),
			noteText("run", { trace: "trace-1", repo: REPO, status: "done", gate: "pass" }),
		);
		const schema = lintVault(vault).filter((finding) => finding.code === "schema");
		assert.equal(schema.length, 2);
		const forMissing = schema.find((finding) => finding.file === "plans/trace-1-r2.md");
		assert.ok(forMissing !== undefined);
		assert.match(forMissing.message, /missing required property: status/);
		const forWrong = schema.find((finding) => finding.file === "plans/wrong-run.md");
		assert.ok(forWrong !== undefined);
		assert.match(forWrong.message, /does not match its folder plans/);
	});
});

test("lintVault reports a repo that the allowlist does not permit", async () => {
	await withTemp((root) => {
		const vault = path.join(root, "vault");
		initVault(vault);
		writeDecision(vault, "decision-demo-two", "A decision.\n", "github.com/other/repo");
		const denied = lintVault(vault).filter((finding) => finding.code === "repo-not-allowed");
		assert.equal(denied.length, 1);
		assert.equal(denied[0].file, "decisions/decision-demo-two.md");
		assert.match(denied[0].message, /github.com\/other\/repo is not allowed/);
	});
});

test("lintVault passes tracked files to checkNote for meta repos", async () => {
	await withTemp((root) => {
		const vault = path.join(root, "vault");
		initVault(vault, { [REPO]: "meta" });
		writeDecision(vault, "decision-demo-three", "It touches src/index.ts.\n");
		const plain = lintVault(vault).filter((finding) => finding.code === "repo-not-allowed");
		assert.deepEqual(plain, []);
		const seen: string[] = [];
		const findings = lintVault(vault, {
			trackedFiles: (repo) => {
				seen.push(repo);
				return new Set(["src/index.ts"]);
			},
		}).filter((finding) => finding.code === "repo-not-allowed");
		assert.deepEqual(seen, [REPO]);
		assert.equal(findings.length, 1);
		assert.match(findings[0].message, /must not name a tracked file: src\/index\.ts/);
	});
});

test("lintVault reports an absolute path in a note body", async () => {
	await withTemp((root) => {
		const vault = path.join(root, "vault");
		initVault(vault);
		writeDecision(vault, "decision-demo-four", "Stored in /Users/someone/notes today.\n");
		const absolute = lintVault(vault).filter((finding) => finding.code === "absolute-path");
		assert.equal(absolute.length, 1);
		assert.equal(absolute[0].severity, "error");
		assert.equal(absolute[0].file, "decisions/decision-demo-four.md");
		assert.match(absolute[0].message, /\/Users\/someone\/notes/);
	});
});

test("lintVault reports a home path and a drive path, and nothing for a relative path", async () => {
	await withTemp((root) => {
		const vault = path.join(root, "vault");
		initVault(vault);
		writeDecision(vault, "decision-demo-five", "Open ~/notes/vault.md\n");
		writeDecision(vault, "decision-demo-six", "Open C:\\Users\\me\\notes.md\n");
		writeDecision(vault, "decision-demo-seven", "Open notes/vault.md\n");
		const absolute = lintVault(vault).filter((finding) => finding.code === "absolute-path");
		assert.deepEqual(
			absolute.map((finding) => finding.file),
			["decisions/decision-demo-five.md", "decisions/decision-demo-six.md"],
		);
	});
});

test("lintVault reports a none-repo slug in log.md", async () => {
	await withTemp((root) => {
		const vault = path.join(root, "vault");
		initVault(vault, { [REPO]: "full", [NONE_REPO]: "none" });
		fs.writeFileSync(
			path.join(vault, "log.md"),
			`- base\n- 2026-01-02T10:00:00Z [host] ${NONE_REPO} - talked about it\n`,
		);
		const leaks = lintVault(vault).filter((finding) => finding.code === "none-slug-in-log");
		assert.equal(leaks.length, 1);
		assert.equal(leaks[0].severity, "error");
		assert.equal(leaks[0].file, "log.md");
		assert.match(leaks[0].message, /secret\/none/);
	});
});

test("lintVault reports dangling links and orphans as info", async () => {
	await withTemp((root) => {
		const vault = path.join(root, "vault");
		initVault(vault);
		writeDecision(vault, "decision-demo-eight", "See [[decision-demo-nine]] and [[nothing]]\n");
		writeDecision(vault, "decision-demo-nine", "A second decision.\n");
		const findings = lintVault(vault);
		const dangling = findings.filter((finding) => finding.code === "dangling-link");
		assert.equal(dangling.length, 1);
		assert.equal(dangling[0].severity, "info");
		assert.equal(dangling[0].file, "decisions/decision-demo-eight.md");
		assert.match(dangling[0].message, /nothing/);
		const orphans = findings.filter((finding) => finding.code === "orphan");
		assert.deepEqual(orphans.map((finding) => finding.file), ["decisions/decision-demo-eight.md"]);
		assert.equal(orphans[0].severity, "info");
	});
});

test("lintVault with range scans the unpushed commits", async () => {
	await withTemp((root) => {
		const remote = makeRemote(root);
		const vault = path.join(root, "vault");
		initVault(vault);
		publish(vault, remote);
		fs.writeFileSync(path.join(vault, "leak.txt"), `${parts("AKIA", "F".repeat(16))}\n`);
		gitRun(vault, ["add", "-A"]);
		gitRun(vault, ["commit", "-m", "leaky"]);
		fs.rmSync(path.join(vault, "leak.txt"));
		assert.deepEqual(lintVault(vault).filter((finding) => finding.code === "secret"), []);
		const secrets = lintVault(vault, { range: true }).filter((finding) => finding.code === "secret");
		assert.equal(secrets.length, 1);
		assert.equal(secrets[0].severity, "error");
		assert.equal(secrets[0].file, undefined);
		assert.match(secrets[0].message, /aws-access-key/);
	});
});

test("lintVault with range scans the whole history when origin has no branch yet", async () => {
	await withTemp((root) => {
		const remote = makeRemote(root);
		const vault = path.join(root, "vault");
		initVault(vault);
		gitRun(vault, ["remote", "add", "origin", remote]);
		fs.writeFileSync(path.join(vault, "leak.txt"), `${parts("sk-", "g".repeat(24))}\n`);
		gitRun(vault, ["add", "-A"]);
		gitRun(vault, ["commit", "-m", "leaky"]);
		fs.rmSync(path.join(vault, "leak.txt"));
		const secrets = lintVault(vault, { range: true }).filter((finding) => finding.code === "secret");
		assert.equal(secrets.length, 1);
		assert.match(secrets[0].message, /api-key/);
	});
});

test("syncPull without a remote is code 1", async () => {
	await withTemp((root) => {
		const vault = path.join(root, "vault");
		initVault(vault);
		const result = syncPull(vault);
		assert.equal(result.code, 1);
		assert.equal(result.message, "no remote configured");
		assert.deepEqual(result.unmanaged, []);
	});
});

test("syncPull on an empty remote reports nothing to pull yet", async () => {
	await withTemp((root) => {
		const remote = makeRemote(root);
		const vault = path.join(root, "vault");
		initVault(vault);
		gitRun(vault, ["remote", "add", "origin", remote]);
		const result = syncPull(vault);
		assert.equal(result.code, 0);
		assert.equal(result.message, "nothing to pull yet");
	});
});

test("syncPush without a remote keeps the commit and returns code 1", async () => {
	await withTemp((root) => {
		const vault = path.join(root, "vault");
		initVault(vault);
		writeDecision(vault, "decision-demo-ten");
		const result = syncPush(vault, { summary: "local only" });
		assert.equal(result.code, 1);
		assert.equal(result.message, "no remote configured");
		assert.equal(gitRun(vault, ["log", "-1", "--format=%s"]).trim(), "vault: local only");
	});
});

test("syncPush makes the first commit and pushes it to an empty remote", async () => {
	await withTemp((root) => {
		const remote = makeRemote(root);
		const vault = path.join(root, "vault");
		initVault(vault);
		gitRun(vault, ["remote", "add", "origin", remote]);
		writeDecision(vault, "decision-demo-eleven");
		const result = syncPush(vault, { summary: "first", trace: "trace-7" });
		assert.equal(result.code, 0);
		assert.deepEqual(result.unmanaged, []);
		assert.equal(gitRun(vault, ["log", "-1", "--format=%s"]).trim(), "vault: first [trace trace-7]");
		assert.notEqual(gitRun(remote, ["rev-parse", "--verify", "refs/heads/main"]).trim(), "");
		assert.equal(gitRun(vault, ["rev-parse", "--abbrev-ref", "main@{upstream}"]).trim(), "origin/main");
	});
});

test("syncPush stages managed files and reports unmanaged ones", async () => {
	await withTemp((root) => {
		const remote = makeRemote(root);
		const vault = path.join(root, "vault");
		initVault(vault);
		publish(vault, remote);
		writePlan(vault, "trace-1-r1");
		fs.writeFileSync(path.join(vault, "templates", "new.base"), "views:\n");
		fs.writeFileSync(path.join(vault, "notes.txt"), "scratch\n");
		fs.writeFileSync(path.join(vault, "plans", "stray.txt"), "scratch\n");
		const result = syncPush(vault, { summary: "mixed" });
		assert.equal(result.code, 0);
		assert.deepEqual(result.unmanaged.sort(), ["notes.txt", "plans/stray.txt"]);
		const pushed = gitRun(remote, ["ls-tree", "--name-only", "-r", "refs/heads/main"]).split("\n");
		assert.ok(pushed.includes("plans/trace-1-r1.md"));
		assert.ok(pushed.includes("templates/new.base"));
		assert.ok(!pushed.includes("notes.txt"));
		assert.ok(!pushed.includes("plans/stray.txt"));
		const status = gitRun(vault, ["status", "--porcelain"]);
		assert.match(status, /\?\? notes\.txt/);
		assert.match(status, /\?\? plans\/stray\.txt/);
	});
});

test("syncPush stages a .gitkeep file in a type folder", async () => {
	await withTemp((root) => {
		const remote = makeRemote(root);
		const vault = path.join(root, "vault");
		initVault(vault);
		publish(vault, remote);
		fs.writeFileSync(path.join(vault, "plans", ".gitkeep"), "\n");
		const result = syncPush(vault, { summary: "keep" });
		assert.equal(result.code, 0);
		assert.deepEqual(result.unmanaged, []);
		assert.equal(gitRun(vault, ["show", "--name-only", "--format=", "HEAD"]).trim(), "plans/.gitkeep");
	});
});

test("syncPush with nothing to commit still succeeds", async () => {
	await withTemp((root) => {
		const remote = makeRemote(root);
		const vault = path.join(root, "vault");
		initVault(vault);
		publish(vault, remote);
		const before = gitHead(vault);
		const result = syncPush(vault);
		assert.equal(result.code, 0);
		assert.equal(gitHead(vault), before);
	});
});

test("syncPush is blocked by a lint error and commits nothing", async () => {
	await withTemp((root) => {
		const remote = makeRemote(root);
		const vault = path.join(root, "vault");
		initVault(vault);
		publish(vault, remote);
		const before = gitHead(vault);
		writePlan(vault, "trace-1-r1", `Leaked ${secretText()}\n`);
		const result = syncPush(vault, { summary: "should not land" });
		assert.equal(result.code, 1);
		assert.match(result.message, /^lint failed: /);
		assert.match(result.message, /secret \(plans\/trace-1-r1\.md\)/);
		assert.equal(gitHead(vault), before);
		assert.equal(gitRun(vault, ["diff", "--cached", "--name-only"]).trim(), "");
		assert.match(gitRun(vault, ["status", "--porcelain"]), /\?\? plans\/trace-1-r1\.md/);
	});
});

test("two clones appending log.md lines merge on pull", async () => {
	await withTemp((root) => {
		const remote = makeRemote(root);
		const a = path.join(root, "a");
		initVault(a);
		publish(a, remote);
		const b = clone(root, remote, "b");
		fs.appendFileSync(path.join(b, "log.md"), "- from-b\n");
		gitRun(b, ["add", "-A"]);
		gitRun(b, ["commit", "-m", "b log"]);
		gitRun(b, ["push"]);
		fs.appendFileSync(path.join(a, "log.md"), "- from-a\n");
		gitRun(a, ["add", "-A"]);
		gitRun(a, ["commit", "-m", "a log"]);
		const result = syncPull(a);
		assert.equal(result.code, 0);
		const log = read(a, "log.md");
		assert.match(log, /- from-a/);
		assert.match(log, /- from-b/);
		assert.ok(!log.includes("<<<<<<<"));
		assert.ok(fs.existsSync(path.join(a, "index.md")));
	});
});

test("a same-line pull conflict aborts the rebase and keeps the local commit", async () => {
	await withTemp((root) => {
		const remote = makeRemote(root);
		const a = path.join(root, "a");
		initVault(a);
		publish(a, remote);
		const b = clone(root, remote, "b");
		fs.writeFileSync(path.join(b, "CLAUDE.md"), "# remote schema\n");
		gitRun(b, ["add", "-A"]);
		gitRun(b, ["commit", "-m", "remote line"]);
		gitRun(b, ["push"]);
		fs.writeFileSync(path.join(a, "CLAUDE.md"), "# local schema\n");
		gitRun(a, ["add", "-A"]);
		gitRun(a, ["commit", "-m", "local line"]);
		const local = gitHead(a);
		const result = syncPull(a);
		assert.equal(result.code, 5);
		assert.match(result.message, /rebase aborted/);
		assert.equal(rebaseDirExists(a), false);
		assert.equal(gitHead(a), local);
		assert.equal(gitRun(a, ["log", "-1", "--format=%s"]).trim(), "local line");
		assert.equal(read(a, "CLAUDE.md"), "# local schema\n");
		assert.ok(!read(a, "CLAUDE.md").includes("<<<<<<<"));
		assert.equal(gitRun(a, ["stash", "list"]).trim(), "");
	});
});

test("a dirty edit against a remote change to the same line is restored", async () => {
	await withTemp((root) => {
		const remote = makeRemote(root);
		const a = path.join(root, "a");
		initVault(a);
		publish(a, remote);
		const b = clone(root, remote, "b");
		fs.writeFileSync(path.join(b, "CLAUDE.md"), "# remote schema\n");
		gitRun(b, ["add", "-A"]);
		gitRun(b, ["commit", "-m", "remote line"]);
		gitRun(b, ["push"]);
		fs.writeFileSync(path.join(a, "CLAUDE.md"), "# dirty schema\n");
		const before = gitHead(a);
		const result = syncPull(a);
		assert.equal(result.code, 5);
		assert.match(result.message, /local changes restored/);
		assert.equal(read(a, "CLAUDE.md"), "# dirty schema\n");
		assert.equal(gitRun(a, ["stash", "list"]).trim(), "");
		assert.equal(gitHead(a), before);
		assert.equal(rebaseDirExists(a), false);
	});
});

test("a push-side pull conflict keeps the local commit", async () => {
	await withTemp((root) => {
		const remote = makeRemote(root);
		const a = path.join(root, "a");
		initVault(a);
		publish(a, remote);
		const b = clone(root, remote, "b");
		fs.writeFileSync(path.join(b, "CLAUDE.md"), "# remote schema\n");
		gitRun(b, ["add", "-A"]);
		gitRun(b, ["commit", "-m", "remote line"]);
		gitRun(b, ["push"]);
		fs.writeFileSync(path.join(a, "CLAUDE.md"), "# local schema\n");
		gitRun(a, ["add", "-A"]);
		gitRun(a, ["commit", "-m", "local line"]);
		const local = gitHead(a);
		const result = syncPush(a, { summary: "conflicting" });
		assert.equal(result.code, 5);
		assert.equal(gitHead(a), local);
		assert.equal(gitRun(a, ["log", "-1", "--format=%s"]).trim(), "local line");
		assert.equal(read(a, "CLAUDE.md"), "# local schema\n");
		assert.equal(rebaseDirExists(a), false);
	});
});

function rejectOnceHook(remote: string): void {
	fs.writeFileSync(
		path.join(remote, "hooks", "pre-receive"),
		[
			"#!/bin/sh",
			'MARKER="$(git rev-parse --git-dir)/rejected-once"',
			'if [ ! -f "$MARKER" ]; then',
			'  touch "$MARKER"',
			'  echo "first push rejected" >&2',
			"  exit 1",
			"fi",
			"exit 0",
			"",
		].join("\n"),
	);
	fs.chmodSync(path.join(remote, "hooks", "pre-receive"), 0o755);
}

test("a rejected push is retried once after another pull", async () => {
	await withTemp((root) => {
		const remote = makeRemote(root);
		rejectOnceHook(remote);
		const vault = path.join(root, "vault");
		initVault(vault);
		gitRun(vault, ["remote", "add", "origin", remote]);
		writeDecision(vault, "decision-demo-twelve");
		const result = syncPush(vault, { summary: "retried" });
		assert.equal(result.code, 0);
		assert.equal(gitRun(vault, ["log", "-1", "--format=%s"]).trim(), "vault: retried");
		assert.notEqual(gitRun(remote, ["rev-parse", "--verify", "refs/heads/main"]).trim(), "");
	});
});

test("a push that stays rejected returns code 5 and keeps the commit", async () => {
	await withTemp((root) => {
		const remote = makeRemote(root);
		fs.writeFileSync(
			path.join(remote, "hooks", "pre-receive"),
			["#!/bin/sh", 'echo "always rejected" >&2', "exit 1", ""].join("\n"),
		);
		fs.chmodSync(path.join(remote, "hooks", "pre-receive"), 0o755);
		const vault = path.join(root, "vault");
		initVault(vault);
		gitRun(vault, ["remote", "add", "origin", remote]);
		writeDecision(vault, "decision-demo-thirteen");
		const result = syncPush(vault, { summary: "rejected" });
		assert.equal(result.code, 5);
		assert.equal(result.message, "push rejected (non-fast-forward)");
		assert.equal(gitRun(vault, ["log", "-1", "--format=%s"]).trim(), "vault: rejected");
	});
});
