/** Run with: node --test dispatch-plan/vault-admin.test.mjs (Node 24+) */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

import { findHarnessRoot, runDoctor, runInit, runSetup } from "./vault-admin.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const moduleDir = path.join(repoRoot, "pi-plan-dispatch", "vault");
const templateDir = path.join(repoRoot, "vault-template");
const schema = await import(pathToFileURL(path.join(moduleDir, "schema.ts")).href);

/** Every temp directory a test makes is removed in the same test, whatever happens. */
async function inTemps(fn) {
	const dirs = [];
	const dir = (prefix = "pi-vault-admin-") => {
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

/** A child environment with a temp HOME and no global git config, so nothing comes from this machine. */
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

function makeCtx({ home, env, vaultPath, harnessRoot = repoRoot }) {
	const out = [];
	const errors = [];
	const ctx = {
		env: env ?? envFor(home),
		home,
		cwd: home,
		harnessRoot,
		vaultPath,
		moduleDir,
		out: (text) => out.push(text),
		err: (text) => errors.push(text),
	};
	return { ctx, out, errors, text: () => out.join("\n"), errText: () => errors.join("\n") };
}

function gitRun(cwd, args, env) {
	const result = spawnSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout ?? "";
}

function copyTemplate(vault) {
	fs.cpSync(templateDir, vault, { recursive: true });
	fs.chmodSync(path.join(vault, "bootstrap.sh"), 0o755);
}

function makeVault(parent, { remote, env } = {}) {
	const vault = path.join(parent, "agent-vault");
	copyTemplate(vault);
	gitRun(vault, ["init", "-q", "-b", "main"], env);
	gitRun(vault, ["add", "-A"], env);
	gitRun(vault, ["commit", "-q", "-m", "init"], env);
	if (remote !== undefined) gitRun(vault, ["remote", "add", "origin", remote], env);
	return vault;
}

function makeBare(parent, env) {
	const bare = path.join(parent, "origin.git");
	gitRun(parent, ["init", "-q", "--bare", "-b", "main", bare], env);
	return bare;
}

/** Relative names of every file under dir, skipping .git, sorted. */
function fileList(dir, prefix = "") {
	const names = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === ".git") continue;
		const rel = path.join(prefix, entry.name);
		if (entry.isDirectory()) names.push(...fileList(path.join(dir, entry.name), rel));
		else names.push(rel);
	}
	return names.sort();
}

function hashFile(file) {
	return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function writeExecutable(file, text) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
	fs.chmodSync(file, 0o755);
}

function makeFakeHarness(parent, name) {
	const root = path.join(parent, name);
	fs.mkdirSync(path.join(root, "dispatch-plan"), { recursive: true });
	fs.mkdirSync(path.join(root, "pi-plan-dispatch"), { recursive: true });
	fs.mkdirSync(path.join(root, "vault-template"), { recursive: true });
	fs.writeFileSync(path.join(root, "dispatch-plan", "SKILL.md"), "# skill\n");
	fs.writeFileSync(path.join(root, "pi-plan-dispatch", "core.ts"), "export const x = 1;\n");
	return root;
}

test("findHarnessRoot takes the first candidate that holds the skill, the dispatcher and the template", () =>
	inTemps(async (dir) => {
		const home = dir();
		const fromEnv = makeFakeHarness(dir(), "harness-env");
		const fromScript = makeFakeHarness(dir(), "harness-script");
		const found = findHarnessRoot({
			env: { PI_PLAN_DISPATCH_HARNESS: fromEnv },
			scriptDir: path.join(fromScript, "dispatch-plan"),
			vaultPath: undefined,
			home,
		});
		assert.equal(found, fromEnv);
	}));

test("findHarnessRoot falls back to the parent of scriptDir, then the folder next to the vault, then home", () =>
	inTemps(async (dir) => {
		const harness = path.resolve(repoRoot);
		assert.equal(
			findHarnessRoot({ env: {}, scriptDir: path.join(harness, "dispatch-plan"), vaultPath: undefined, home: "/nonexistent" }),
			harness,
		);

		const parent = dir();
		const sibling = makeFakeHarness(parent, "pi-plan-dispatch-phase1");
		const vaultPath = path.join(parent, "agent-vault");
		fs.mkdirSync(vaultPath);
		assert.equal(findHarnessRoot({ env: {}, scriptDir: undefined, vaultPath, home: "/nonexistent" }), sibling);

		const home = dir();
		const homeHarness = makeFakeHarness(path.join(home, "Documents", "repos"), "pi-plan-dispatch-phase1");
		assert.equal(findHarnessRoot({ env: {}, scriptDir: undefined, vaultPath: undefined, home }), homeHarness);
	}));

