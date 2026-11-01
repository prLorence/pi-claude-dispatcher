/** Run with: cd pi-plan-dispatch && node --test decider/dispatch.test.ts (Node 24+) */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { BackendError, fakeBackend, type BackendResult } from "./backend.ts";
import { DECIDER_DEFAULTS, type DeciderConfig } from "./config.ts";
import { decideTaskLevel } from "./dispatch.ts";

const FULL = "github.com/owner/full";
const META = "github.com/owner/meta";
const NONE = "github.com/secret/none";
const KEY = `sk-or-v1-${"1".repeat(64)}`;

const task = { id: "t1", body: "Write the thing", files: ["a.ts"], role: "implement" };

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
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-vault-"));
	if (repos !== undefined) fs.writeFileSync(path.join(dir, "repos.json"), repos, "utf8");
	return dir;
}

function makeHome(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-home-"));
}

function makeRepo(remote?: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-repo-"));
	execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
	if (remote !== undefined) {
		execFileSync("git", ["-C", dir, "remote", "add", "origin", remote], { stdio: "ignore" });
	}
	return dir;
}

function cleanup(...dirs: string[]): void {
	for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
}

/** No key and no vault config: the test never falls back to the real machine. */
function envFor(vault?: string): NodeJS.ProcessEnv {
	return vault === undefined ? {} : { AGENT_VAULT: vault };
}

function cfg(over: Partial<DeciderConfig> = {}): DeciderConfig {
	return { ...DECIDER_DEFAULTS, thresholds: { ...DECIDER_DEFAULTS.thresholds }, ...over };
}

/** P(max) 0.1 and complexity 3.5: the effort rule picks high. */
function answer(): BackendResult {
	return {
		answers: {
			effort: { type: "choice", choice: "high", probabilities: { low: 0.1, high: 0.8, max: 0.1 }, confidence: 0.9 },
			complexity: { type: "score", score: 3.5 },
		},
		usage: { input_tokens: 10, output_tokens: 1, cost: 0.000004 },
		model: "perplexity/pplx-decider-flash-v1.2-20261016",
	};
}

test("a full repo with mode dispatch calls the backend once and returns the level", async () => {
	const repo = makeRepo("git@github.com:owner/full.git");
	const vault = makeVault(reposJson());
	const home = makeHome();
	const backend = fakeBackend(() => answer());
	try {
		const result = await decideTaskLevel({
			cfg: cfg({ effort: "dispatch" }),
			task,
			root: repo,
			env: envFor(vault),
			home,
			backend,
		});
		assert.equal(backend.calls.length, 1);
		assert.deepEqual(backend.calls[0]?.state, {
			task: "Write the thing",
			files: ["a.ts"],
			role: "implement",
		});
		assert.deepEqual(result, {
			ok: true,
			suggested: "high",
			probabilities: { low: 0.1, high: 0.8, max: 0.1 },
			confidence: 0.9,
			complexity: 3.5,
			model: "perplexity/pplx-decider-flash-v1.2-20261016",
			cost: 0.000004,
		});
	} finally {
		cleanup(repo, vault, home);
	}
});

test("the off and apply modes give reason off and make no call", async () => {
	const repo = makeRepo("git@github.com:owner/full.git");
	const vault = makeVault(reposJson());
	const home = makeHome();
	const backend = fakeBackend(() => answer());
	try {
		for (const effort of ["off", "apply"] as const) {
			const result = await decideTaskLevel({
				cfg: cfg({ effort }),
				task,
				root: repo,
				env: envFor(vault),
				home,
				backend,
			});
			assert.deepEqual(result, { ok: false, reason: "off" });
		}
		assert.equal(backend.calls.length, 0);
	} finally {
		cleanup(repo, vault, home);
	}
});

test("a meta, a none and an unknown repo give not-full and never call the backend", async () => {
	const metaRepo = makeRepo("git@github.com:owner/meta.git");
	const noneRepo = makeRepo("git@github.com:secret/none.git");
	const brokenRepo = makeRepo("git@github.com:owner/full.git");
	const vault = makeVault(reposJson());
	const brokenVault = makeVault("{ not json");
	const home = makeHome();
	const backend = fakeBackend(() => answer());
	try {
		const cases = [
			{ root: metaRepo, vault },
			{ root: noneRepo, vault },
			{ root: brokenRepo, vault: brokenVault },
		];
		for (const one of cases) {
			const result = await decideTaskLevel({
				cfg: cfg({ effort: "dispatch" }),
				task,
				root: one.root,
				env: envFor(one.vault),
				home,
				backend,
			});
			assert.deepEqual(result, { ok: false, reason: "not-full" });
		}
		assert.equal(backend.calls.length, 0);
	} finally {
		cleanup(metaRepo, noneRepo, brokenRepo, vault, brokenVault, home);
	}
});

test("no key and no injected backend give no-key and make no network call", async () => {
	const repo = makeRepo("git@github.com:owner/full.git");
	const vault = makeVault(reposJson());
	const home = makeHome();
	const realFetch = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = (async () => {
		calls += 1;
		throw new Error("the network is disabled in tests");
	}) as typeof fetch;
	try {
		const result = await decideTaskLevel({
			cfg: cfg({ effort: "dispatch" }),
			task,
			root: repo,
			env: envFor(vault),
			home,
		});
		assert.deepEqual(result, { ok: false, reason: "no-key" });
		assert.equal(calls, 0);
	} finally {
		globalThis.fetch = realFetch;
		cleanup(repo, vault, home);
	}
});

test("a backend failure gives an error whose message holds no key text", async () => {
	const repo = makeRepo("git@github.com:owner/full.git");
	const vault = makeVault(reposJson());
	const home = makeHome();
	const backend = fakeBackend(() => {
		throw new BackendError(`openrouter: HTTP 401: user not found for ${KEY}`, { status: 401 });
	});
	try {
		const result = await decideTaskLevel({
			cfg: cfg({ effort: "dispatch" }),
			task,
			root: repo,
			env: envFor(vault),
			home,
			backend,
		});
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.equal(result.reason, "error");
		assert.equal(result.status, 401);
		assert.equal(result.error?.includes(KEY), false);
		assert.match(result.error ?? "", /<redacted>/);
	} finally {
		cleanup(repo, vault, home);
	}
});

test("a malformed answer is an error result, not a throw", async () => {
	const repo = makeRepo("git@github.com:owner/full.git");
	const vault = makeVault(reposJson());
	const home = makeHome();
	const backend = fakeBackend(() => ({ answers: {} }));
	try {
		const result = await decideTaskLevel({
			cfg: cfg({ effort: "dispatch" }),
			task,
			root: repo,
			env: envFor(vault),
			home,
			backend,
		});
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.equal(result.reason, "error");
		assert.equal(backend.calls.length, 1);
	} finally {
		cleanup(repo, vault, home);
	}
});
