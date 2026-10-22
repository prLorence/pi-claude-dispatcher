import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const cli = path.join(import.meta.dirname, "vault.mjs");
const dispatcher = path.resolve(import.meta.dirname, "..", "pi-plan-dispatch");
const schema = await import(pathToFileURL(path.join(dispatcher, "vault", "schema.ts")).href);
const { lockWaitMs, parseArgs } = await import(pathToFileURL(cli).href);

const TYPE_FOLDERS = ["plans", "runs", "findings", "decisions", "lessons", "projects", "codebases", "templates"];

/** Git stays away from the real global config, so a test never inherits an identity. */
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

function write(dir, name, text) {
	const file = path.join(dir, name);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
	return file;
}

function read(file) {
	return fs.readFileSync(file, "utf8");
}

function reposText(repos) {
	return `${JSON.stringify({ repos, aliases: {} }, null, 2)}\n`;
}

/** A vault with the template shape and one commit, so sync has something to push. */
function makeVault(root) {
	const vault = path.join(root, "vault");
	fs.mkdirSync(vault, { recursive: true });
	git(vault, ["init", "-q", "-b", "main"]);
	for (const folder of TYPE_FOLDERS) write(vault, path.join(folder, ".gitkeep"), "");
	write(vault, "CLAUDE.md", "# Schema\nRules for agents.\n");
	write(vault, "README.md", "The vault.\n");
	write(vault, "log.md", "");
	write(
		vault,
		"repos.json",
		reposText({
			"github.com/o/n": { mode: "full" },
			"github.com/o/m": { mode: "meta" },
			"github.com/o/x": { mode: "none" },
		}),
	);
	write(vault, "harness.json", `${JSON.stringify({ schema: 1, boot_budget_tokens: 4000, min_node: 24 })}\n`);
	write(vault, ".gitignore", "index.md\n");
	git(vault, ["add", "-A"]);
	git(vault, ["commit", "-qm", "init"]);
	return vault;
}

/** A git project with an origin remote, for the commands that read the working directory. */
function makeProject(root, name, remote) {
	const project = path.join(root, name);
	fs.mkdirSync(project, { recursive: true });
	git(project, ["init", "-q", "-b", "main"]);
	if (remote !== undefined) git(project, ["remote", "add", "origin", remote]);
	return project;
}

function cliEnv(root, vault) {
	const env = { ...process.env, ...GIT_ENV, HOME: path.join(root, "home"), PI_PLAN_DISPATCH_DIR: dispatcher };
	delete env.PI_PLAN_DISPATCH_WORKER;
	delete env.AGENT_VAULT;
	delete env.AGENT_VAULT_LOCK_WAIT_MS;
	if (vault !== undefined) env.AGENT_VAULT = vault;
	return env;
}

/** Spawn the CLI: no worker flag, no inherited vault, a throwaway HOME. */
function run(root, args, opts = {}) {
	const result = spawnSync(process.execPath, [cli, ...args], {
		env: { ...cliEnv(root, opts.vault), ...opts.env },
		cwd: opts.cwd ?? root,
		input: opts.input ?? "",
		encoding: "utf8",
		timeout: 60_000,
	});
	return { code: result.status, out: result.stdout, err: result.stderr, elapsed: result.elapsedMs };
}

/** A fresh temp root per test, removed even when the body throws. */
function withVault(body) {
	return async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "vault-cli-"));
		try {
			await body({ root, vault: makeVault(root) });
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	};
}

function withRoot(body) {
	return async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "vault-cli-"));
		try {
			await body({ root });
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	};
}

/** Today as a local YYYY-MM-DD, the same date the CLI stamps on a new note. */
function today() {
	const now = new Date();
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function events(root, trace) {
	const file = path.join(root, "events", ".plans", "traces", `${trace}.jsonl`);
	if (!fs.existsSync(file)) return [];
	return read(file)
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line));
}

const RUN_ARGS = ["--set", "trace=t1", "--set", "repo=github.com/o/n", "--set", "status=done", "--set", "gate=pass"];

test(
	"resolve prints the path and the host",
	withVault(async ({ root, vault }) => {
		const result = run(root, ["resolve"], { vault });
		assert.equal(result.code, 0);
		assert.equal(result.out, `path: ${vault}\nhost: ${result.out.split("\n")[1].slice("host: ".length)}\n`);
		assert.ok(!result.out.includes("remote:"), "no remote is configured, so no line for it");
	}),
);

test(
	"resolve --json prints an object with the path and the host",
	withVault(async ({ root, vault }) => {
		const result = run(root, ["resolve", "--json"], { vault });
		assert.equal(result.code, 0);
		const body = JSON.parse(result.out);
		assert.equal(body.path, vault);
		assert.equal(typeof body.host, "string");
		assert.ok(body.host.length > 0);
		assert.equal(body.remote, undefined);
	}),
);

test(
	"resolve reads the config file when AGENT_VAULT is unset",
	withVault(async ({ root, vault }) => {
		write(
			path.join(root, "home"),
			".config/agent-vault/config.json",
			`${JSON.stringify({ path: vault, host: "test-host", remote: "git@example.test:o/vault.git" })}\n`,
		);
		const result = run(root, ["resolve", "--json"]);
		assert.equal(result.code, 0);
		assert.deepEqual(JSON.parse(result.out), { path: vault, host: "test-host", remote: "git@example.test:o/vault.git" });
	}),
);

test(
	"--vault wins over the configured vault",
	withVault(async ({ root, vault }) => {
		const other = path.join(root, "other");
		fs.mkdirSync(other, { recursive: true });
		// The configured vault is the one --vault has to beat, so pass it.
		const configured = run(root, ["resolve", "--json"], { vault });
		assert.equal(configured.code, 0);
		assert.equal(JSON.parse(configured.out).path, vault);
		const result = run(root, ["resolve", "--json", "--vault", other], { vault });
		assert.equal(result.code, 0);
		assert.equal(JSON.parse(result.out).path, other);
		assert.equal(result.out.includes(vault), false);
	}),
);

test("resolve --vault works and is resolved against the working directory", () =>
	withRoot(async ({ root }) => {
		const result = run(root, ["resolve", "--vault", "sub"]);
		assert.equal(result.code, 0);
		// process.cwd() reports the resolved path, so /var/... becomes /private/var/...
		assert.equal(result.out.split("\n")[0], `path: ${path.join(fs.realpathSync(root), "sub")}`);
	})());

test("an unconfigured vault exits 1 and records vault.unavailable", () =>
	withRoot(async ({ root }) => {
		for (const args of [["resolve"], ["boot"], ["note", "new", "run", "a-run"]]) {
			const result = run(root, args);
			assert.equal(result.code, 1, `expected exit 1 for ${args.join(" ")}`);
			assert.match(result.err, /vault not configured/);
		}
		const traced = run(root, ["resolve", "--root", path.join(root, "events"), "--trace", "u1"]);
		assert.equal(traced.code, 1);
		const recorded = events(root, "u1");
		assert.equal(recorded.length, 1);
		assert.equal(recorded[0].kind, "vault.unavailable");
		assert.equal(recorded[0].actor, "vault");
		assert.equal(recorded[0].data.reason, "vault not configured");
	})());

