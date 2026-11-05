import { test } from "node:test";
import assert from "node:assert/strict";
import { describeGit, localSlug, parseLog, parseStatus, slugFromRemote } from "../plugins/harness-projects/git-parse.js";

test("parseStatus reads branch headers, dirt and untracked files", () => {
	const text = [
		"# branch.oid d035a392abc",
		"# branch.head main",
		"# branch.upstream origin/main",
		"# branch.ab +2 -1",
		"1 .M N... 100644 100644 100644 abc abc CLAUDE.md",
		"? .codex/",
		"? docs/new.md",
		"u UU N... 100644 100644 100644 abc abc conflict.txt",
		"2 R. N... 100644 100644 100644 abc abc R100 renamed.md\told.md",
	].join("\n");
	const status = parseStatus(text);
	assert.equal(status.branch, "main");
	assert.equal(status.upstream, "origin/main");
	assert.equal(status.ahead, 2);
	assert.equal(status.behind, 1);
	assert.equal(status.dirty, 2);
	assert.equal(status.renamed, 1);
	assert.equal(status.untracked, 2);
	assert.equal(status.unmerged, 1);
	assert.equal(status.detached, false);
	assert.equal(status.oid, "d035a392abc");
});

test("parseStatus handles a detached HEAD with no upstream", () => {
	const status = parseStatus("# branch.oid abc123\n# branch.head (detached)\n");
	assert.equal(status.branch, null);
	assert.equal(status.detached, true);
	assert.equal(status.upstream, null);
	assert.equal(status.ahead, 0);
});

test("parseLog keeps subjects that contain separators", () => {
	const text = [
		"abc123\x1fabc1234\x1ffix: a | pipe and\ttab\x1fPaul\x1f2 hours ago",
		"def456\x1fdef4567\x1fsecond commit\x1fAda\x1fyesterday",
	].join("\n");
	const commits = parseLog(text);
	assert.equal(commits.length, 2);
	assert.equal(commits[0].subject, "fix: a | pipe and\ttab");
	assert.equal(commits[0].author, "Paul");
	assert.equal(commits[1].short, "def4567");
});

test("slugFromRemote normalizes every git remote form", () => {
	const wants = "github.com/prlorence/pi-claude-dispatcher";
	assert.equal(slugFromRemote("git@github.com:prLorence/pi-claude-dispatcher.git"), wants);
	assert.equal(slugFromRemote("ssh://git@github.com:22/prLorence/pi-claude-dispatcher.git"), wants);
	assert.equal(slugFromRemote("https://github.com/prLorence/pi-claude-dispatcher.git"), wants);
	assert.equal(slugFromRemote("https://github.com/prLorence/pi-claude-dispatcher"), wants);
	assert.equal(slugFromRemote("git://gitlab.com/group/repo.git"), "gitlab.com/group/repo");
});

test("slugFromRemote refuses paths without a host", () => {
	assert.equal(slugFromRemote(""), undefined);
	assert.equal(slugFromRemote("/srv/git/repo.git"), undefined);
	assert.equal(slugFromRemote("file:///srv/git/repo.git"), undefined);
	assert.equal(slugFromRemote("git@github.com:onlyone.git"), undefined);
});

test("localSlug names a repository without a remote", () => {
	assert.equal(localSlug("/Users/paul/repos/My Repo/"), "local-my-repo");
	assert.equal(localSlug("/srv/git/agent-vault"), "local-agent-vault");
});

test("describeGit is one readable line", () => {
	const line = describeGit({
		branch: "main",
		upstream: "origin/main",
		ahead: 2,
		behind: 0,
		dirty: 3,
		untracked: 1,
		unmerged: 0,
		lastCommit: { short: "abc1234", subject: "Add the plugin", date: "2 hours ago" },
	});
	assert.match(line, /on main/);
	assert.match(line, /2 ahead/);
	assert.match(line, /3 changed/);
	assert.match(line, /last commit 2 hours ago: Add the plugin/);
	assert.match(describeGit({ error: "not a git repository" }), /not a git repository/);
});
