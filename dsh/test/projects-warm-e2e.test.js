import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeLlm } from "./fake-llm.mjs";
import { makeSkillRoot } from "../fixtures/vault-env.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, "..", "plugins", "harness-projects", "index.js");
const VAULT_PLUGIN = path.resolve(HERE, "..", "plugins", "harness-vault", "index.js");
const DSH = process.env.DSH_BIN || "dsh";
const dshInstalled = spawnSync(DSH, ["--version"], { encoding: "utf8" }).status === 0;

function setup() {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-projects-e2e-"));
	const repo = path.join(base, "repo");
	const home = path.join(base, "home");
	const dshHome = path.join(base, "dshhome");
	const vault = path.join(base, "vault");
	for (const dir of [repo, home, dshHome, vault]) fs.mkdirSync(dir, { recursive: true });
	for (const dir of ["projects", "findings", "runs", "decisions", "lessons", "plans", "specs", "ideas"]) fs.mkdirSync(path.join(vault, dir), { recursive: true });
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
	fs.writeFileSync(path.join(repo, "README.md"), "# Demo\n");
	execFileSync("git", ["add", "."], { cwd: repo });
	execFileSync("git", ["-c", "user.email=a@b.c", "-c", "user.name=a", "commit", "-qm", "init"], { cwd: repo });
	execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/demo.git"], { cwd: repo });
	fs.writeFileSync(path.join(vault, "repos.json"), JSON.stringify({ repos: { "github.com/acme/demo": { mode: "full" } }, aliases: {} }, null, 2));
	fs.writeFileSync(
		path.join(vault, "projects", "project-demo.md"),
		"---\ntype: project\ncreated: 2026-11-01\nupdated: 2026-11-01\nrepos:\n  - github.com/acme/demo\n---\nDemo keeps the warm context honest.\n- Gate: all tasks done.\n",
	);
	fs.writeFileSync(
		path.join(vault, "findings", "demo-finding.md"),
		"---\ntype: finding\ncreated: 2026-11-02\nupdated: 2026-11-02\nrepo: github.com/acme/demo\nseverity: major\nstatus: open\n---\nThe demo leaks a key.\n",
	);
	fs.writeFileSync(
		path.join(vault, "runs", "demo-run.md"),
		"---\ntype: run\ncreated: 2026-11-02\nupdated: 2026-11-02\nrepo: github.com/acme/demo\nstatus: done\ngate: pass\n---\nWarm.\n",
	);
	fs.writeFileSync(path.join(vault, "log.md"), "- 2026-11-02T10:00:00Z [host] github.com/acme/demo demo r1: gate PASS\n");
	return { base, repo, home, dshHome, vault };
}

test("a real headless dsh session receives the warm project context", { skip: !dshInstalled && "dsh is not installed" }, async () => {
	const { base, repo, home, dshHome, vault } = setup();
	const skill = makeSkillRoot();
	const logFile = path.join(base, "llm.jsonl");
	const doneFile = path.join(base, "done");
	fs.writeFileSync(doneFile, "done\n");
	const fake = await startFakeLlm({ logFile, doneFile, holdMs: 5000 });
	const registry = path.join(base, "projects.json");
	let child;
	try {
		const patch = path.join(base, "patch.yml");
		fs.writeFileSync(
			patch,
			[
				"- id: agent-default-model",
				"  config:",
				"    provider: fake",
				"    model: fake-model",
				"- id: llm-pi-ai",
				"  config:",
				"    providers:",
				"      fake:",
				"        apiKeyEnv: OPENCODE_GO_API_KEY",
				"        api: openai-completions",
				`        baseURL: http://127.0.0.1:${fake.port}/v1`,
				"        models:",
				"          - id: fake-model",
				"            name: Fake Model",
				"            contextWindow: 100000",
				"            maxTokens: 4096",
				"- insert:",
				"    - id: harness-vault",
				`      name: ${VAULT_PLUGIN}`,
				"      config:",
				"        injectVaultBoot: false",
				`        skillRoot: ${skill.root}`,
				"    - id: harness-projects",
				`      name: ${PLUGIN}`,
				"      config:",
				`        skillRoot: ${skill.root}`,
				`        registryPath: ${registry}`,
				"        refreshSeconds: 3600",
				"        budget: 2000",
				"",
			].join("\n"),
		);

		const childEnv = {
			...process.env,
			DSH_HOME: dshHome,
			HOME: home,
			OPENCODE_GO_API_KEY: "dummy-not-a-key",
			FAKE_LLM_DONE_FILE: doneFile,
			FAKE_LLM_HOLD_MS: "5000",
			FAKE_VAULT_PATH: vault,
			FAKE_VAULT_LOG: path.join(base, "vault-calls.jsonl"),
		};

		child = spawn(DSH, ["--profile", "headless", "--patch", patch, "--json", "say hello"], {
			cwd: repo,
			env: childEnv,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stderr = "";
		child.stderr.on("data", (d) => (stderr += d.toString()));
		const code = await new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				reject(new Error(`dsh did not exit; stderr: ${stderr}`));
			}, 40000);
			child.on("close", (result) => {
				clearTimeout(timer);
				resolve(result);
			});
		});
		child = undefined;
		assert.equal(code, 0, stderr);
		assert.equal(/did not activate/.test(stderr), false, stderr);

		const requests = fs
			.readFileSync(logFile, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		const prompts = requests.map((request) => JSON.stringify(request.messages ?? request)).join("\n");
		assert.match(prompts, /## Project \(harness-projects\)/);
		assert.match(prompts, /github\.com\/acme\/demo/);
		assert.match(prompts, /## Project context — github\.com\/acme\/demo/);
		assert.match(prompts, /Project note \[\[project-demo\]\]/);
		assert.match(prompts, /\[major\] demo-finding/);
		assert.match(prompts, /gate pass, done/);

		const registryJson = JSON.parse(fs.readFileSync(registry, "utf8"));
		assert.ok(registryJson.projects[fs.realpathSync(repo)], "the session's repository is auto-registered");
	} finally {
		if (child) child.kill("SIGKILL");
		await fake.close();
		fs.rmSync(base, { recursive: true, force: true });
		fs.rmSync(skill.root, { recursive: true, force: true });
	}
});