test(
	"a Pi worker is refused every command",
	withVault(async ({ root, vault }) => {
		const worker = { PI_PLAN_DISPATCH_WORKER: "1" };
		for (const args of [
			["resolve"],
			["boot"],
			["lint"],
			["stats"],
			["note", "new", "run", "w-run", ...RUN_ARGS],
			["log", "append", "--repo", "-", "text"],
			["sync", "push"],
			["frobnicate"],
		]) {
			const result = run(root, args, { vault, env: worker });
			assert.equal(result.code, 2, `expected exit 2 for ${args.join(" ")}`);
			assert.match(result.err, /PI_PLAN_DISPATCH_WORKER/);
		}
		assert.equal(fs.existsSync(path.join(vault, "runs", "w-run.md")), false);
	}),
);

test(
	"the worker refusal comes before a usage error",
	withVault(async ({ root, vault }) => {
		const result = run(root, ["frobnicate"], { vault, env: { PI_PLAN_DISPATCH_WORKER: "1" } });
		assert.equal(result.code, 2);
		assert.match(result.err, /PI_PLAN_DISPATCH_WORKER/);
		assert.equal(result.err.includes("usage:"), false, "the usage text never appears: the refusal comes first");
		assert.equal(result.out, "");
	}),
);

test(
	"a usage error exits 64 before the vault is looked up",
	() =>
		withRoot(async ({ root }) => {
			for (const args of [["frobnicate"], ["resolve", "--nope"], ["note"], ["note", "frobnicate"], ["resolve", "extra"], ["--vault"]]) {
				const result = run(root, args);
				assert.equal(result.code, 64, `expected exit 64 for ${args.join(" ")}`);
				assert.match(result.err, /usage: node vault\.mjs/);
				assert.equal(result.out, "", "a usage error never writes to stdout");
			}
		})(),
);

test(
	"a missing required flag is a usage error",
	withVault(async ({ root, vault }) => {
		assert.equal(run(root, ["log", "append", "text"], { vault }).code, 64);
		assert.equal(run(root, ["repo", "allow", "github.com/o/n"], { vault }).code, 64);
	}),
);

test(
	"boot prints the vault CLAUDE.md and changes nothing",
	withVault(async ({ root, vault }) => {
		const before = git(vault, ["status", "--porcelain"]);
		const result = run(root, ["boot", "--repo", "github.com/o/n"], { vault });
		assert.equal(result.code, 0);
		assert.ok(result.out.startsWith("# Schema\nRules for agents.\n"), result.out);
		assert.equal(git(vault, ["status", "--porcelain"]), before);
	}),
);

test(
	"boot defaults the repo to the working directory and the budget to harness.json",
	withVault(async ({ root, vault }) => {
		write(vault, "harness.json", `${JSON.stringify({ schema: 1, boot_budget_tokens: 12 })}\n`);
		const project = makeProject(root, "project", "git@github.com:o/n.git");
		const note = run(root, ["note", "new", "project", "project-demo", "--set", "repos=github.com/o/n"], { vault });
		assert.equal(note.code, 0, note.err);
		const result = run(root, ["boot"], { vault, cwd: project });
		assert.equal(result.code, 0);
		assert.ok(result.out.startsWith("# Schema\nRules for agents.\n"), result.out);
		// 12 tokens is too few for the project item and the index, so harness.json was read.
		assert.match(result.out, /\[truncated: \d+ items\]/, "the tiny harness budget truncates the items");
		assert.equal(result.out.includes("=== project project-demo ==="), false);
		// A roomy budget shows the project note, so the repo came from the working directory.
		const roomy = run(root, ["boot", "--budget", "2000"], { vault, cwd: project });
		assert.equal(roomy.code, 0);
		assert.ok(roomy.out.includes("=== project project-demo ==="), roomy.out);
		assert.equal(roomy.out.includes("[truncated:"), false);
		const bad = run(root, ["boot", "--budget", "lots"], { vault, cwd: project });
		assert.equal(bad.code, 2);
	}),
);

test(
	"boot emits a vault.boot event",
	withVault(async ({ root, vault }) => {
		const result = run(root, ["boot", "--repo", "github.com/o/n", "--root", path.join(root, "events"), "--trace", "b1"], { vault });
		assert.equal(result.code, 0);
		const recorded = events(root, "b1");
		assert.equal(recorded.length, 1);
		assert.equal(recorded[0].kind, "vault.boot");
		assert.equal(recorded[0].trace, "b1");
		assert.equal(typeof recorded[0].data.bytes, "number");
		assert.equal(typeof recorded[0].data.items, "number");
		assert.equal(typeof recorded[0].data.truncated, "number");
		assert.equal(fs.existsSync(path.join(vault, ".plans")), false);
	}),
);

test(
	"--json is ignored outside resolve and stats",
	withVault(async ({ root, vault }) => {
		const boot = run(root, ["boot", "--json", "--repo", "github.com/o/n"], { vault });
		assert.equal(boot.code, 0);
		assert.ok(!boot.out.trimStart().startsWith("{"));
		const list = run(root, ["repo", "list", "--json"], { vault });
		assert.equal(list.code, 0);
		assert.match(list.out, /^github\.com\/o\/n\tfull$/m);
	}),
);

test(
	"note new writes a run note and a second run leaves it unchanged",
	withVault(async ({ root, vault }) => {
		const args = ["note", "new", "run", "feat-r1-run", ...RUN_ARGS];
		const first = run(root, args, { vault });
		assert.equal(first.code, 0, first.err);
		const file = path.join(vault, "runs", "feat-r1-run.md");
		assert.equal(first.out, `${file}\n`);
		const text = read(file);
		assert.match(text, new RegExp(`^created: ${today()}$`, "m"));
		assert.match(text, /^status: done$/m);
		assert.match(text, /^gate: pass$/m);
		const second = run(root, args, { vault });
		assert.equal(second.code, 0);
		assert.equal(read(file), text);
	}),
);

test(
	"note new keeps a repeated --set as a list and refuses a bad key",
	withVault(async ({ root, vault }) => {
		const result = run(
			root,
			["note", "new", "run", "list-r1-run", ...RUN_ARGS, "--set", "model=a", "--set", "model=b"],
			{ vault },
		);
		assert.equal(result.code, 0, result.err);
		assert.match(read(path.join(vault, "runs", "list-r1-run.md")), /^model:\n {2}- a\n {2}- b$/m);
		const bad = run(root, ["note", "new", "run", "key-r1-run", ...RUN_ARGS, "--set", "bad.key=x"], { vault });
		assert.equal(bad.code, 2);
		assert.equal(fs.existsSync(path.join(vault, "runs", "key-r1-run.md")), false);
	}),
);

test(
	"a project note keeps one repos entry as a list",
	withVault(async ({ root, vault }) => {
		const result = run(root, ["note", "new", "project", "project-one", "--set", "repos=github.com/o/n"], { vault });
		assert.equal(result.code, 0, result.err);
		const text = read(path.join(vault, "projects", "project-one.md"));
		assert.match(text, /^repos:\n {2}- github\.com\/o\/n$/m);
	}),
);

