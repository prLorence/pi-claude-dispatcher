/** Run with: cd pi-plan-dispatch && node --test vault/url.test.ts (Node 24+) */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { normalizeRemote, repoSlugFromCwd } from "./url.ts";

const SLUG = "github.com/owner/name";

function makeDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", ["-C", cwd, ...args], {
		env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
		stdio: ["ignore", "pipe", "ignore"],
	});
}

function slugFrom(cwd: string, aliases?: Record<string, string>): string | undefined {
	const previous = process.env.GIT_CONFIG_GLOBAL;
	process.env.GIT_CONFIG_GLOBAL = "/dev/null";
	try {
		return repoSlugFromCwd(cwd, aliases);
	} finally {
		if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
		else process.env.GIT_CONFIG_GLOBAL = previous;
	}
}

test("every accepted form gives the same slug", () => {
	const forms = [
		"git@github.com:owner/name.git",
		"git@github.com:owner/name",
		"github.com:owner/name.git",
		"ssh://git@github.com/owner/name.git",
		"ssh://git@github.com:2222/owner/name.git",
		"https://github.com/owner/name.git",
		"http://github.com/owner/name.git",
		"git://github.com/owner/name.git",
		"https://github.com/owner/name.git/",
		"  git@github.com:owner/name.git  ",
	];
	for (const form of forms) {
		assert.equal(normalizeRemote(form), SLUG, form);
	}
});

test("lowercases the host and every path segment", () => {
	assert.equal(normalizeRemote("git@GitHub.COM:Owner/Name.GIT"), SLUG);
	assert.equal(normalizeRemote("HTTPS://GitHub.Com/Owner/Name"), SLUG);
	assert.equal(normalizeRemote("SSH://git@GitHub.Com:22/Owner/Name.git"), SLUG);
});

test("keeps a path longer than two segments", () => {
	assert.equal(normalizeRemote("git@github.com:group/sub/name.git"), "github.com/group/sub/name");
	assert.equal(normalizeRemote("https://github.com/Group/Sub/Name.git/"), "github.com/group/sub/name");
});

test("drops a user and a token from https remotes", () => {
	const user = "builder";
	const token = ["ghp", "Zx9", "notarealtoken"].join("_");
	const withToken = ["https://", user, ":", token, "@github.com/owner/name.git"].join("");
	assert.equal(normalizeRemote(withToken), SLUG);
	assert.ok(!normalizeRemote(withToken)?.includes(user));
	assert.ok(!normalizeRemote(withToken)?.includes(token));
	const withUser = ["https://", user, "@github.com/owner/name.git"].join("");
	assert.equal(normalizeRemote(withUser), SLUG);
	assert.ok(!normalizeRemote(withUser)?.includes(user));
});

test("maps a host alias and keeps an unmapped alias", () => {
	const aliases = { "github-work": "github.com" };
	assert.equal(normalizeRemote("git@github-work:owner/name.git", aliases), SLUG);
	assert.equal(normalizeRemote("ssh://git@github-work/owner/name.git", aliases), SLUG);
	assert.equal(normalizeRemote("git@github-work:owner/name.git"), "github-work/owner/name");
	assert.equal(normalizeRemote("git@other-work:owner/name.git", aliases), "other-work/owner/name");
});

test("rejects an empty remote, a file URL and a plain path", () => {
	const rejected = [
		"",
		"   ",
		"file:///tmp/repo",
		"File://github.com/owner/name",
		"/tmp/repo",
		"//host/owner/name",
		"./repo",
		"../repo",
		"~/repos/repo",
	];
	for (const remote of rejected) {
		assert.equal(normalizeRemote(remote), undefined, JSON.stringify(remote));
	}
});

test("rejects a remote without both an owner and a name", () => {
	const rejected = [
		"https://github.com",
		"https://github.com/",
		"https://github.com/owner",
		"https://github.com/owner/",
		"https://github.com/owner/.git",
		"git@github.com:",
		"git@github.com:owner",
		"git@github.com:owner/.git",
		"ssh://github.com/",
		"not-a-remote",
		"owner/name",
	];
	for (const remote of rejected) {
		assert.equal(normalizeRemote(remote), undefined, JSON.stringify(remote));
	}
});

test("repoSlugFromCwd reads origin from the toplevel, also from a subdirectory", () => {
	const dir = makeDir("vault-url-");
	try {
		git(dir, "init", "-b", "main");
		git(dir, "remote", "add", "origin", "git@github.com:Owner/Name.git");
		const sub = join(dir, "sub", "dir");
		mkdirSync(sub, { recursive: true });
		assert.equal(slugFrom(dir), SLUG);
		assert.equal(slugFrom(sub), SLUG);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("repoSlugFromCwd uses only origin and passes the aliases", () => {
	const dir = makeDir("vault-url-");
	try {
		git(dir, "init", "-b", "main");
		git(dir, "remote", "add", "upstream", "git@github.com:upstream/wrong.git");
		git(dir, "remote", "add", "origin", "git@github-work:owner/name.git");
		assert.equal(slugFrom(dir), "github-work/owner/name");
		assert.equal(slugFrom(dir, { "github-work": "github.com" }), SLUG);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("repoSlugFromCwd returns undefined with no origin", () => {
	const dir = makeDir("vault-url-");
	try {
		git(dir, "init", "-b", "main");
		assert.equal(slugFrom(dir), undefined);
		git(dir, "remote", "add", "upstream", "git@github.com:owner/name.git");
		assert.equal(slugFrom(dir), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("repoSlugFromCwd returns undefined when origin has no slug", () => {
	const dir = makeDir("vault-url-");
	try {
		git(dir, "init", "-b", "main");
		git(dir, "remote", "add", "origin", "file:///tmp/repo");
		assert.equal(slugFrom(dir), undefined);
		git(dir, "remote", "set-url", "origin", "/tmp/repo");
		assert.equal(slugFrom(dir), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("repoSlugFromCwd returns undefined outside a git repo", () => {
	const dir = makeDir("vault-url-");
	try {
		assert.equal(slugFrom(dir), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
