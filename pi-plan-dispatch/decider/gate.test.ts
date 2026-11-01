/** Run with: cd pi-plan-dispatch && node --test decider/gate.test.ts (Node 24+) */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { mayDecide, repoMode } from "./gate.ts";

const FULL = "github.com/owner/full";
const META = "github.com/owner/meta";
const NONE = "github.com/secret/none";
const OTHER = "github.com/owner/other";

function reposJson(): string {
	return JSON.stringify({
		repos: {
			[FULL]: { mode: "full" },
			[META]: { mode: "meta" },
			[NONE]: { mode: "none" },
		},
		aliases: {},
	});
}

function makeVault(repos?: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-vault-"));
	if (repos !== undefined) fs.writeFileSync(path.join(dir, "repos.json"), repos, "utf8");
	return dir;
}

function makeHome(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "gate-home-"));
}

function makeRepo(remote?: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-repo-"));
	execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
	if (remote !== undefined) {
		execFileSync("git", ["-C", dir, "remote", "add", "origin", remote], { stdio: "ignore" });
	}
	return dir;
}

function cleanup(...dirs: string[]): void {
	for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
}

function envFor(vault?: string): NodeJS.ProcessEnv {
	return vault === undefined ? {} : { AGENT_VAULT: vault };
}

test("a full repo gives full and may decide", () => {
	const repo = makeRepo("git@github.com:owner/full.git");
	const vault = makeVault(reposJson());
	const home = makeHome();
	try {
		assert.equal(repoMode(repo, envFor(vault), home), "full");
		assert.equal(mayDecide(repo, envFor(vault), home), true);
	} finally {
		cleanup(repo, vault, home);
	}
});

test("a meta repo gives meta and may not decide", () => {
	const repo = makeRepo("git@github.com:owner/meta.git");
	const vault = makeVault(reposJson());
	const home = makeHome();
	try {
		assert.equal(repoMode(repo, envFor(vault), home), "meta");
		assert.equal(mayDecide(repo, envFor(vault), home), false);
	} finally {
		cleanup(repo, vault, home);
	}
});

test("a none repo gives none and may not decide", () => {
	const repo = makeRepo("git@github.com:secret/none.git");
	const vault = makeVault(reposJson());
	const home = makeHome();
	try {
		assert.equal(repoMode(repo, envFor(vault), home), "none");
		assert.equal(mayDecide(repo, envFor(vault), home), false);
	} finally {
		cleanup(repo, vault, home);
	}
});

test("an unlisted repo gives none", () => {
	const repo = makeRepo("git@github.com:owner/other.git");
	const vault = makeVault(reposJson());
	const home = makeHome();
	try {
		assert.equal(repoMode(repo, envFor(vault), home), "none");
		assert.equal(mayDecide(repo, envFor(vault), home), false);
	} finally {
		cleanup(repo, vault, home);
	}
});

test("a repo with no remote gives none", () => {
	const repo = makeRepo();
	const vault = makeVault(reposJson());
	const home = makeHome();
	try {
		assert.equal(repoMode(repo, envFor(vault), home), "none");
		assert.equal(mayDecide(repo, envFor(vault), home), false);
	} finally {
		cleanup(repo, vault, home);
	}
});

test("a broken repos.json gives unknown", () => {
	const repo = makeRepo("git@github.com:owner/full.git");
	const vault = makeVault("{ not json");
	const home = makeHome();
	try {
		assert.equal(repoMode(repo, envFor(vault), home), "unknown");
		assert.equal(mayDecide(repo, envFor(vault), home), false);
	} finally {
		cleanup(repo, vault, home);
	}
});

test("a missing repos.json gives unknown", () => {
	const repo = makeRepo("git@github.com:owner/full.git");
	const vault = makeVault();
	const home = makeHome();
	try {
		assert.equal(repoMode(repo, envFor(vault), home), "unknown");
	} finally {
		cleanup(repo, vault, home);
	}
});

test("no vault gives unknown", () => {
	const repo = makeRepo("git@github.com:owner/full.git");
	const home = makeHome();
	try {
		assert.equal(repoMode(repo, envFor(), home), "unknown");
		assert.equal(mayDecide(repo, envFor(), home), false);
	} finally {
		cleanup(repo, home);
	}
});

test("AGENT_VAULT pointing at a missing folder gives unknown, even when the home config says full", () => {
	const repo = makeRepo("git@github.com:owner/full.git");
	const configured = makeVault(reposJson());
	const home = makeHome();
	const configDir = path.join(home, ".config", "agent-vault");
	fs.mkdirSync(configDir, { recursive: true });
	fs.writeFileSync(
		path.join(configDir, "config.json"),
		JSON.stringify({ path: configured, host: "gate-test", remote: "github.com/owner/vault.git" }),
		"utf8",
	);
	const missing = path.join(home, "missing-vault");
	try {
		assert.equal(fs.existsSync(missing), false);
		assert.equal(repoMode(repo, envFor(missing), home), "unknown");
		assert.equal(mayDecide(repo, envFor(missing), home), false);
	} finally {
		cleanup(repo, configured, home);
	}
});