test(
	"a run note for a meta repo builds its body from its fields",
	withVault(async ({ root, vault }) => {
		const args = ["note", "new", "run", "meta-r1-run", "--set", "trace=t1", "--set", "repo=github.com/o/m", "--set", "status=done", "--set", "gate=pass", "--set", "tasks_done=3"];
		const result = run(root, args, { vault });
		assert.equal(result.code, 0, result.err);
		const text = read(path.join(vault, "runs", "meta-r1-run.md"));
		assert.ok(text.includes("- gate: pass"), text);
		assert.ok(text.includes("- tasks_done: 3"), text);
		const stdin = run(root, [...args, "--body-stdin"], { vault, input: "a body\n" });
		assert.equal(stdin.code, 2);
		assert.match(stdin.err, /takes its body from its fields/);
	}),
);

test(
	"note new refuses a note its allowlist does not allow and records vault.denied",
	withVault(async ({ root, vault }) => {
		const events_ = path.join(root, "events");
		const denied = run(
			root,
			["note", "new", "run", "none-r1-run", "--set", "trace=t1", "--set", "repo=github.com/o/x", "--set", "status=done", "--set", "gate=pass", "--root", events_, "--trace", "d1"],
			{ vault },
		);
		assert.equal(denied.code, 2);
		assert.match(denied.err, /is not allowed/);
		const recorded = events(root, "d1");
		assert.equal(recorded.length, 1);
		assert.equal(recorded[0].kind, "vault.denied");
		assert.deepEqual(recorded[0].data, { repo: "github.com/o/x", type: "run" });
		const unlisted = run(root, ["note", "new", "run", "no-r1-run", "--set", "trace=t1", "--set", "repo=github.com/o/z", "--set", "status=done", "--set", "gate=pass"], { vault });
		assert.equal(unlisted.code, 2);
	}),
);

test(
	"note new refuses an unknown type, a bad value and a missing property",
	withVault(async ({ root, vault }) => {
		assert.equal(run(root, ["note", "new", "memo", "memo-one"], { vault }).code, 2);
		const badStatus = run(root, ["note", "new", "run", "bad-r1-run", "--set", "trace=t1", "--set", "repo=github.com/o/n", "--set", "status=maybe", "--set", "gate=pass"], { vault });
		assert.equal(badStatus.code, 2);
		assert.match(badStatus.err, /status must be one of/);
		const missing = run(root, ["note", "new", "run", "short-r1-run", "--set", "trace=t1", "--set", "repo=github.com/o/n", "--set", "status=done"], { vault });
		assert.equal(missing.code, 2);
		assert.match(missing.err, /missing required property: gate/);
		assert.deepEqual(fs.readdirSync(path.join(vault, "runs")), [".gitkeep"]);
	}),
);

test(
	"a basename used by another type is refused even when only the basename clashes",
	withVault(async ({ root, vault }) => {
		const plan = run(root, ["note", "new", "plan", "x-run", "--set", "trace=t1", "--set", "round=1", "--set", "repo=github.com/o/n", "--set", "status=done"], { vault });
		assert.equal(plan.code, 0, plan.err);
		const clash = run(root, ["note", "new", "run", "x-run", ...RUN_ARGS], { vault });
		assert.equal(clash.code, 2);
		assert.match(clash.err, /already used by a plan note/);
		assert.equal(fs.existsSync(path.join(vault, "runs", "x-run.md")), false);
		assert.equal(fs.existsSync(path.join(vault, "plans", "x-run.md")), true);
	}),
);

test(
	"note set merges the properties and --body-stdin replaces the body",
	withVault(async ({ root, vault }) => {
		const created = run(root, ["note", "new", "decision", "decision-one", "--set", "project=project-one", "--set", "repo=github.com/o/n", "--body-stdin"], { vault, input: "first body\n" });
		assert.equal(created.code, 0, created.err);
		const merged = run(root, ["note", "set", "decision-one", "--set", "project=project-two"], { vault });
		assert.equal(merged.code, 0, merged.err);
		let text = read(path.join(vault, "decisions", "decision-one.md"));
		assert.match(text, /^project: project-two$/m);
		assert.ok(text.endsWith("first body\n"), text);
		const replaced = run(root, ["note", "set", "decision-one", "--body-stdin"], { vault, input: "second body\n" });
		assert.equal(replaced.code, 0, replaced.err);
		text = read(path.join(vault, "decisions", "decision-one.md"));
		assert.ok(text.endsWith("second body\n"), text);
		assert.equal(run(root, ["note", "set", "decision-missing"], { vault }).code, 2);
	}),
);

test(
	"note status closes a finding and refuses any other note",
	withVault(async ({ root, vault }) => {
		const hash = schema.fingerprintHash("banana");
		const basename = `t1-f-${hash}`;
		const created = run(
			root,
			["note", "new", "finding", basename, "--set", "trace=t1", "--set", "repo=github.com/o/n", "--set", "severity=major", "--set", `fingerprint=banana`, "--set", "source=pair", "--set", "status=open", "--body-stdin"],
			{ vault, input: "the bug\n" },
		);
		assert.equal(created.code, 0, created.err);
		const file = path.join(vault, "findings", `${basename}.md`);
		assert.match(read(file), /^status: open$/m);
		const closed = run(root, ["note", "status", basename, "closed"], { vault });
		assert.equal(closed.code, 0, closed.err);
		assert.match(read(file), /^status: closed$/m);
		assert.ok(read(file).includes("the bug"), "the body survives a status change");
		const notFinding = run(root, ["note", "status", "nope-one", "closed"], { vault });
		assert.equal(notFinding.code, 2);
		const badValue = run(root, ["note", "status", basename, "maybe"], { vault });
		assert.equal(badValue.code, 2);
		const runNote = run(root, ["note", "new", "run", "status-r1-run", ...RUN_ARGS], { vault });
		assert.equal(runNote.code, 0);
		assert.equal(run(root, ["note", "status", "status-r1-run", "closed"], { vault }).code, 2);
	}),
);

test(
	"note rm removes a note and refuses a missing one",
	withVault(async ({ root, vault }) => {
		const created = run(root, ["note", "new", "decision", "decision-two", "--set", "project=project-one", "--set", "repo=github.com/o/n"], { vault });
		assert.equal(created.code, 0, created.err);
		const file = path.join(vault, "decisions", "decision-two.md");
		assert.equal(run(root, ["note", "rm", "decision-two"], { vault }).code, 0);
		assert.equal(fs.existsSync(file), false);
		assert.equal(run(root, ["note", "rm", "decision-two"], { vault }).code, 2);
	}),
);

test(
	"log append writes one line in the log format",
	withVault(async ({ root, vault }) => {
		const result = run(root, ["log", "append", "--repo", "github.com/o/n", "--trace", "t1", "hello", "world"], { vault });
		assert.equal(result.code, 0, result.err);
		assert.match(read(path.join(vault, "log.md")), /^- \d{4}-\d\d-\d\dT[^ ]+ \[[^\]]+\] github\.com\/o\/n t1 hello world$/m);
	}),
);

test(
	"log append refuses a repo that is not allowed and text that names one",
	withVault(async ({ root, vault }) => {
		assert.equal(run(root, ["log", "append", "--repo", "github.com/o/x", "text"], { vault }).code, 2);
		assert.equal(run(root, ["log", "append", "--repo", "-", "about", "github.com/o/x", "here"], { vault }).code, 2);
		assert.equal(run(root, ["log", "append", "--repo", "github.com/o/n"], { vault }).code, 2);
		assert.equal(run(root, ["log", "append", "--repo", "-"], { vault }).code, 2);
		assert.equal(read(path.join(vault, "log.md")), "");
	}),
);

