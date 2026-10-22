/** Run with: node --test dispatch-plan/vault-cli-admin.test.mjs (Node 24+) */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

const cli = path.join(import.meta.dirname, "vault.mjs");
const dispatcher = path.resolve(import.meta.dirname, "..", "pi-plan-dispatch");

/** Git stays away from the real global config and takes its identity from here. */
const GIT_ENV = {
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
	GIT_AUTHOR_NAME: "vault test",
	GIT_AUTHOR_EMAIL: "vault@example.test",
	GIT_COMMITTER_NAME: "vault test",
	GIT_COMMITTER_EMAIL: "vault@example.test",
};

function git(cwd, args) {
	return execFileSync("git", ["-C", cwd, ...args], {
		env: { ...process.env, ...GIT_ENV },
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

/** A child environment with a temp HOME, no worker flag and no inherited vault. */
function cliEnv(root) {
	const home = path.join(root, "home");
	fs.mkdirSync(home, { recursive: true });
	const env = { ...process.env, ...GIT_ENV, HOME: home, PI_PLAN_DISPATCH_DIR: dispatcher };
	delete env.PI_PLAN_DISPATCH_WORKER;
	delete env.AGENT_VAULT;
	delete env.AGENT_VAULT_LOCK_WAIT_MS;
	delete env.PI_PLAN_DISPATCH_HARNESS;
	return env;
}

/** Spawn the CLI from the temp root, so it never sees this repo's working tree. */
function run(root, args, opts = {}) {
	const result = spawnSync(process.execPath, [cli, ...args], {
		env: { ...cliEnv(root), ...opts.env },
		cwd: opts.cwd ?? root,
		encoding: "utf8",
		timeout: 120_000,
	});
	return { code: result.status, out: result.stdout, err: result.stderr };
}

/** A fresh temp root per test, removed even when the body throws. */
function withRoot(body) {
	return async () => {
		const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vault-cli-admin-")));
		try {
			await body({ root });
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	};
}

/** init a vault at <root>/vault, the setup/doctor tests all need one. */
function makeVault(root) {
	const vault = path.join(root, "vault");
	const result = run(root, ["init", "--path", vault]);
	assert.equal(result.code, 0, result.err);
	return vault;
}

test(
	"init --path creates a vault from the template",
	withRoot(async ({ root }) => {
		const vault = path.join(root, "vault");
		const result = run(root, ["init", "--path", vault]);
		assert.equal(result.code, 0, result.err);
		assert.ok(fs.existsSync(path.join(vault, "harness.json")), "the template lands in place");
		assert.ok(fs.existsSync(path.join(vault, "CLAUDE.md")));
		assert.equal(git(vault, ["rev-list", "--count", "HEAD"]).trim(), "1");
	}),
);

test(
	"init --remote sets origin",
	withRoot(async ({ root }) => {
		const vault = path.join(root, "vault");
		const remote = "git@example.test:o/vault.git";
		const result = run(root, ["init", "--path", vault, "--remote", remote]);
		assert.equal(result.code, 0, result.err);
		assert.equal(git(vault, ["remote", "get-url", "origin"]).trim(), remote);
	}),
);

test(
	"setup --path writes the machine config",
	withRoot(async ({ root }) => {
		const vault = makeVault(root);
		const result = run(root, ["setup", "--path", vault]);
		assert.equal(result.code, 0, result.err);
		const file = path.join(root, "home", ".config", "agent-vault", "config.json");
		const config = JSON.parse(fs.readFileSync(file, "utf8"));
		assert.equal(config.path, vault);
		assert.equal(typeof config.host, "string");
		assert.ok(fs.existsSync(path.join(vault, "index.md")), "setup rebuilds the index");
	}),
);

test(
	"doctor with no vault says so and exits 1",
	withRoot(async ({ root }) => {
		const result = run(root, ["doctor"]);
		assert.equal(result.code, 1);
		assert.match(result.out, /fail vault configured/);
	}),
);

test(
	"a Pi worker is refused init, setup and doctor",
	withRoot(async ({ root }) => {
		const worker = { PI_PLAN_DISPATCH_WORKER: "1" };
		for (const args of [["init"], ["setup"], ["doctor"]]) {
			const result = run(root, args, { env: worker });
			assert.equal(result.code, 2, `expected exit 2 for ${args.join(" ")}`);
			assert.match(result.err, /PI_PLAN_DISPATCH_WORKER/);
			assert.equal(result.out, "");
		}
	}),
);

test(
	"an unknown flag and a flag the command does not take are usage errors",
	withRoot(async ({ root }) => {
		const bogus = run(root, ["init", "--bogus"]);
		assert.equal(bogus.code, 64);
		assert.match(bogus.err, /usage: node vault\.mjs/);
		const wrong = run(root, ["doctor", "--path", "x"]);
		assert.equal(wrong.code, 64);
		assert.match(wrong.err, /doctor does not take --path/);
		assert.equal(wrong.out, "");
	}),
);

test(
	"the admin commands emit no event and take no lock",
	withRoot(async ({ root }) => {
		const vault = makeVault(root);
		const events = path.join(root, "events");
		for (const args of [
			["init", "--path", path.join(root, "second")],
			["setup", "--path", vault],
			["doctor", "--vault", vault],
		]) {
			const result = run(root, [...args, "--root", events, "--trace", "adm1"]);
			assert.notEqual(result.code, 64, result.err);
		}
		assert.equal(fs.existsSync(path.join(events, ".plans", "traces", "adm1.jsonl")), false);
		assert.equal(fs.existsSync(path.join(vault, ".git", "agent-vault.lock")), false);
	}),
);
