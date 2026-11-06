import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeLlm } from "./fake-llm.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, "..", "plugins", "harness-dispatch", "index.js");
const TRACE = path.resolve(HERE, "..", "..", "dispatch-plan", "trace.mjs");

const DSH = process.env.DSH_BIN || "dsh";
const dshInstalled = spawnSync(DSH, ["--version"], { encoding: "utf8" }).status === 0;

const PLAN = `---
id: int-r1
trace: int-t
round: 1
status: ready
max_parallel: 2
verify: true
---
Shared context for the integration test.

## task: t1
files: src/shared.ts
role: implement
verify: true
Covers: R1.
Write the shared file.

## task: t2
files: src/shared.ts
role: implement
verify: VERIFY_FLAG
Covers: R2.
Write the shared file again and survive one failed verify.

## task: t3
files: src/c.ts
role: implement
verify: true
Covers: R3.
Write c.ts and try one edit outside your files.
`;

function setup() {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-integration-"));
	const repo = path.join(base, "repo");
	const home = path.join(base, "home");
	const dshHome = path.join(base, "dshhome");
	fs.mkdirSync(repo, { recursive: true });
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(dshHome, { recursive: true });
	execFileSync("git", ["init", "-q"], { cwd: repo });
	fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
	execFileSync("git", ["add", "."], { cwd: repo });
	execFileSync("git", ["-c", "user.email=a@b.c", "-c", "user.name=a", "commit", "-qm", "init"], { cwd: repo });
	for (const name of ["inbox", "running", "done", "failed"]) fs.mkdirSync(path.join(repo, ".plans", name), { recursive: true });
	fs.writeFileSync(
		path.join(repo, ".plans", "config.json"),
		JSON.stringify(
			{
				model: "fake/fake-model",
				thinking: "",
				retries: 1,
				maxParallel: 2,
				verifyTimeoutMinutes: 1,
				stallMinutes: 0,
				backoffSeconds: [1],
				probeUrls: [],
				probeSeconds: 1,
				outagePauseMinutes: 1,
				// This test exercises the in-process dsh agent against a fake
				// provider. The default implement role runs on omp, which reads
				// its own catalog and cannot see the fake route, so pin dsh here.
				roles: { implement: { agent: "dsh" } },
			},
			null,
			2,
		),
	);
	return { base, repo, home, dshHome };
}