test(
	"index rebuild writes index.md and records the write",
	withVault(async ({ root, vault }) => {
		const result = run(root, ["index", "rebuild", "--root", path.join(root, "events"), "--trace", "i1"], { vault });
		assert.equal(result.code, 0, result.err);
		assert.equal(fs.existsSync(path.join(vault, "index.md")), true);
		const [recorded] = events(root, "i1");
		assert.equal(recorded.kind, "vault.write");
		assert.deepEqual(recorded.data, { type: "index", id: "index", op: "rebuild" });
	}),
);

test(
	"repo allow stores a normalised key and sorts repos.json",
	withVault(async ({ root, vault }) => {
		assert.equal(run(root, ["repo", "allow", "git@github.com:O/Q.git", "--mode", "meta"], { vault }).code, 0);
		const file = path.join(vault, "repos.json");
		const text = read(file);
		const parsed = JSON.parse(text);
		assert.deepEqual(Object.keys(parsed.repos), [...Object.keys(parsed.repos)].sort());
		assert.deepEqual(parsed.repos["github.com/o/q"], { mode: "meta" });
		assert.deepEqual(parsed.repos["github.com/o/n"], { mode: "full" });
		assert.ok(text.endsWith("\n"));
		assert.ok(text.includes("\n  \"repos\": {"), "two-space JSON");
		assert.deepEqual(fs.readdirSync(vault).filter((name) => name.startsWith(".")), [".git", ".gitignore"]);
	}),
);

test(
	"repo allow keeps a full slug and refuses a bad mode or an unusable key",
	withVault(async ({ root, vault }) => {
		assert.equal(run(root, ["repo", "allow", "github.com/o/p", "--mode", "none"], { vault }).code, 0);
		assert.deepEqual(JSON.parse(read(path.join(vault, "repos.json"))).repos["github.com/o/p"], { mode: "none" });
		assert.equal(run(root, ["repo", "allow", "github.com/o/p", "--mode", "partial"], { vault }).code, 2);
		assert.equal(run(root, ["repo", "allow", "just-a-name", "--mode", "full"], { vault }).code, 2);
		assert.equal(read(path.join(vault, "repos.json")).includes("just-a-name"), false);
	}),
);

test(
	"repo list prints every repo with its mode",
	withVault(async ({ root, vault }) => {
		const result = run(root, ["repo", "list"], { vault });
		assert.equal(result.code, 0);
		assert.match(result.out, /^github\.com\/o\/n\tfull$/m);
		assert.match(result.out, /^github\.com\/o\/m\tmeta$/m);
		assert.equal(result.out.trimEnd().split("\n").length, 3);
	}),
);

test(
	"repo check reads the working directory's repo",
	withVault(async ({ root, vault }) => {
		const full = makeProject(root, "full", "git@github.com:o/n.git");
		const fullResult = run(root, ["repo", "check"], { vault, cwd: full });
		assert.equal(fullResult.code, 0);
		assert.equal(fullResult.out, "full\n");
		for (const [name, remote] of [
			["none-mode", "git@github.com:o/x.git"],
			["unlisted", "git@github.com:o/z.git"],
			["no-origin", undefined],
		]) {
			const project = makeProject(root, name, remote);
			const result = run(root, ["repo", "check"], { vault, cwd: project });
			assert.equal(result.code, 3, name);
			assert.equal(result.out, "none\n");
		}
	}),
);

test(
	"stats prints a table and, with --json, the result object",
	withVault(async ({ root, vault }) => {
		assert.equal(run(root, ["note", "new", "run", "stat-r1-run", ...RUN_ARGS], { vault }).code, 0);
		const table = run(root, ["stats", "--repo", "github.com/o/n"], { vault });
		assert.equal(table.code, 0);
		assert.match(table.out, /^boot tokens: \d+$/m);
		assert.match(table.out, /^run: 1$/m);
		assert.match(table.out, /^repeat rate: /m);
		const json = run(root, ["stats", "--json", "--repo", "github.com/o/n"], { vault });
		assert.equal(json.code, 0);
		const body = JSON.parse(json.out);
		assert.equal(typeof body.bootTokens, "number");
		assert.equal(body.counts.run, 1);
		assert.ok("repeatRate" in body);
		assert.equal(typeof body.repeats, "number");
		const all = run(root, ["stats", "--json", "--all"], { vault });
		assert.equal(all.code, 0);
		assert.equal(JSON.parse(all.out).counts.run, 1);
	}),
);

test(
	"lint reports a clean vault and a secret with exit 1",
	withVault(async ({ root, vault }) => {
		const clean = run(root, ["lint"], { vault });
		assert.equal(clean.code, 0, clean.out);
		assert.match(clean.out, /^lint: 0 errors, \d+ info$/m);
		const secret = ["sk-", "ant-", "api03", "-abcdefghijklmnop"].join("");
		const created = run(root, ["note", "new", "lesson", "lesson-secret", "--set", "project=project-one", "--set", "repo=github.com/o/n", "--body-stdin"], {
			vault,
			input: `the key is ${secret}\n`,
		});
		assert.equal(created.code, 0, created.err);
		const dirty = run(root, ["lint"], { vault });
		assert.equal(dirty.code, 1);
		assert.match(dirty.out, /^ERROR secret lessons\/lesson-secret\.md /m);
		assert.match(dirty.out, /^lint: 1 errors, \d+ info$/m);
		const ranged = run(root, ["lint", "--range"], { vault });
		assert.ok(ranged.code === 0 || ranged.code === 1, ranged.err);
		assert.match(ranged.out, /^lint: \d+ errors, \d+ info$/m);
	}),
);

test(
	"a busy lock exits 4 and leaves a read command alone",
	withVault(async ({ root, vault }) => {
		write(vault, ".git/agent-vault.lock", `${JSON.stringify({ pid: process.pid, host: os.hostname(), started: Date.now() })}\n`);
		const started = Date.now();
		const write_ = run(root, ["note", "new", "run", "lock-r1-run", ...RUN_ARGS], { vault, env: { AGENT_VAULT_LOCK_WAIT_MS: "400" } });
		assert.equal(write_.code, 4, write_.err);
		assert.ok(Date.now() - started < 10_000, "the wait override was used instead of the default");
		assert.equal(fs.existsSync(path.join(vault, "runs", "lock-r1-run.md")), false);
		assert.equal(run(root, ["boot", "--repo", "github.com/o/n"], { vault }).code, 0);
		assert.equal(run(root, ["lint"], { vault }).code, 0);
		fs.rmSync(path.join(vault, ".git", "agent-vault.lock"));
		assert.equal(run(root, ["note", "new", "run", "lock-r1-run", ...RUN_ARGS], { vault }).code, 0);
	}),
);