test("findHarnessRoot does not mistake an installed skills folder for the harness", () =>
	inTemps(async (dir) => {
		const home = dir();
		const scriptDir = path.join(home, ".claude", "skills", "dispatch-plan");
		fs.mkdirSync(scriptDir, { recursive: true });
		fs.writeFileSync(path.join(scriptDir, "SKILL.md"), "# skill\n");
		assert.equal(findHarnessRoot({ env: {}, scriptDir, vaultPath: undefined, home }), undefined);
	}));

test("findHarnessRoot skips a candidate that is missing a marker", () =>
	inTemps(async (dir) => {
		const incomplete = path.join(dir(), "only-skill");
		fs.mkdirSync(path.join(incomplete, "dispatch-plan"), { recursive: true });
		fs.writeFileSync(path.join(incomplete, "dispatch-plan", "SKILL.md"), "# skill\n");
		assert.equal(findHarnessRoot({ env: { PI_PLAN_DISPATCH_HARNESS: incomplete }, scriptDir: undefined, vaultPath: undefined, home: "/nonexistent" }), undefined);
	}));

test("init into a new directory copies the template, commits once and leaves a clean tree", () =>
	inTemps(async (dir) => {
		const home = dir();
		const env = envFor(home);
		const parent = dir();
		const { ctx, text, errText } = makeCtx({ home, env });
		const target = path.join(parent, "agent-vault");

		assert.equal(await runInit({ path: target }, ctx), 0, text() + errText());
		assert.deepEqual(fileList(target), fileList(templateDir));
		assert.equal(gitRun(target, ["rev-list", "--count", "HEAD"], env).trim(), "1");
		assert.equal(gitRun(target, ["log", "-1", "--format=%s"], env).trim(), "vault: init");
		assert.equal(gitRun(target, ["status", "--porcelain"], env).trim(), "");
		assert.notEqual(fs.statSync(path.join(target, "bootstrap.sh")).mode & 0o111, 0);
		assert.ok(text().includes(target));
		assert.ok(text().includes("git push -u origin HEAD"));
	}));

test("init defaults to <home>/Documents/repos/agent-vault", () =>
	inTemps(async (dir) => {
		const home = dir();
		const { ctx, text, errText } = makeCtx({ home, env: envFor(home) });
		assert.equal(await runInit({}, ctx), 0, text() + errText());
		const target = path.join(home, "Documents", "repos", "agent-vault");
		assert.deepEqual(fileList(target), fileList(templateDir));
	}));

test("init into an existing empty directory with a remote copies the template and sets origin", () =>
	inTemps(async (dir) => {
		const home = dir();
		const env = envFor(home);
		const target = dir();
		const remote = "git@github.com:example/agent-vault.git";
		const { ctx, text, errText } = makeCtx({ home, env });

		assert.equal(await runInit({ path: target, remote }, ctx), 0, text() + errText());
		assert.deepEqual(fileList(target), fileList(templateDir));
		assert.equal(gitRun(target, ["remote", "get-url", "origin"], env).trim(), remote);
		assert.equal(gitRun(target, ["rev-list", "--count", "HEAD"], env).trim(), "1");
	}));

test("init into a directory holding only .git fills it and commits", () =>
	inTemps(async (dir) => {
		const home = dir();
		const env = envFor(home);
		const target = dir();
		gitRun(target, ["init", "-q"], env);
		const { ctx, text, errText } = makeCtx({ home, env });

		assert.equal(await runInit({ path: target }, ctx), 0, text() + errText());
		assert.deepEqual(fileList(target), fileList(templateDir));
		assert.equal(gitRun(target, ["rev-list", "--count", "HEAD"], env).trim(), "1");
	}));

test("init refuses a non-empty directory and changes nothing", () =>
	inTemps(async (dir) => {
		const home = dir();
		const env = envFor(home);
		const target = dir();
		fs.writeFileSync(path.join(target, "keep.txt"), "mine\n");
		const { ctx, errText } = makeCtx({ home, env });

		assert.equal(await runInit({ path: target }, ctx), 1);
		assert.deepEqual(fs.readdirSync(target), ["keep.txt"]);
		assert.match(errText(), /not empty/);
	}));

test("init fails when the template folder is missing", () =>
	inTemps(async (dir) => {
		const home = dir();
		const emptyHarness = dir();
		const target = path.join(dir(), "agent-vault");
		const { ctx, errText } = makeCtx({ home, env: envFor(home), harnessRoot: emptyHarness });

		assert.equal(await runInit({ path: target }, ctx), 1);
		assert.equal(fs.existsSync(target), false);
		assert.match(errText(), /vault-template is missing/);
	}));

