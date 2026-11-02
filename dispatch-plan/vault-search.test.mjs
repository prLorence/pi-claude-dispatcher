/** Run with: node --test --test-force-exit dispatch-plan/vault-search.test.mjs (Node 24+) */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

const cli = path.join(import.meta.dirname, "vault.mjs");
const dispatcher = path.resolve(import.meta.dirname, "..", "pi-plan-dispatch");
const BUILD_HINT = "Fix: go build -C dispatch-plan/vault-search -o ../bin/vault-search .";

const FAKE_BIN = `#!/usr/bin/env node
import * as fs from "node:fs";
const args = process.argv.slice(2);
const record = process.env.FAKE_ARGV;
if (record) fs.appendFileSync(record, args.join("\\n") + "\\n---\\n");
const at = args.indexOf("--");
const query = at === -1 ? "" : args.slice(at + 1).join(" ");
const resultsFile = process.env.FAKE_RESULTS;
let raw = [];
if (resultsFile && fs.existsSync(resultsFile)) raw = JSON.parse(fs.readFileSync(resultsFile, "utf8"));
const hits = Array.isArray(raw) ? raw : (raw[query] ?? []);
process.stdout.write(JSON.stringify(hits));
`;

const FAILING_BIN = `#!/usr/bin/env node
process.stderr.write("fake search failed\\n");
process.exit(3);
`;

/** A child environment with a temp HOME, no worker flag and no inherited vault. */
function cliEnv(root) {
	const home = path.join(root, "home");
	fs.mkdirSync(home, { recursive: true });
	const env = { ...process.env, HOME: home, PI_PLAN_DISPATCH_DIR: dispatcher };
	delete env.PI_PLAN_DISPATCH_WORKER;
	delete env.AGENT_VAULT;
	delete env.AGENT_VAULT_LOCK_WAIT_MS;
	delete env.PI_PLAN_DISPATCH_HARNESS;
	delete env.VAULT_SEARCH_BIN;
	delete env.FAKE_ARGV;
	delete env.FAKE_RESULTS;
	return env;
}

function write(dir, name, text) {
	const file = path.join(dir, name);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
	return file;
}

function writeExec(dir, name, text) {
	const file = write(dir, name, text);
	fs.chmodSync(file, 0o755);
	return file;
}

/** A vault with the template shape, two allowed repos and one decision note. */
function makeVault(root) {
	const vault = path.join(root, "vault");
	fs.mkdirSync(vault, { recursive: true });
	for (const folder of ["plans", "runs", "findings", "decisions", "lessons", "projects", "codebases", "specs", "ideas"]) {
		write(vault, path.join(folder, ".gitkeep"), "");
	}
	write(vault, "CLAUDE.md", "# Schema\nRules for agents.\n");
	write(vault, "log.md", "");
	write(
		vault,
		"repos.json",
		`${JSON.stringify({ repos: { "github.com/o/r": { mode: "full" }, "github.com/o/m": { mode: "meta" } }, aliases: {} }, null, 2)}\n`,
	);
	write(vault, "harness.json", `${JSON.stringify({ schema: 1, boot_budget_tokens: 4000 })}\n`);
	write(
		vault,
		"decisions/decision-alpha.md",
		"---\ntype: decision\nrepo: github.com/o/r\nstatus: active\n---\nAlpha decision body\n",
	);
	return vault;
}

function makeFakes(root) {
	const dir = path.join(root, "fakes");
	fs.mkdirSync(dir, { recursive: true });
	const fake = writeExec(dir, "fake-vault-search.mjs", FAKE_BIN);
	const failing = writeExec(dir, "failing-vault-search.mjs", FAILING_BIN);
	return { dir, fake, failing };
}

function run(root, args, opts = {}) {
	const env = { ...cliEnv(root), ...opts.env };
	if (opts.vault !== undefined) env.AGENT_VAULT = opts.vault;
	const result = spawnSync(process.execPath, [cli, ...args], {
		env,
		cwd: opts.cwd ?? root,
		encoding: "utf8",
		timeout: 60_000,
	});
	return { code: result.status, out: result.stdout, err: result.stderr };
}

function recorded(file) {
	if (!fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, "utf8")
		.split("---\n")
		.filter((chunk) => chunk.trim() !== "")
		.map((chunk) => chunk.slice(0, -1).split("\n"));
}

function events(root, trace) {
	const file = path.join(root, "events", ".plans", "traces", `${trace}.jsonl`);
	if (!fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line));
}