test(
	"every write and sync command exits 4 on a busy lock",
	withVault(async ({ root, vault }) => {
		const findingName = `t9-f-${schema.fingerprintHash("lock-me")}`;
		const findingArgs = ["--set", "trace=t9", "--set", "repo=github.com/o/n", "--set", "severity=minor", "--set", "fingerprint=lock-me", "--set", "source=pair", "--set", "status=open"];
		assert.equal(run(root, ["note", "new", "finding", findingName, ...findingArgs], { vault }).code, 0);
		assert.equal(run(root, ["note", "new", "run", "pinned-r1-run", ...RUN_ARGS], { vault }).code, 0);
		write(vault, ".git/agent-vault.lock", `${JSON.stringify({ pid: process.pid, host: os.hostname(), started: Date.now() })}\n`);
		const commands = [
			["note", "set", "pinned-r1-run", "--set", "gate=fail"],
			["note", "status", findingName, "closed"],
			["note", "rm", "pinned-r1-run"],
			["log", "append", "--repo", "-", "held"],
			["repo", "allow", "github.com/o/p", "--mode", "full"],
			["index", "rebuild"],
			["sync", "pull"],
			["sync", "push"],
		];
		for (const command of commands) {
			const result = run(root, command, { vault, env: { AGENT_VAULT_LOCK_WAIT_MS: "250" } });
			assert.equal(result.code, 4, `${command.join(" ")}: ${result.err}`);
		}
		fs.rmSync(path.join(vault, ".git", "agent-vault.lock"));
		assert.equal(JSON.parse(read(path.join(vault, "repos.json"))).repos["github.com/o/p"], undefined);
		assert.match(read(path.join(vault, "runs", "pinned-r1-run.md")), /^gate: pass$/m);
		assert.match(read(path.join(vault, "findings", `${findingName}.md`)), /^status: open$/m);
	}),
);

test("the lock wait override accepts only a positive number", () => {
	assert.equal(lockWaitMs({ AGENT_VAULT_LOCK_WAIT_MS: "400" }), 400);
	for (const value of ["abc", "0", "-5", "", "  "]) {
		assert.equal(lockWaitMs({ AGENT_VAULT_LOCK_WAIT_MS: value }), undefined, value);
	}
	assert.equal(lockWaitMs({}), undefined);
});

test(
	"a rebase in progress refuses a write but not a read",
	withVault(async ({ root, vault }) => {
		fs.mkdirSync(path.join(vault, ".git", "rebase-merge"));
		assert.equal(run(root, ["log", "append", "--repo", "-", "x"], { vault }).code, 2);
		assert.equal(run(root, ["note", "new", "run", "rebase-r1-run", ...RUN_ARGS], { vault }).code, 2);
		assert.equal(run(root, ["boot", "--repo", "github.com/o/n"], { vault }).code, 0);
		fs.rmdirSync(path.join(vault, ".git", "rebase-merge"));
		fs.mkdirSync(path.join(vault, ".git", "rebase-apply"));
		assert.equal(run(root, ["index", "rebuild"], { vault }).code, 2);
		fs.rmdirSync(path.join(vault, ".git", "rebase-apply"));
		assert.equal(run(root, ["index", "rebuild"], { vault }).code, 0);
	}),
);

test(
	"a vault schema newer than the CLI refuses a write but not a read",
	withVault(async ({ root, vault }) => {
		write(vault, "harness.json", `${JSON.stringify({ schema: schema.SCHEMA_VERSION + 1 })}\n`);
		const refused = run(root, ["log", "append", "--repo", "-", "x"], { vault });
		assert.equal(refused.code, 2);
		assert.match(refused.err, /schema/);
		assert.equal(run(root, ["boot", "--repo", "github.com/o/n"], { vault }).code, 0);
		assert.equal(read(path.join(vault, "log.md")), "");
	}),
);

test(
	"a symlinked folder that points out of the vault is refused before the lock",
	withVault(async ({ root, vault }) => {
		const outside = path.join(root, "outside");
		fs.mkdirSync(outside, { recursive: true });
		fs.rmSync(path.join(vault, "lessons"), { recursive: true, force: true });
		fs.symlinkSync(outside, path.join(vault, "lessons"), "dir");
		write(vault, ".git/agent-vault.lock", `${JSON.stringify({ pid: process.pid, host: os.hostname(), started: Date.now() })}\n`);
		const result = run(root, ["note", "new", "lesson", "lesson-escape", "--set", "project=project-one", "--set", "repo=github.com/o/n"], {
			vault,
			env: { AGENT_VAULT_LOCK_WAIT_MS: "300" },
		});
		assert.equal(result.code, 2, "the containment check comes before the lock, so not exit 4");
		assert.match(result.err, /outside the vault/);
		assert.deepEqual(fs.readdirSync(outside), []);
	}),
);

test(
	"sync push checks the summary before the lock and pushes",
	withVault(async ({ root, vault }) => {
		const bare = path.join(root, "bare.git");
		execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare], { env: { ...process.env, ...GIT_ENV }, encoding: "utf8" });
		git(vault, ["remote", "add", "origin", bare]);
		// A push only commits when a managed file changed.
		assert.equal(run(root, ["note", "new", "run", "sync-r1-run", ...RUN_ARGS], { vault }).code, 0);
		write(vault, ".git/agent-vault.lock", `${JSON.stringify({ pid: process.pid, host: os.hostname(), started: Date.now() })}\n`);
		const leaking = run(root, ["sync", "push", "--summary", "about github.com/o/x"], { vault, env: { AGENT_VAULT_LOCK_WAIT_MS: "300" } });
		assert.equal(leaking.code, 2, "the summary is refused before the lock is tried");
		const locked = run(root, ["sync", "push", "--summary", "fine"], { vault, env: { AGENT_VAULT_LOCK_WAIT_MS: "300" } });
		assert.equal(locked.code, 4);
		fs.rmSync(path.join(vault, ".git", "agent-vault.lock"));
		const pushed = run(root, ["sync", "push", "--summary", "from cli", "--trace", "s1", "--root", path.join(root, "events")], { vault });
		assert.equal(pushed.code, 0, pushed.err);
		assert.equal(pushed.out, "pushed\n");
		assert.equal(git(bare, ["log", "-1", "--pretty=%s"]).trim(), "vault: from cli [trace s1]");
		const [recorded] = events(root, "s1");
		assert.equal(recorded.kind, "vault.sync");
		assert.equal(recorded.data.op, "push");
		assert.equal(recorded.data.result.code, 0);
		const pulled = run(root, ["sync", "pull"], { vault });
		assert.equal(pulled.code, 0, pulled.err);
		assert.equal(pulled.out, "pulled\n");
	}),
);

test(
	"sync pull without a remote exits 1",
	withVault(async ({ root, vault }) => {
		const result = run(root, ["sync", "pull"], { vault });
		assert.equal(result.code, 1);
		assert.equal(result.out, "no remote configured\n");
	}),
);

test(
	"a write records a vault.write event and keeps events out of the vault",
	withVault(async ({ root, vault }) => {
		const result = run(root, ["log", "append", "--repo", "-", "--trace", "tr1", "--root", path.join(root, "events"), "notes", "written"], { vault });
		assert.equal(result.code, 0, result.err);
		const recorded = events(root, "tr1");
		assert.equal(recorded.length, 1);
		assert.equal(recorded[0].actor, "vault");
		assert.equal(recorded[0].trace, "tr1");
		assert.equal(recorded[0].kind, "vault.write");
		assert.deepEqual(recorded[0].data, { type: "log", id: "tr1", op: "append" });
		assert.equal(fs.existsSync(path.join(vault, ".plans")), false);
	}),
);

