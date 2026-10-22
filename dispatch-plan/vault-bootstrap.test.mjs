/** Run with: node --test dispatch-plan/vault-bootstrap.test.mjs (Node 24+) */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const templateDir = path.join(repoRoot, "vault-template");

/** Every temp directory a test makes is removed in the same test, whatever happens. */
async function inTemps(fn) {
	const dirs = [];
	const dir = (prefix = "pi-vault-bootstrap-") => {
		const made = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
		dirs.push(made);
		return made;
	};
	try {
		await fn(dir);
	} finally {
		for (const made of dirs) fs.rmSync(made, { recursive: true, force: true });
	}
}

/** A child environment with a temp HOME and no worker or global git config. */
function envFor(home, extra = {}) {
	const env = {
		...process.env,
		HOME: home,
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_SYSTEM: "/dev/null",
		GIT_AUTHOR_NAME: "test",
		GIT_AUTHOR_EMAIL: "test@example.test",
		GIT_COMMITTER_NAME: "test",
		GIT_COMMITTER_EMAIL: "test@example.test",
		...extra,
	};
	delete env.PI_PLAN_DISPATCH_WORKER;
	delete env.PI_PLAN_DISPATCH_HARNESS;
	delete env.AGENT_VAULT;
	return env;
}

function gitRun(cwd, args, env) {
	const result = spawnSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout ?? "";
}

function readHarness(vault) {
	return JSON.parse(fs.readFileSync(path.join(vault, "harness.json"), "utf8"));
}

function writeHarness(vault, value) {
	fs.writeFileSync(path.join(vault, "harness.json"), `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * A vault from the template, committed, with the harness repo a local path that
 * is never cloned and a sibling symlink standing in for the harness clone.
 */
function makeVault(parent, env, change = {}) {
	const vault = path.join(parent, "agent-vault");
	fs.cpSync(templateDir, vault, { recursive: true });
	writeHarness(vault, { ...readHarness(vault), harness_repo: path.join(parent, "never-used-harness"), ...change });
	gitRun(vault, ["init", "-q", "-b", "main"], env);
	gitRun(vault, ["add", "-A"], env);
	gitRun(vault, ["commit", "-q", "-m", "vault: init"], env);
	fs.symlinkSync(repoRoot, path.join(parent, "pi-plan-dispatch-phase1"), "dir");
	return vault;
}

function runBootstrap(vault, env) {
	// The harness fixture is a symlink, so the CLI entry must keep that path as the
	// main module; otherwise its main check compares a real path with a symlink.
	return spawnSync("bash", [path.join(vault, "bootstrap.sh")], {
		cwd: vault,
		env: { ...env, NODE_OPTIONS: "--preserve-symlinks-main" },
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function expectedSkillFiles() {
	return fs
		.readdirSync(path.join(repoRoot, "dispatch-plan"), { withFileTypes: true })
		.filter((entry) => entry.isFile() && !entry.name.includes(".test."))
		.map((entry) => entry.name)
		.sort();
}

test("bootstrap sets up a new machine from a vault with the harness clone already next to it", () =>
	inTemps(async (dir) => {
		const home = dir();
		const env = envFor(home);
		const vault = makeVault(dir(), env);
		assert.notEqual(fs.statSync(path.join(vault, "bootstrap.sh")).mode & 0o111, 0);

		const result = runBootstrap(vault, env);
		const output = `${result.stdout}\n${result.stderr}`;
		assert.equal(result.status, 0, output);

		const configFile = path.join(home, ".config", "agent-vault", "config.json");
		const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
		assert.equal(config.path, vault);
		assert.equal(typeof config.host, "string");
		assert.notEqual(config.host, "");

		const skills = path.join(home, ".claude", "skills", "dispatch-plan");
		const installed = fs.readdirSync(skills).sort();
		assert.deepEqual(installed, expectedSkillFiles());
		assert.equal(installed.some((name) => name.includes(".test.")), false);
		assert.equal(fs.existsSync(path.join(skills, "archive")), false);

		const auditor = path.join(home, ".claude", "agents", "plan-auditor.md");
		assert.equal(fs.readFileSync(auditor, "utf8"), fs.readFileSync(path.join(repoRoot, "dispatch-plan", "agents", "plan-auditor.md"), "utf8"));

		assert.match(output, /Log Pi into OpenCode Go/);
		assert.match(output, /Register the extension package/);
		assert.match(output, /\/plugin marketplace add kepano\/obsidian-skills/);
		assert.match(output, /\/plugin install obsidian@obsidian-skills/);

		assert.equal(fs.existsSync(path.join(home, ".pi", "agent", "settings.json")), false);
	}));

test("bootstrap refuses an older Node than the vault needs and installs nothing", () =>
	inTemps(async (dir) => {
		const home = dir();
		const env = envFor(home);
		const vault = makeVault(dir(), env, { min_node: 99 });

		const result = runBootstrap(vault, env);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /^bootstrap: /m);
		assert.match(result.stderr, /99/);

		assert.equal(fs.existsSync(path.join(home, ".config", "agent-vault")), false);
		assert.equal(fs.existsSync(path.join(home, ".claude")), false);
	}));