/** A fresh temp root per test, removed even when the body throws. */
function withRoot(body) {
	return async () => {
		const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vault-search-")));
		try {
			await body({ root });
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	};
}

test(
	"search passes an argument array, never a shell string",
	withRoot(async ({ root }) => {
		const vault = makeVault(root);
		const fakes = makeFakes(root);
		const argvFile = path.join(root, "argv.txt");
		const env = { VAULT_SEARCH_BIN: fakes.fake, FAKE_ARGV: argvFile };

		const plain = run(root, ["search", "alpha", "beta", "--repo", "github.com/o/r"], { vault, env });
		assert.equal(plain.code, 0, plain.err);
		const wide = run(
			root,
			[
				"search",
				"alpha beta",
				"--repo",
				"github.com/o/r",
				"--all",
				"--status",
				"any",
				"--include-work",
				"--limit",
				"3",
			],
			{ vault, env },
		);
		assert.equal(wide.code, 0, wide.err);
		const global = run(root, ["search", "alpha", "--all"], { vault, env });
		assert.equal(global.code, 0, global.err);

		const calls = recorded(argvFile);
		assert.equal(calls.length, 3);
		assert.deepEqual(calls[0], ["--json", "--vault", vault, "--repo", "github.com/o/r", "--", "alpha beta"]);
		assert.deepEqual(calls[1], [
			"--json",
			"--vault",
			vault,
			"--repo",
			"github.com/o/r",
			"--all",
			"--status",
			"any",
			"--include-work",
			"--limit",
			"3",
			"--",
			"alpha beta",
		]);
		assert.deepEqual(calls[2], ["--json", "--vault", vault, "--all", "--", "alpha"]);
	}),
);

test(
	"search prints text blocks or the JSON array",
	withRoot(async ({ root }) => {
		const vault = makeVault(root);
		const fakes = makeFakes(root);
		const results = path.join(root, "results.json");
		const hits = [
			{
				basename: "decision-alpha",
				type: "decision",
				repo: "github.com/o/r",
				status: "active",
				score: 1.23456,
				snippet: ["first line", "second line"],
			},
		];
		write(root, "results.json", JSON.stringify({ alpha: hits }));
		const env = { VAULT_SEARCH_BIN: fakes.fake, FAKE_RESULTS: results };

		const text = run(root, ["search", "alpha", "--repo", "github.com/o/r"], { vault, env });
		assert.equal(text.code, 0, text.err);
		assert.equal(
			text.out,
			"decision-alpha | decision | github.com/o/r | active | 1.235\n  first line\n  second line\n",
		);

		const json = run(root, ["search", "alpha", "--repo", "github.com/o/r", "--json"], { vault, env });
		assert.equal(json.code, 0, json.err);
		assert.deepEqual(JSON.parse(json.out), hits);
	}),
);

test(
	"search with no hits exits 0 and prints nothing in text mode",
	withRoot(async ({ root }) => {
		const vault = makeVault(root);
		const fakes = makeFakes(root);
		const results = path.join(root, "results.json");
		write(root, "results.json", JSON.stringify({}));
		const env = { VAULT_SEARCH_BIN: fakes.fake, FAKE_RESULTS: results };

		const text = run(root, ["search", "nothing"], { vault, env });
		assert.equal(text.code, 0, text.err);
		assert.equal(text.out, "");

		const json = run(root, ["search", "nothing", "--json"], { vault, env });
		assert.equal(json.code, 0, json.err);
		assert.equal(json.out, "[]\n");
	}),
);

test(
	"search names the missing binary and how to build it",
	withRoot(async ({ root }) => {
		const vault = makeVault(root);
		const missing = path.join(root, "bin", "vault-search");
		const result = run(root, ["search", "alpha"], { vault, env: { VAULT_SEARCH_BIN: missing } });
		assert.equal(result.code, 1);
		assert.equal(result.out, "");
		assert.ok(result.err.includes(`vault-search not found at ${missing}. ${BUILD_HINT}`), result.err);
	}),
);

test(
	"search reports a failing binary and exits 1",
	withRoot(async ({ root }) => {
		const vault = makeVault(root);
		const fakes = makeFakes(root);
		const result = run(root, ["search", "alpha"], { vault, env: { VAULT_SEARCH_BIN: fakes.failing } });
		assert.equal(result.code, 1);
		assert.equal(result.out, "");
		assert.match(result.err, /fake search failed/);
		assert.ok(result.err.includes(BUILD_HINT), result.err);
	}),
);

test(
	"search emits the query text only for a full repo",
	withRoot(async ({ root }) => {
		const vault = makeVault(root);
		const fakes = makeFakes(root);
		const env = { VAULT_SEARCH_BIN: fakes.fake };

		const full = run(root, ["search", "alpha beta", "--repo", "github.com/o/r", "--root", path.join(root, "events"), "--trace", "t1"], { vault, env });
		assert.equal(full.code, 0, full.err);
		const [fullEvent] = events(root, "t1");
		assert.equal(fullEvent.kind, "vault.search");
		assert.equal(fullEvent.data.query, "alpha beta");
		assert.equal(fullEvent.data.query_len, "alpha beta".length);
		assert.equal(fullEvent.data.results, 0);
		assert.equal(fullEvent.data.all, false);
		assert.equal(fullEvent.data.status, "active");
		assert.equal(fullEvent.data.include_work, false);
		assert.equal(fullEvent.data.limit, 5);

		const meta = run(root, ["search", "alpha beta", "--repo", "github.com/o/m", "--root", path.join(root, "events"), "--trace", "t2"], { vault, env });
		assert.equal(meta.code, 0, meta.err);
		const [metaEvent] = events(root, "t2");
		assert.equal(metaEvent.kind, "vault.search");
		assert.equal("query" in metaEvent.data, false);
		assert.equal(metaEvent.data.query_len, "alpha beta".length);
	}),
);

test(
	"search keeps a none repo's slug out of the trace event",
	withRoot(async ({ root }) => {
		const vault = makeVault(root);
		const fakes = makeFakes(root);
		const reposFile = path.join(vault, "repos.json");
		const repos = JSON.parse(fs.readFileSync(reposFile, "utf8"));
		repos.repos["github.com/o/secret"] = { mode: "none" };
		write(vault, "repos.json", `${JSON.stringify(repos, null, 2)}\n`);
		const env = { VAULT_SEARCH_BIN: fakes.fake };
		const traceRoot = path.join(root, "events");

		const hidden = run(
			root,
			["search", "github.com/o/secret", "--repo", "github.com/o/r", "--root", traceRoot, "--trace", "t3"],
			{ vault, env },
		);
		assert.equal(hidden.code, 0, hidden.err);
		const traceFile = path.join(traceRoot, ".plans", "traces", "t3.jsonl");
		assert.equal(fs.readFileSync(traceFile, "utf8").includes("github.com/o/secret"), false, "the slug is not in the trace");
		const [hiddenEvent] = events(root, "t3");
		assert.equal(hiddenEvent.kind, "vault.search");
		assert.equal("query" in hiddenEvent.data, false);
		assert.equal(hiddenEvent.data.query_len, "github.com/o/secret".length);

		const ordinary = run(
			root,
			["search", "alpha beta", "--repo", "github.com/o/r", "--root", traceRoot, "--trace", "t4"],
			{ vault, env },
		);
		assert.equal(ordinary.code, 0, ordinary.err);
		const [ordinaryEvent] = events(root, "t4");
		assert.equal(ordinaryEvent.data.query, "alpha beta");

		const meta = run(
			root,
			["search", "alpha beta", "--repo", "github.com/o/m", "--root", traceRoot, "--trace", "t5"],
			{ vault, env },
		);
		assert.equal(meta.code, 0, meta.err);
		const [metaEvent] = events(root, "t5");
		assert.equal("query" in metaEvent.data, false);
	}),
);

test(
	"a query with shell characters reaches the binary as one intact argument",
	withRoot(async ({ root }) => {
		const vault = makeVault(root);
		const fakes = makeFakes(root);
		const argvFile = path.join(root, "argv.txt");
		const query = '"$(rm -rf /)" ; echo hi';
		const result = run(root, ["search", query], {
			vault,
			env: { VAULT_SEARCH_BIN: fakes.fake, FAKE_ARGV: argvFile },
		});
		assert.equal(result.code, 0, result.err);
		const calls = recorded(argvFile);
		assert.equal(calls.length, 1);
		const args = calls[0];
		assert.equal(args[args.length - 1], query);
		assert.equal(args[args.length - 2], "--");
	}),
);

test(
	"a bad --status and a bad --limit are rejected before the binary runs",
	withRoot(async ({ root }) => {
		const vault = makeVault(root);
		const fakes = makeFakes(root);
		const argvFile = path.join(root, "argv.txt");
		const env = { VAULT_SEARCH_BIN: fakes.fake, FAKE_ARGV: argvFile };

		const status = run(root, ["search", "alpha", "--status", "closed"], { vault, env });
		assert.equal(status.code, 2);
		assert.match(status.err, /--status must be active or any/);
		const limit = run(root, ["search", "alpha", "--limit", "0"], { vault, env });
		assert.equal(limit.code, 2);
		assert.match(limit.err, /--limit must be a positive whole number/);
		const fraction = run(root, ["search", "alpha", "--limit", "2.5"], { vault, env });
		assert.equal(fraction.code, 2);
		assert.equal(recorded(argvFile).length, 0, "the binary never ran");
	}),
);

test(
	"stats prints the recall line from eval/golden.json",
	withRoot(async ({ root }) => {
		const vault = makeVault(root);
		const fakes = makeFakes(root);
		write(
			vault,
			"eval/golden.json",
			`${JSON.stringify([
				{ query: "alpha", expect: "decision-alpha" },
				{ query: "ghost", expect: "decision-ghost" },
			])}\n`,
		);
		const results = path.join(root, "results.json");
		write(
			root,
			"results.json",
			JSON.stringify({
				alpha: [{ basename: "decision-alpha" }],
				ghost: [{ basename: "decision-ghost" }],
			}),
		);
		const env = { VAULT_SEARCH_BIN: fakes.fake, FAKE_RESULTS: results };

		const text = run(root, ["stats", "--repo", "github.com/o/r"], { vault, env });
		assert.equal(text.code, 0, text.err);
		assert.match(text.out, /search recall@5: 0\.5 \(1\/2\) \[needs 10\+ entries\]/);

		const json = run(root, ["stats", "--json", "--repo", "github.com/o/r"], { vault, env });
		assert.equal(json.code, 0, json.err);
		assert.deepEqual(JSON.parse(json.out).searchRecall, { ratio: 0.5, hits: 1, entries: 2 });
	}),
);

test(
	"stats says the binary is missing and prints no recall line without a golden file",
	withRoot(async ({ root }) => {
		const vault = makeVault(root);
		const fakes = makeFakes(root);

		const without = run(root, ["stats", "--repo", "github.com/o/r"], { vault, env: { VAULT_SEARCH_BIN: fakes.fake } });
		assert.equal(without.code, 0, without.err);
		assert.equal(without.out.includes("search recall@5:"), false);

		write(vault, "eval/golden.json", `${JSON.stringify([{ query: "alpha", expect: "decision-alpha" }])}\n`);
		const missing = run(root, ["stats", "--repo", "github.com/o/r"], {
			vault,
			env: { VAULT_SEARCH_BIN: path.join(root, "no-binary") },
		});
		assert.equal(missing.code, 0, missing.err);
		assert.match(missing.out, /search recall@5: unavailable \(vault-search not built\)/);
	}),
);

test(
	"a copy of vault.mjs without vault-search.mjs still runs the older commands",
	withRoot(async ({ root }) => {
		const vault = makeVault(root);
		const tool = path.join(root, "tool");
		fs.mkdirSync(tool);
		for (const name of ["vault.mjs", "vault-events.mjs", "vault-admin.mjs"]) {
			fs.copyFileSync(path.join(import.meta.dirname, name), path.join(tool, name));
		}
		const toolCli = path.join(tool, "vault.mjs");
		const env = cliEnv(root);
		const boot = spawnSync(process.execPath, [toolCli, "boot", "--vault", vault], {
			env,
			cwd: root,
			encoding: "utf8",
			timeout: 60_000,
		});
		assert.equal(boot.status, 0, boot.stderr);
		assert.match(boot.stdout, /=== index ===/);
		const stats = spawnSync(process.execPath, [toolCli, "stats", "--vault", vault], {
			env,
			cwd: root,
			encoding: "utf8",
			timeout: 60_000,
		});
		assert.equal(stats.status, 0, stats.stderr);
	}),
);

test("the documented build command builds the real vault-search binary", (t) => {
	const probe = spawnSync("go", ["version"], { encoding: "utf8" });
	if (probe.error || probe.status !== 0) {
		t.skip("go is not on the PATH, so the real vault-search build cannot run here");
		return;
	}
	const repoRoot = path.resolve(import.meta.dirname, "..");
	const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vault-search-build-")));
	try {
		const binary = path.join(temp, "vault-search");
		const build = spawnSync(
			"go",
			["build", "-C", "dispatch-plan/vault-search", "-o", binary, "."],
			{ cwd: repoRoot, env: process.env, encoding: "utf8", timeout: 120_000 },
		);
		assert.equal(build.status, 0, `${build.stdout ?? ""}\n${build.stderr ?? ""}`);
		assert.equal(fs.existsSync(binary), true);

		const version = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 30_000 });
		assert.equal(version.status, 0, version.stderr);
		assert.match(version.stdout, /^vault-search /);

		assert.ok(BUILD_HINT.includes("go build -C dispatch-plan/vault-search -o ../bin/vault-search ."), BUILD_HINT);
	} finally {
		fs.rmSync(temp, { recursive: true, force: true });
	}
});