test("a missing event root or trace is a silent no-op", () =>
	withRoot(async ({ root }) => {
		const vault = makeVault(root);
		assert.equal(run(root, ["log", "append", "--repo", "-", "--root", path.join(root, "events"), "no", "trace"], { vault }).code, 0);
		assert.equal(fs.existsSync(path.join(root, "events", ".plans")), false);
		assert.equal(run(root, ["log", "append", "--repo", "-", "--trace", "t2", "no", "root"], { vault }).code, 0);
		assert.equal(fs.existsSync(path.join(vault, ".plans")), false);
	})());

test("when no dispatcher is found the CLI prints where it looked", () =>
	withRoot(async ({ root }) => {
		const env = cliEnv(root, path.join(root, "vault"));
		delete env.PI_PLAN_DISPATCH_DIR;
		const result = spawnSync(process.execPath, [cli, "resolve"], { env, cwd: root, encoding: "utf8" });
		assert.equal(result.status, 2);
		assert.match(result.stderr, /cannot find the pi-plan-dispatch modules/);
		assert.ok(result.stderr.includes(path.join(root, "pi-plan-dispatch")), result.stderr);
	})());

test("parseArgs takes flags anywhere and collects --set", () => {
	const parsed = parseArgs(["note", "--set", "a=1", "new", "run", "x", "--set", "b=2", "--json"]);
	assert.deepEqual(parsed.positionals, ["note", "new", "run", "x"]);
	assert.deepEqual(parsed.flags.sets, ["a=1", "b=2"]);
	assert.equal(parsed.flags.json, true);
	assert.deepEqual(parseArgs(["resolve", "--nope"]), { error: "unknown flag: --nope" });
	assert.deepEqual(parseArgs(["resolve", "--vault"]), { error: "--vault needs a value" });
});

/* The work, restore and config commands: fixtures and helpers. */

const FULL_REMOTE = "git@github.com:o/n.git";

/** A finished trace with its plan results, the record `work add` copies. */
function makeTrace(project, trace) {
	const plan = `${trace}-r1`;
	const lines = [
		{ ts: "2026-10-23T10:00:00.000Z", actor: "pi-dispatch", kind: "task.start", plan },
		{ ts: "2026-10-23T10:05:00.000Z", actor: "pi-dispatch", kind: "plan.end", plan },
	];
	write(project, `.plans/traces/${trace}.jsonl`, `${lines.map((line) => `${JSON.stringify(line)}\n`).join("")}`);
	write(project, `.plans/traces/${trace}.md`, `# ${trace}\n`);
	write(project, `.plans/done/${plan}/_summary.md`, "gate: pass\n");
	write(project, `.plans/done/${plan}/evidence.json`, "{}\n");
	write(project, `.plans/done/${plan}/task-a.md`, "task a done\n");
	write(project, `.plans/done/${plan}/task-a.prompt.md`, "the prompt, never copied\n");
	write(project, `.plans/running/${plan}/state.json`, "{}\n");
	write(project, `.plans/inbox/${plan}.md`, "a plan body\n");
	return plan;
}

/** The JSON lines of a trace file of a folder that holds `.plans` itself. */
function traceEvents(dir, trace) {
	const file = path.join(dir, ".plans", "traces", `${trace}.jsonl`);
	if (!fs.existsSync(file)) return [];
	return read(file)
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line));
}

/** A finished trace stored in the vault, minus its vault lines, computed here again. */
function expectedTraceCopy(project, trace) {
	return traceEvents(project, trace)
		.filter((event) => event.actor !== "vault")
		.map((event) => `${JSON.stringify(event)}\n`)
		.join("");
}

/** A secret built from parts, so no secret pattern sits in this file itself. */
function testSecret() {
	return `${["sk", "ant"].join("-")}-${"z".repeat(30)}`;
}

test(
	"work add copies a finished request and work pending stops listing it",
	withVault(async ({ root, vault }) => {
		const project = makeProject(root, "project", FULL_REMOTE);
		makeTrace(project, "t-one");
		write(project, ".plans/tools/probe-check.mjs", "console.log(1);\n");
		write(project, ".plans/tools/notes.txt", "not a probe\n");

		const listed = run(root, ["work", "pending", "--root", project], { vault });
		assert.equal(listed.code, 0, listed.err);
		assert.equal(listed.out, "pending t-one\n");
		assert.equal(fs.existsSync(path.join(vault, "work")), false, "work pending writes nothing");

		const added = run(root, ["work", "add", "--trace", "t-one", "--root", project], { vault });
		assert.equal(added.code, 0, added.err);
		assert.equal(added.out, "work add: 5 copied, 0 unchanged, 0 unmirrored\n");
		const work = path.join(vault, "work", "t-one");
		for (const relative of ["trace.jsonl", "trace.md", "t-one-r1/_summary.md", "t-one-r1/evidence.json", "t-one-r1/task-a.md"]) {
			assert.ok(fs.existsSync(path.join(work, ...relative.split("/"))), relative);
		}
		assert.equal(fs.existsSync(path.join(work, "t-one-r1", "task-a.prompt.md")), false, "a prompt is never copied");
		assert.equal(fs.existsSync(path.join(work, "probes")), false, "probes need --probes");
		assert.equal(read(path.join(work, "trace.jsonl")), expectedTraceCopy(project, "t-one"));
		assert.equal(read(path.join(work, "trace.jsonl")).includes("vault.work"), false, "the copy never holds its own event");
		assert.equal(read(path.join(work, "trace.md")), "# t-one\n");

		const recorded = traceEvents(project, "t-one").filter((event) => event.kind === "vault.work");
		assert.equal(recorded.length, 1, "the event landed in the local trace of --trace");
		assert.equal(recorded[0].actor, "vault");
		assert.deepEqual(recorded[0].data, { op: "add", trace: "t-one", files: 5, unmirrored: 0 });

		const after = run(root, ["work", "pending", "--root", project], { vault });
		assert.equal(after.code, 0);
		assert.equal(after.out, "");

		const again = run(root, ["work", "add", "--trace", "t-one", "--root", project], { vault });
		assert.equal(again.code, 0, again.err);
		assert.equal(again.out, "work add: 0 copied, 5 unchanged, 0 unmirrored\n", "a second run changes nothing");

		const withProbes = run(root, ["work", "add", "--trace", "t-one", "--root", project, "--probes"], { vault });
		assert.equal(withProbes.code, 0, withProbes.err);
		assert.equal(withProbes.out, "work add: 1 copied, 5 unchanged, 0 unmirrored\n");
		assert.equal(read(path.join(work, "probes", "probe-check.mjs")), "console.log(1);\n");
		assert.equal(fs.existsSync(path.join(work, "probes", "notes.txt")), false);
	}),
);