test("setup writes the config, installs the files without tests or archive, and builds the index", () =>
	inTemps(async (dir) => {
		const home = dir();
		const env = envFor(home);
		const vault = makeVault(dir(), { env });
		const { ctx, text, errText } = makeCtx({ home, env, vaultPath: vault });

		assert.equal(await runSetup({ path: vault }, ctx), 0, text() + errText());

		const configFile = path.join(home, ".config", "agent-vault", "config.json");
		const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
		assert.equal(config.path, vault);
		assert.equal(config.host, schema.slug(os.hostname()));
		assert.equal("remote" in config, false);

		const skills = path.join(home, ".claude", "skills", "dispatch-plan");
		const want = fs
			.readdirSync(path.join(repoRoot, "dispatch-plan"), { withFileTypes: true })
			.filter((entry) => entry.isFile() && !entry.name.includes(".test."))
			.map((entry) => entry.name)
			.sort();
		assert.deepEqual(fs.readdirSync(skills).sort(), want);
		assert.equal(fs.existsSync(path.join(skills, "archive")), false);
		assert.ok(fs.existsSync(path.join(home, ".claude", "agents", "plan-auditor.md")));

		const record = JSON.parse(fs.readFileSync(path.join(home, ".config", "agent-vault", "installed.json"), "utf8"));
		assert.equal(Object.keys(record).length, want.length + 1);
		assert.equal(record[path.join(skills, "SKILL.md")], hashFile(path.join(repoRoot, "dispatch-plan", "SKILL.md")));

		assert.ok(fs.existsSync(path.join(vault, "index.md")));
		assert.equal(fs.existsSync(path.join(home, ".pi", "agent", "settings.json")), false);
		assert.match(text(), /ok {3}node/);
	}));

test("setup keeps a locally modified install, reports it, and replaces it with force", () =>
	inTemps(async (dir) => {
		const home = dir();
		const env = envFor(home);
		const vault = makeVault(dir(), { env });
		const first = makeCtx({ home, env });
		assert.equal(await runSetup({ path: vault }, first.ctx), 0, first.text() + first.errText());

		const skill = path.join(home, ".claude", "skills", "dispatch-plan", "SKILL.md");
		const recordFile = path.join(home, ".config", "agent-vault", "installed.json");
		const recorded = JSON.parse(fs.readFileSync(recordFile, "utf8"))[skill];
		fs.appendFileSync(skill, "\nlocal edit\n");

		const second = makeCtx({ home, env });
		assert.equal(await runSetup({ path: vault }, second.ctx), 0, second.text() + second.errText());
		assert.match(second.text(), /^kept \(modified\): .*SKILL\.md$/m);
		assert.match(fs.readFileSync(skill, "utf8"), /local edit/);
		assert.equal(JSON.parse(fs.readFileSync(recordFile, "utf8"))[skill], recorded);

		const third = makeCtx({ home, env });
		assert.equal(await runSetup({ path: vault, force: true }, third.ctx), 0, third.text() + third.errText());
		assert.doesNotMatch(fs.readFileSync(skill, "utf8"), /local edit/);
		assert.equal(JSON.parse(fs.readFileSync(recordFile, "utf8"))[skill], hashFile(path.join(repoRoot, "dispatch-plan", "SKILL.md")));
	}));

test("setup keeps an existing host and records the origin remote", () =>
	inTemps(async (dir) => {
		const home = dir();
		const env = envFor(home);
		const bare = makeBare(dir(), env);
		const vault = makeVault(dir(), { remote: bare, env });
		const configFile = path.join(home, ".config", "agent-vault", "config.json");
		fs.mkdirSync(path.dirname(configFile), { recursive: true });
		fs.writeFileSync(configFile, JSON.stringify({ host: "my-host" }));
		const { ctx, text, errText } = makeCtx({ home, env });

		assert.equal(await runSetup({ path: vault }, ctx), 0, text() + errText());
		const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
		assert.equal(config.host, "my-host");
		assert.equal(config.remote, bare);
	}));

test("setup refuses a directory that is not a git repository and writes no config", () =>
	inTemps(async (dir) => {
		const home = dir();
		const plain = dir();
		const { ctx, errText } = makeCtx({ home, env: envFor(home) });

		assert.equal(await runSetup({ path: plain }, ctx), 1);
		assert.match(errText(), /not a git repository/);
		assert.match(errText(), /init --path/);
		assert.equal(fs.existsSync(path.join(home, ".config", "agent-vault", "config.json")), false);
	}));

test("doctor without a configured vault prints the fix and exits 1", () =>
	inTemps(async (dir) => {
		const home = dir();
		const { ctx, out } = makeCtx({ home, env: envFor(home) });
		assert.equal(await runDoctor({}, ctx), 1);
		assert.deepEqual(out, ["fail vault configured. Fix: node dispatch-plan/vault.mjs setup --path <vault>"]);
	}));