test("a real headless dsh runs a 3-task plan and the unchanged trace CLIs read it", { skip: !dshInstalled && "dsh is not installed" }, async () => {
	const { base, repo, home, dshHome } = setup();
	const flag = path.join(base, "retry-flag");
	const doneFile = path.join(base, "done");
	const logFile = path.join(base, "llm.jsonl");
	const fake = await startFakeLlm({ logFile, doneFile, holdMs: 30000 });
	const childEnv = {
		...process.env,
		DSH_HOME: dshHome,
		HOME: home,
		OPENCODE_GO_API_KEY: "dummy-not-a-key",
		FAKE_LLM_DONE_FILE: doneFile,
		FAKE_LLM_HOLD_MS: "30000",
	};
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
				"            reasoningEfforts:",
				"              low: low",
				"              high: high",
				"              max: max",
				"- insert:",
				"    - id: harness-dispatch",
				`      name: ${PLUGIN}`,
				"",
			].join("\n"),
		);
		const plan = PLAN.replace("VERIFY_FLAG", `test -f ${flag} || (touch ${flag}; exit 1)`);
		fs.writeFileSync(path.join(repo, ".plans", "inbox", "int-r1.md"), plan);
		// A draft and a non-ready plan must never be picked up.
		fs.writeFileSync(path.join(repo, ".plans", "inbox", "never.md.draft"), plan.replace("int-r1", "never"));
		fs.writeFileSync(path.join(repo, ".plans", "inbox", "notready.md"), plan.replace("int-r1", "notready").replace("status: ready", "status: draft"));

		child = spawn(DSH, ["--profile", "headless", "--patch", patch, "--json", "wait for the plan"], {
			cwd: repo,
			env: childEnv,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => (stdout += d.toString()));
		child.stderr.on("data", (d) => (stderr += d.toString()));

		const evidence = path.join(repo, ".plans", "done", "int-r1", "evidence.json");
		const deadline = Date.now() + 30000;
		while (!fs.existsSync(evidence) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
		assert.equal(fs.existsSync(evidence), true, `no evidence; stderr: ${stderr}\nstdout: ${stdout}`);
		fs.writeFileSync(doneFile, "done\n");
		const code = await new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				reject(new Error(`dsh did not exit; stderr: ${stderr}`));
			}, 30000);
			child.on("close", (c) => {
				clearTimeout(timer);
				resolve(c);
			});
		});
		child = undefined;
		assert.equal(code, 0, stderr);
		assert.equal(/did not activate/.test(stderr), false, stderr);

		const evidenceJson = JSON.parse(fs.readFileSync(evidence, "utf8"));
		assert.equal(evidenceJson.gate.pass, true);
		assert.equal(evidenceJson.gate.tasks.done, 3);
		assert.equal(evidenceJson.gate.counts.error, 0);
		assert.ok(evidenceJson.changed.includes("src/c.ts"));
		assert.ok(evidenceJson.changed.includes("src/shared.ts"));
		assert.ok(evidenceJson.faults.some((f) => f.code === "retried" && f.task === "t2"), JSON.stringify(evidenceJson.faults));
		assert.ok(evidenceJson.faults.some((f) => f.code === "blocked_action" && f.task === "t3"), JSON.stringify(evidenceJson.faults));

		const doneDir = path.join(repo, ".plans", "done", "int-r1");
		for (const file of ["plan.md", "_summary.md", "t1.md", "t1.prompt.md", "t1.verify.md", "t2.md", "t2.verify.md", "t3.md", "evidence.json"]) {
			assert.equal(fs.existsSync(path.join(doneDir, file)), true, file);
		}
		assert.match(fs.readFileSync(path.join(doneDir, "_summary.md"), "utf8"), /gate: \*\*PASS\*\*/);
		assert.equal(fs.existsSync(path.join(repo, ".plans", "done", "never")), false);
		assert.equal(fs.existsSync(path.join(repo, ".plans", "done", "notready")), false);

		// The plan's overlapping tasks never run at the same time.
		const events = fs
			.readFileSync(path.join(repo, ".plans", "traces", "int-t.jsonl"), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
		const starts = new Map();
		const ends = new Map();
		for (const e of events) {
			if (e.kind === "task.start") starts.set(e.task, Date.parse(e.ts));
			if (e.kind === "task.end" && e.data?.state === "done") ends.set(e.task, Date.parse(e.ts));
		}
		const a = [starts.get("t1"), ends.get("t1")];
		const b = [starts.get("t2"), ends.get("t2")];
		assert.ok(a[1] <= b[0] || b[1] <= a[0], `t1 ${a} and t2 ${b} overlapped`);
		for (const kind of ["plan.received", "task.start", "task.verify", "task.end", "fault", "gate", "plan.end"]) {
			assert.ok(events.some((e) => e.kind === kind), kind);
		}

		const gate = spawnSync("node", [TRACE, "gate", "--plan", "int-r1", "--root", repo], { encoding: "utf8" });
		assert.equal(gate.status, 0, gate.stderr);
		assert.match(gate.stdout, /"pass": true/);
		const report = spawnSync("node", [TRACE, "report", "--trace", "int-t", "--root", repo], { encoding: "utf8" });
		assert.equal(report.status, 0, report.stderr);
		assert.match(report.stdout, /int-r1/);
		assert.equal(fs.existsSync(path.join(repo, ".plans", "traces", "int-t.md")), true);
	} finally {
		if (child) child.kill("SIGKILL");
		await fake.close();
		fs.rmSync(base, { recursive: true, force: true });
	}
});