test(
	"work add leaves a secret and a none-repo name unmirrored and exits 6",
	withVault(async ({ root, vault }) => {
		const project = makeProject(root, "project", FULL_REMOTE);
		const plan = makeTrace(project, "t-two");
		write(project, `.plans/done/${plan}/leaky.md`, `the key is ${testSecret()}\n`);
		write(project, `.plans/done/${plan}/named.md`, "this mentions github.com/o/x in passing\n");
		const result = run(root, ["work", "add", "--trace", "t-two", "--root", project], { vault });
		assert.equal(result.code, 6, result.err);
		assert.match(result.err, new RegExp(`^unmirrored \\.plans/done/${plan}/leaky\\.md: secret pattern: [a-z-]+$`, "m"));
		assert.match(result.err, new RegExp(`^unmirrored \\.plans/done/${plan}/named\\.md: names a repo that is not allowed$`, "m"));
		assert.equal(result.err.includes("github.com/o/x"), false, "the message never names the repo");
		assert.equal(result.err.includes(root), false, "the message never carries the checkout path");
		const work = path.join(vault, "work", "t-two");
		assert.equal(fs.existsSync(path.join(work, plan, "leaky.md")), false);
		assert.equal(fs.existsSync(path.join(work, plan, "named.md")), false);
		assert.equal(fs.existsSync(path.join(work, plan, "_summary.md")), true, "the rest is copied");
		const recorded = traceEvents(project, "t-two").filter((event) => event.kind === "vault.work");
		assert.deepEqual(recorded[0].data, { op: "add", trace: "t-two", files: 5, unmirrored: 2 });
	}),
);

test(
	"work add copies nothing for a meta repo and exits 3 for a none repo",
	withVault(async ({ root, vault }) => {
		const meta = makeProject(root, "meta", "git@github.com:o/m.git");
		makeTrace(meta, "t-meta");
		const metaResult = run(root, ["work", "add", "--trace", "t-meta", "--root", meta], { vault });
		assert.equal(metaResult.code, 0, metaResult.err);
		assert.equal(metaResult.out, "work add: a meta repo copies no work files\n");
		assert.equal(run(root, ["work", "pending", "--root", meta], { vault }).out, "");

		const none = makeProject(root, "none", "git@github.com:o/x.git");
		makeTrace(none, "t-none");
		const noneResult = run(root, ["work", "add", "--trace", "t-none", "--root", none], { vault });
		assert.equal(noneResult.code, 3, noneResult.err);
		assert.equal(noneResult.err.includes("github.com/o/x"), false);
		assert.equal(run(root, ["work", "pending", "--root", none], { vault }).out, "");
		assert.equal(fs.existsSync(path.join(vault, "work")), false);
	}),
);

test(
	"the work, restore and config commands reject a missing required flag and a flag they do not take",
	withVault(async ({ root, vault }) => {
		const project = makeProject(root, "project", FULL_REMOTE);
		const cases = [
			["work", "add", "--root", project],
			["work", "add", "--trace", "t-one"],
			["work", "pending"],
			["restore"],
			["config", "push"],
			["config", "pull"],
			["work", "pending", "--root", project, "--probes"],
			["restore", "--root", project, "--probes"],
			["config", "push", "--root", project, "--force"],
			["work", "add", "--trace", "t-one", "--root", project, "--force"],
		];
		for (const args of cases) {
			const result = run(root, args, { vault });
			assert.equal(result.code, 64, `${args.join(" ")}: ${result.err}`);
			assert.match(result.err, /usage: node vault\.mjs/);
			assert.equal(result.out, "");
		}
	}),
);

test(
	"a Pi worker is refused the work, restore and config commands",
	withVault(async ({ root, vault }) => {
		const project = makeProject(root, "project", FULL_REMOTE);
		for (const args of [
			["work", "add", "--trace", "t-one", "--root", project],
			["work", "pending", "--root", project],
			["restore", "--root", project],
			["config", "push", "--root", project],
			["config", "pull", "--root", project],
		]) {
			const result = run(root, args, { vault, env: { PI_PLAN_DISPATCH_WORKER: "1" } });
			assert.equal(result.code, 2, args.join(" "));
			assert.match(result.err, /PI_PLAN_DISPATCH_WORKER/);
		}
		assert.equal(fs.existsSync(path.join(vault, "work")), false);
	}),
);

test(
	"work add and config push take the lock and refuse a rebase while restore and config pull carry on",
	withVault(async ({ root, vault }) => {
		const project = makeProject(root, "project", FULL_REMOTE);
		makeTrace(project, "t-lock");
		write(project, ".plans/config.json", `${JSON.stringify({ autoReady: false })}\n`);
		assert.equal(run(root, ["config", "push", "--root", project], { vault }).code, 0);

		write(vault, ".git/agent-vault.lock", `${JSON.stringify({ pid: process.pid, host: os.hostname(), started: Date.now() })}\n`);
		const wait = { AGENT_VAULT_LOCK_WAIT_MS: "300" };
		for (const args of [["work", "add", "--trace", "t-lock", "--root", project], ["config", "push", "--root", project]]) {
			const result = run(root, args, { vault, env: wait });
			assert.equal(result.code, 4, `${args.join(" ")}: ${result.err}`);
		}
		assert.equal(run(root, ["restore", "--root", project], { vault }).code, 0, "restore takes no lock");
		assert.equal(run(root, ["config", "pull", "--root", project], { vault }).code, 0, "config pull takes no lock");
		assert.equal(fs.existsSync(path.join(vault, "work", "t-lock")), false);
		fs.rmSync(path.join(vault, ".git", "agent-vault.lock"));

		fs.mkdirSync(path.join(vault, ".git", "rebase-merge"));
		for (const args of [["work", "add", "--trace", "t-lock", "--root", project], ["config", "push", "--root", project]]) {
			const result = run(root, args, { vault });
			assert.equal(result.code, 2, `${args.join(" ")}: ${result.err}`);
			assert.match(result.err, /rebase in progress/);
		}
		assert.equal(run(root, ["work", "pending", "--root", project], { vault }).code, 0);
		assert.equal(run(root, ["restore", "--root", project], { vault }).code, 0);
		assert.equal(run(root, ["config", "pull", "--root", project], { vault }).code, 0);
		fs.rmdirSync(path.join(vault, ".git", "rebase-merge"));
		assert.equal(run(root, ["work", "add", "--trace", "t-lock", "--root", project], { vault }).code, 0);
	}),
);