test("doctor on a bare machine fails with a fix per missing required item", () =>
	inTemps(async (dir) => {
		const home = dir();
		const env = envFor(home);
		const vault = makeVault(dir(), { env });
		const emptyBin = dir();
		const barePath = [emptyBin, path.dirname(process.execPath)].join(path.delimiter);
		const { ctx, text } = makeCtx({ home, env: envFor(home, { PATH: barePath }), vaultPath: vault });

		assert.equal(await runDoctor({}, ctx), 1);
		const report = text();
		assert.match(report, /^ok {3}node$/m);
		assert.match(report, /^fail git: /m);
		assert.match(report, /^fail remote: /m);
		assert.match(report, /git push -u origin HEAD/);
		assert.ok(report.includes(`node dispatch-plan/vault.mjs setup --path ${vault}`));
		assert.ok(report.includes("node ~/.claude/skills/dispatch-plan/vault.mjs repo allow <slug> --mode full"));
		assert.match(report, /^fail pi: /m);
		assert.match(report, /^optional fail graphify: /m);
		assert.ok(report.includes("uv tool install graphifyy && graphify install"));
		assert.match(report, /^optional fail obsidian-skills: /m);
		assert.ok(report.includes("/plugin marketplace add kepano/obsidian-skills"));
		assert.ok(report.includes("/plugin install obsidian@obsidian-skills"));
	}));

async function prepareMachine(dir) {
	const home = dir();
	const env = envFor(home);
	const bare = makeBare(dir(), env);
	const vault = makeVault(dir(), { remote: bare, env });
	gitRun(vault, ["push", "-q", "-u", "origin", "main"], env);
	const setup = makeCtx({ home, env, vaultPath: vault });
	const setupCode = await runSetup({ path: vault }, setup.ctx);
	assert.equal(setupCode, 0, setup.text() + setup.errText());

	fs.writeFileSync(
		path.join(vault, "repos.json"),
		`${JSON.stringify({ repos: { "github.com/example/agent-vault": { mode: "full" } }, aliases: {} }, null, 2)}\n`,
	);

	const piDir = path.join(home, ".pi", "agent");
	fs.mkdirSync(piDir, { recursive: true });
	fs.writeFileSync(path.join(piDir, "settings.json"), `${JSON.stringify({ packages: [path.join(repoRoot, "pi-plan-dispatch")] }, null, 2)}\n`);
	fs.writeFileSync(path.join(piDir, "auth.json"), `${JSON.stringify({ "opencode-go": { type: "api_key", key: "placeholder" } }, null, 2)}\n`);

	const bin = dir();
	writeExecutable(path.join(bin, "pi"), "#!/bin/sh\necho pi 1.2.3\n");
	writeExecutable(path.join(bin, "graphify"), "#!/bin/sh\necho graphify 1.0.0\n");

	fs.mkdirSync(path.join(home, ".claude", "plugins", "cache", "obsidian-skills", "obsidian", "1.0.1"), { recursive: true });

	const gitBin = path.dirname(execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim());
	const restricted = envFor(home, { PATH: [bin, path.dirname(process.execPath), gitBin].join(path.delimiter) });
	return { home, env: restricted, vault, bin };
}

test("doctor passes on a fully prepared machine", () =>
	inTemps(async (dir) => {
		const machine = await prepareMachine(dir);
		const { ctx, text } = makeCtx({ home: machine.home, env: machine.env, vaultPath: machine.vault });

		const code = await runDoctor({}, ctx);
		assert.equal(code, 0, text());
		assert.doesNotMatch(text(), /^fail /m);
		assert.match(text(), /^ok {3}node$/m);
		assert.match(text(), /^ok {3}installed$/m);
		assert.match(text(), /^optional ok graphify$/m);
		assert.match(text(), /^optional ok obsidian-skills$/m);
	}));

test("doctor fails on a newer vault schema and a locally changed installed file", () =>
	inTemps(async (dir) => {
		const machine = await prepareMachine(dir);
		const harnessFile = path.join(machine.vault, "harness.json");
		const harness = JSON.parse(fs.readFileSync(harnessFile, "utf8"));
		fs.writeFileSync(harnessFile, `${JSON.stringify({ ...harness, schema: harness.schema + 1 }, null, 2)}\n`);
		fs.appendFileSync(path.join(machine.home, ".claude", "skills", "dispatch-plan", "SKILL.md"), "\nedited\n");

		const { ctx, text } = makeCtx({ home: machine.home, env: machine.env, vaultPath: machine.vault });
		assert.equal(await runDoctor({}, ctx), 1);
		assert.match(text(), /^fail vault schema: /m);
		assert.match(text(), /^fail installed: /m);
		assert.ok(text().includes(`Fix: node dispatch-plan/vault.mjs setup --path ${machine.vault}`));
	}));