test(
	"restore rebuilds a spec and a draft plan from the vault",
	withVault(async ({ root, vault }) => {
		const project = makeProject(root, "project", FULL_REMOTE);
		fs.mkdirSync(path.join(project, ".plans"));
		const spec = run(
			root,
			["note", "new", "spec", "t-one-spec", "--set", "trace=t-one", "--set", "repo=github.com/o/n", "--set", "status=confirmed", "--set", "file=t-one.md", "--body-stdin"],
			{ vault, input: "the spec text\n" },
		);
		assert.equal(spec.code, 0, spec.err);
		const planBody = "---\nid: t-one-r1\nstatus: ready\nround: 1\n---\n\nthe plan body\n";
		const plan = run(
			root,
			["note", "new", "plan", "t-one-r1", "--set", "trace=t-one", "--set", "round=1", "--set", "repo=github.com/o/n", "--set", "status=ready", "--set", "file=t-one-r1.md", "--body-stdin"],
			{ vault, input: planBody },
		);
		assert.equal(plan.code, 0, plan.err);

		const result = run(root, ["restore", "--root", project, "--trace", "rs1"], { vault });
		assert.equal(result.code, 0, result.err);
		assert.match(result.out, /^restored \.plans\/specs\/t-one\.md$/m);
		assert.match(result.out, /^restored \.plans\/inbox\/t-one-r1\.md\.draft$/m);
		assert.equal(read(path.join(project, ".plans", "specs", "t-one.md")), "the spec text\n");
		const restored = read(path.join(project, ".plans", "inbox", "t-one-r1.md.draft"));
		assert.match(restored, /^status: draft$/m);
		assert.ok(restored.includes("the plan body"), restored);
		assert.equal(fs.existsSync(path.join(project, ".plans", "inbox", "t-one-r1.md")), false, "never a ready plan");

		const recorded = traceEvents(project, "rs1").filter((event) => event.kind === "vault.restore");
		assert.equal(recorded.length, 1);
		assert.deepEqual(recorded[0].data, { restored: 2, skipped: 0 });

		const again = run(root, ["restore", "--root", project], { vault });
		assert.equal(again.code, 0, again.err);
		assert.match(again.out, /^skipped \.plans\/specs\/t-one\.md: exists$/m);
		assert.equal(read(path.join(project, ".plans", "specs", "t-one.md")), "the spec text\n", "restore never overwrites");
	}),
);

test(
	"config push and config pull round trip the dispatcher config",
	withVault(async ({ root, vault }) => {
		const project = makeProject(root, "project", FULL_REMOTE);
		write(project, ".plans/config.json", "{\n  \"autoReady\": false\n}\n");
		const pushed = run(root, ["config", "push", "--root", project, "--trace", "c1"], { vault });
		assert.equal(pushed.code, 0, pushed.err);
		assert.equal(pushed.out, "config push: pushed\n");
		const stored = path.join(vault, "config", "dispatch.json");
		assert.equal(read(stored), "{\n  \"autoReady\": false\n}\n");
		const pushedEvent = traceEvents(project, "c1").filter((event) => event.kind === "vault.config");
		assert.deepEqual(pushedEvent[0].data, { op: "push", result: "pushed" });

		const unchanged = run(root, ["config", "push", "--root", project], { vault });
		assert.equal(unchanged.code, 0);
		assert.equal(unchanged.out, "config push: unchanged\n");

		fs.rmSync(path.join(project, ".plans", "config.json"));
		const pulled = run(root, ["config", "pull", "--root", project, "--trace", "c2"], { vault });
		assert.equal(pulled.code, 0, pulled.err);
		assert.equal(pulled.out, "config pull: pulled\n");
		assert.equal(read(path.join(project, ".plans", "config.json")), "{\n  \"autoReady\": false\n}\n");
		const pulledEvent = traceEvents(project, "c2").filter((event) => event.kind === "vault.config");
		assert.deepEqual(pulledEvent[0].data, { op: "pull", result: "pulled" });

		write(project, ".plans/config.json", "{\n  \"autoReady\": true\n}\n");
		const kept = run(root, ["config", "pull", "--root", project], { vault });
		assert.equal(kept.code, 0);
		assert.equal(kept.out, "config pull: kept the local file (use --force to replace it)\n");
		assert.match(read(path.join(project, ".plans", "config.json")), /"autoReady": true/);
		const forced = run(root, ["config", "pull", "--root", project, "--force"], { vault });
		assert.equal(forced.code, 0);
		assert.equal(forced.out, "config pull: pulled\n");
		assert.match(read(path.join(project, ".plans", "config.json")), /"autoReady": false/);
	}),
);

test(
	"config push refuses a missing file, invalid JSON and a secret",
	withVault(async ({ root, vault }) => {
		const project = makeProject(root, "project", FULL_REMOTE);
		const stored = path.join(vault, "config", "dispatch.json");
		const missing = run(root, ["config", "push", "--root", project], { vault });
		assert.equal(missing.code, 1);
		assert.match(missing.err, /\.plans\/config\.json does not exist/);
		write(project, ".plans/config.json", "{not json\n");
		const invalid = run(root, ["config", "push", "--root", project], { vault });
		assert.equal(invalid.code, 2);
		assert.match(invalid.err, /not a JSON object/);
		write(project, ".plans/config.json", `${JSON.stringify({ token: testSecret() })}\n`);
		const secret = run(root, ["config", "push", "--root", project], { vault });
		assert.equal(secret.code, 2);
		assert.match(secret.err, /secret/);
		assert.equal(fs.existsSync(stored), false);
	}),
);

test(
	"note status changes an idea and keeps its own type",
	withVault(async ({ root, vault }) => {
		const created = run(root, ["note", "new", "idea", "idea-pair-mode", "--set", "status=open", "--set", "repo=github.com/o/n", "--body-stdin"], {
			vault,
			input: "try pair review\n",
		});
		assert.equal(created.code, 0, created.err);
		const file = path.join(vault, "ideas", "idea-pair-mode.md");
		const taken = run(root, ["note", "status", "idea-pair-mode", "taken"], { vault });
		assert.equal(taken.code, 0, taken.err);
		assert.match(read(file), /^status: taken$/m);
		assert.match(read(file), /^type: idea$/m);
		assert.match(read(file), /^repo: github\.com\/o\/n$/m);
		assert.ok(read(file).includes("try pair review"), "the body survives a status change");
		assert.equal(run(root, ["note", "status", "idea-pair-mode", "dropped"], { vault }).code, 0);
		assert.match(read(file), /^status: dropped$/m);

		const badValue = run(root, ["note", "status", "idea-pair-mode", "closed"], { vault });
		assert.equal(badValue.code, 2);
		assert.match(badValue.err, /status works on finding notes \(open, closed\) and idea notes \(open, taken, dropped\)/);
		assert.match(read(file), /^status: dropped$/m, "a refused value writes nothing");

		const decision = run(root, ["note", "new", "decision", "decision-three", "--set", "project=project-one", "--set", "repo=github.com/o/n"], { vault });
		assert.equal(decision.code, 0, decision.err);
		assert.equal(run(root, ["note", "status", "decision-three", "taken"], { vault }).code, 2);
	}),
);

test(
	"stats prints the work folder size between the type counts and the repeats",
	withVault(async ({ root, vault }) => {
		const empty = run(root, ["stats", "--repo", "github.com/o/n"], { vault });
		assert.equal(empty.code, 0, empty.err);
		assert.match(empty.out, /^work: 0 files, 0 bytes$/m);
		assert.ok(empty.out.indexOf("work: 0 files, 0 bytes") > empty.out.indexOf("idea: 0"), "after the type counts");
		assert.ok(empty.out.indexOf("work: 0 files, 0 bytes") < empty.out.indexOf("repeats:"), "before the repeats");

		write(vault, "work/t-one/trace.jsonl", "abcde");
		const table = run(root, ["stats", "--repo", "github.com/o/n"], { vault });
		assert.equal(table.code, 0, table.err);
		assert.match(table.out, /^work: 1 files, 5 bytes$/m);
		const json = run(root, ["stats", "--json", "--repo", "github.com/o/n"], { vault });
		assert.equal(json.code, 0);
		const body = JSON.parse(json.out);
		assert.equal(body.workFiles, 1);
		assert.equal(body.workBytes, 5);
	}),
);
