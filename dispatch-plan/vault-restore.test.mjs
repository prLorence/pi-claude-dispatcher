/** Run with: node --test dispatch-plan/vault-restore.test.mjs (Node 24+) */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import * as notes from "../pi-plan-dispatch/vault/notes.ts";
import * as privacy from "../pi-plan-dispatch/vault/privacy.ts";
import * as url from "../pi-plan-dispatch/vault/url.ts";
import { restore } from "./vault-restore.mjs";

const SLUG = "example.test/owner/repo";
const OTHER = "example.test/owner/other";

/** Git stays away from the real global and system config. */
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

function git(cwd, args) {
	return execFileSync("git", ["-C", cwd, ...args], {
		env: GIT_ENV,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function setGitIsolation() {
	const saved = {
		global: process.env.GIT_CONFIG_GLOBAL,
		system: process.env.GIT_CONFIG_SYSTEM,
	};
	process.env.GIT_CONFIG_GLOBAL = "/dev/null";
	process.env.GIT_CONFIG_SYSTEM = "/dev/null";
	return () => {
		for (const [key, value] of [
			["GIT_CONFIG_GLOBAL", saved.global],
			["GIT_CONFIG_SYSTEM", saved.system],
		]) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};
}

/** A fresh temp root per test, removed even when the body throws. */
function withRoot(body) {
	return async () => {
		const restoreGit = setGitIsolation();
		const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vault-restore-")));
		try {
			await body({ root });
		} finally {
			restoreGit();
			fs.rmSync(root, { recursive: true, force: true });
		}
	};
}

/** A git repo with an origin remote, so repoSlugFromCwd finds the slug. */
function makeRepo(dir, remote = `https://${SLUG}.git`) {
	fs.mkdirSync(dir, { recursive: true });
	git(dir, ["init", "-q"]);
	git(dir, ["remote", "add", "origin", remote]);
	fs.mkdirSync(path.join(dir, ".plans"), { recursive: true });
}

function makeVault(vault, repos = { [SLUG]: { mode: "full" } }) {
	fs.mkdirSync(vault, { recursive: true });
	fs.writeFileSync(path.join(vault, "repos.json"), JSON.stringify({ repos, aliases: {} }), "utf8");
}

const FOLDERS = { spec: "specs", plan: "plans", idea: "ideas", run: "runs" };

function writeNote(vault, type, basename, props, body) {
	const dir = path.join(vault, FOLDERS[type]);
	fs.mkdirSync(dir, { recursive: true });
	const merged = { created: "2026-10-01", updated: "2026-10-01", ...props };
	const lines = ["---", `type: ${type}`];
	for (const [key, value] of Object.entries(merged)) {
		if (key === "type") continue;
		lines.push(`${key}: ${value}`);
	}
	lines.push("---");
	fs.writeFileSync(path.join(dir, `${basename}.md`), `${lines.join("\n")}\n${body}`, "utf8");
}

function makeContext(vault, root) {
	const outs = [];
	const errs = [];
	const c = {
		vault,
		root,
		modules: { notes, privacy, url },
		out: (line) => outs.push(line),
		err: (line) => errs.push(line),
		inside: () => true,
	};
	return { c, outs, errs };
}

function planBody(status = "ready", extra = "") {
	return [
		"---",
		"id: 20261001-1200-demo-r1",
		"trace: 20261001-1200-demo",
		"spec: .plans/specs/20261001-1200-demo.md",
		"round: 1",
		`status: ${status}`,
		`${extra}---`,
		"",
		"Covers: R1.",
		"Do the thing.",
		"",
	].join("\n");
}

test(
	"restores a spec and a ready plan with the exact text",
	withRoot(async ({ root }) => {
		makeRepo(root);
		const vault = path.join(root, "vault");
		makeVault(vault);
		writeNote(
			vault,
			"spec",
			"20261001-1200-demo-spec",
			{ trace: "20261001-1200-demo", repo: SLUG, status: "draft", file: "20261001-1200-demo.md" },
			"Spec body line one.\nSecond line.\n",
		);
		writeNote(
			vault,
			"plan",
			"20261001-1200-demo-r1",
			{ trace: "20261001-1200-demo", round: "1", repo: SLUG, status: "ready", file: "20261001-1200-demo-r1.md" },
			planBody(),
		);

		const { c, outs, errs } = makeContext(vault, root);
		const result = restore(c);

		assert.equal(result.code, 0);
		assert.deepEqual(errs, []);
		assert.deepEqual(outs, [
			"restored .plans/specs/20261001-1200-demo.md",
			"restored .plans/inbox/20261001-1200-demo-r1.md.draft",
		]);
		assert.equal(
			fs.readFileSync(path.join(root, ".plans", "specs", "20261001-1200-demo.md"), "utf8"),
			"Spec body line one.\nSecond line.\n",
		);
		const drafted = fs.readFileSync(path.join(root, ".plans", "inbox", "20261001-1200-demo-r1.md.draft"), "utf8");
		assert.equal(
			drafted,
			[
				"---",
				"id: 20261001-1200-demo-r1",
				"trace: 20261001-1200-demo",
				"spec: .plans/specs/20261001-1200-demo.md",
				"round: 1",
				"status: draft",
				"---",
				"",
				"Covers: R1.",
				"Do the thing.",
				"",
			].join("\n"),
		);
		assert.ok(!fs.existsSync(path.join(root, ".plans", "inbox", "20261001-1200-demo-r1.md")), "no ready plan file");
		assert.deepEqual(result.event, { kind: "vault.restore", data: { restored: 2, skipped: 0 } });
	}),
);

test(
	"leaves out done specs, done plans and notes of other repos",
	withRoot(async ({ root }) => {
		makeRepo(root);
		const vault = path.join(root, "vault");
		makeVault(vault);
		writeNote(vault, "spec", "done-spec", { trace: "t", repo: SLUG, status: "done", file: "done.md" }, "done\n");
		writeNote(vault, "plan", "done-plan", { trace: "t", round: "1", repo: SLUG, status: "done", file: "done-plan.md" }, planBody());
		writeNote(vault, "spec", "other-spec", { trace: "t", repo: OTHER, status: "draft", file: "other.md" }, "other\n");
		writeNote(
			vault,
			"plan",
			"other-plan",
			{ trace: "t", round: "1", repo: OTHER, status: "draft", file: "other-plan.md" },
			planBody("draft"),
		);
		writeNote(vault, "idea", "idea-other", { status: "open", repo: OTHER }, "not mine\n");

		const { c, outs, errs } = makeContext(vault, root);
		const result = restore(c);

		assert.equal(result.code, 0);
		assert.deepEqual(errs, []);
		assert.deepEqual(outs, []);
		assert.deepEqual(result.event, { kind: "vault.restore", data: { restored: 0, skipped: 0 } });
		assert.ok(!fs.existsSync(path.join(root, ".plans", "specs")), "no spec written");
		assert.ok(!fs.existsSync(path.join(root, ".plans", "inbox")), "no folder and no plan written");
	}),
);

test(
	"never overwrites an existing local file",
	withRoot(async ({ root }) => {
		makeRepo(root);
		const vault = path.join(root, "vault");
		makeVault(vault);
		writeNote(vault, "spec", "local-spec", { trace: "t", repo: SLUG, status: "draft", file: "local.md" }, "vault text\n");
		writeNote(vault, "plan", "local-plan", { trace: "t", round: "1", repo: SLUG, status: "draft", file: "local-plan.md" }, planBody("draft"));
		fs.mkdirSync(path.join(root, ".plans", "specs"), { recursive: true });
		fs.writeFileSync(path.join(root, ".plans", "specs", "local.md"), "local text\n", "utf8");
		fs.mkdirSync(path.join(root, ".plans", "inbox"), { recursive: true });
		fs.writeFileSync(path.join(root, ".plans", "inbox", "local-plan.md"), "local plan\n", "utf8");

		const { c, outs, errs } = makeContext(vault, root);
		const result = restore(c);

		assert.equal(result.code, 0);
		assert.deepEqual(errs, []);
		assert.deepEqual(outs, ["skipped .plans/specs/local.md: exists", "skipped .plans/inbox/local-plan.md.draft: exists"]);
		assert.equal(fs.readFileSync(path.join(root, ".plans", "specs", "local.md"), "utf8"), "local text\n");
		assert.equal(fs.readFileSync(path.join(root, ".plans", "inbox", "local-plan.md"), "utf8"), "local plan\n");
		assert.ok(!fs.existsSync(path.join(root, ".plans", "inbox", "local-plan.md.draft")));
		assert.deepEqual(result.event, { kind: "vault.restore", data: { restored: 0, skipped: 2 } });
	}),
);

test(
	"skips a plan present in each of the five places",
	withRoot(async ({ root }) => {
		makeRepo(root);
		const vault = path.join(root, "vault");
		makeVault(vault);
		for (const name of ["a", "b", "c", "d", "e"]) {
			writeNote(vault, "plan", `${name}-plan`, { trace: "t", round: "1", repo: SLUG, status: "draft", file: `${name}.md` }, planBody("draft"));
		}
		const plans = path.join(root, ".plans");
		fs.mkdirSync(path.join(plans, "inbox"), { recursive: true });
		fs.writeFileSync(path.join(plans, "inbox", "a.md"), "x\n", "utf8");
		fs.writeFileSync(path.join(plans, "inbox", "b.md.draft"), "x\n", "utf8");
		fs.mkdirSync(path.join(plans, "running"), { recursive: true });
		fs.writeFileSync(path.join(plans, "running", "c.md"), "x\n", "utf8");
		fs.mkdirSync(path.join(plans, "failed"), { recursive: true });
		fs.writeFileSync(path.join(plans, "failed", "d.md"), "x\n", "utf8");
		fs.mkdirSync(path.join(plans, "done", "e"), { recursive: true });
		fs.writeFileSync(path.join(plans, "done", "e", "plan.md"), "x\n", "utf8");

		const { c, outs, errs } = makeContext(vault, root);
		const result = restore(c);

		assert.equal(result.code, 0);
		assert.deepEqual(errs, []);
		assert.deepEqual(outs, [
			"skipped .plans/inbox/a.md.draft: exists",
			"skipped .plans/inbox/b.md.draft: exists",
			"skipped .plans/inbox/c.md.draft: exists",
			"skipped .plans/inbox/d.md.draft: exists",
			"skipped .plans/inbox/e.md.draft: exists",
		]);
		assert.deepEqual(result.event, { kind: "vault.restore", data: { restored: 0, skipped: 5 } });
	}),
);

test(
	"skips a bad file name and writes nothing outside .plans",
	withRoot(async ({ root }) => {
		makeRepo(root);
		const vault = path.join(root, "vault");
		makeVault(vault);
		writeNote(vault, "plan", "evil-plan", { trace: "t", round: "1", repo: SLUG, status: "draft", file: "../evil.md" }, planBody("draft"));
		writeNote(vault, "spec", "evil-spec", { trace: "t", repo: SLUG, status: "draft", file: "a/b.md" }, "evil\n");

		const { c, outs, errs } = makeContext(vault, root);
		const result = restore(c);

		assert.equal(result.code, 0);
		assert.deepEqual(errs, []);
		assert.deepEqual(outs, [
			"skipped .plans/specs/a/b.md: bad file name",
			"skipped .plans/inbox/../evil.md.draft: bad file name",
		]);
		assert.deepEqual(result.event, { kind: "vault.restore", data: { restored: 0, skipped: 2 } });
		assert.ok(!fs.existsSync(path.join(root, "evil.md")), "nothing above .plans");
		assert.ok(!fs.existsSync(path.join(root, ".plans", "evil.md")), "nothing outside the plan folders");
		assert.ok(!fs.existsSync(path.join(root, ".plans", "evil.md.draft")), "the resolved .draft target is not written");
		assert.ok(!fs.existsSync(path.join(root, ".plans", "inbox", "evil.md.draft")));
		assert.ok(!fs.existsSync(path.join(root, ".plans", "specs", "a")), "no folder from a path-like name");
	}),
);

test(
	"skips a plan body without front matter or without a status line",
	withRoot(async ({ root }) => {
		makeRepo(root);
		const vault = path.join(root, "vault");
		makeVault(vault);
		writeNote(vault, "plan", "plain-plan", { trace: "t", round: "1", repo: SLUG, status: "draft", file: "plain.md" }, "Plain text with no front matter.\n");
		writeNote(
			vault,
			"plan",
			"statusless-plan",
			{ trace: "t", round: "1", repo: SLUG, status: "draft", file: "statusless.md" },
			"---\nid: statusless\ntrace: t\n---\nNo status line.\n",
		);

		const { c, outs, errs } = makeContext(vault, root);
		const result = restore(c);

		assert.equal(result.code, 0);
		assert.deepEqual(errs, []);
		assert.deepEqual(outs, [
			"skipped .plans/inbox/plain.md.draft: no front matter",
			"skipped .plans/inbox/statusless.md.draft: no status line",
		]);
		assert.deepEqual(result.event, { kind: "vault.restore", data: { restored: 0, skipped: 2 } });
	}),
);

test(
	"prints the open ideas and the last three runs",
	withRoot(async ({ root }) => {
		makeRepo(root);
		const vault = path.join(root, "vault");
		makeVault(vault);
		writeNote(vault, "idea", "idea-bbb", { status: "open", repo: "-" }, "general\n");
		writeNote(vault, "idea", "idea-aaa", { status: "open", repo: SLUG }, "mine\n");
		writeNote(vault, "idea", "idea-ccc", { status: "taken", repo: SLUG }, "taken\n");
		writeNote(vault, "idea", "idea-ddd", { status: "open", repo: OTHER }, "other\n");
		writeNote(vault, "run", "20261001-d-run", { trace: "t", repo: SLUG, status: "done", gate: "fail", updated: "2026-10-01" }, "run\n");
		writeNote(vault, "run", "20261002-c-run", { trace: "t", repo: SLUG, status: "done", gate: "pass", updated: "2026-10-02" }, "run\n");
		writeNote(vault, "run", "20261003-b-run", { trace: "t", repo: SLUG, status: "done", gate: "fail", updated: "2026-10-03" }, "run\n");
		writeNote(vault, "run", "20261003-a-run", { trace: "t", repo: SLUG, status: "done", gate: "pass", updated: "2026-10-03" }, "run\n");

		const { c, outs, errs } = makeContext(vault, root);
		const result = restore(c);

		assert.equal(result.code, 0);
		assert.deepEqual(errs, []);
		assert.deepEqual(outs, [
			"idea idea-aaa",
			"idea idea-bbb",
			"run 20261003-a-run | pass | 2026-10-03",
			"run 20261003-b-run | fail | 2026-10-03",
			"run 20261002-c-run | pass | 2026-10-02",
		]);
		assert.deepEqual(result.event, { kind: "vault.restore", data: { restored: 0, skipped: 0 } });
	}),
);

test(
	"prints nothing and returns 0 for a meta, a none and an unlisted repo",
	withRoot(async ({ root }) => {
		for (const mode of ["meta", "none"]) {
			const dir = path.join(root, mode);
			makeRepo(dir);
			const vault = path.join(root, `${mode}-vault`);
			makeVault(vault, { [SLUG]: { mode } });
			writeNote(vault, "spec", `${mode}-spec`, { trace: "t", repo: SLUG, status: "draft", file: "x.md" }, "text\n");

			const { c, outs, errs } = makeContext(vault, dir);
			const result = restore(c);

			assert.equal(result.code, 0, mode);
			assert.equal(result.event, undefined, mode);
			assert.deepEqual(outs, [], mode);
			assert.deepEqual(errs, [], mode);
			assert.ok(!fs.existsSync(path.join(dir, ".plans", "specs", "x.md")), mode);
		}

		const dir = path.join(root, "unlisted");
		makeRepo(dir);
		const vault = path.join(root, "unlisted-vault");
		makeVault(vault, {});
		writeNote(vault, "spec", "unlisted-spec", { trace: "t", repo: SLUG, status: "draft", file: "x.md" }, "text\n");
		const { c, outs, errs } = makeContext(vault, dir);
		const result = restore(c);
		assert.equal(result.code, 0);
		assert.equal(result.event, undefined);
		assert.deepEqual(outs, []);
		assert.deepEqual(errs, []);
	}),
);

test(
	"returns 1 when the repo has no .plans folder",
	withRoot(async ({ root }) => {
		const dir = path.join(root, "repo");
		fs.mkdirSync(dir, { recursive: true });
		git(dir, ["init", "-q"]);
		git(dir, ["remote", "add", "origin", `https://${SLUG}.git`]);
		const vault = path.join(root, "vault");
		makeVault(vault);
		writeNote(vault, "spec", "no-plans-spec", { trace: "t", repo: SLUG, status: "draft", file: "x.md" }, "text\n");

		const { c, outs, errs } = makeContext(vault, dir);
		const result = restore(c);

		assert.equal(result.code, 1);
		assert.equal(result.event, undefined);
		assert.deepEqual(outs, []);
		assert.deepEqual(errs, ["restore: .plans does not exist"]);
	}),
);

test(
	"counts restored and skipped items in the event",
	withRoot(async ({ root }) => {
		makeRepo(root);
		const vault = path.join(root, "vault");
		makeVault(vault);
		writeNote(vault, "spec", "spec-a", { trace: "t", repo: SLUG, status: "confirmed", file: "spec-a.md" }, "a\n");
		writeNote(vault, "spec", "spec-b", { trace: "t", repo: SLUG, status: "draft", file: "spec-b.md" }, "b\n");
		writeNote(vault, "plan", "plan-a", { trace: "t", round: "1", repo: SLUG, status: "draft", file: "plan-a.md" }, planBody("draft"));
		writeNote(vault, "plan", "plan-bad", { trace: "t", round: "1", repo: SLUG, status: "draft", file: "bad/../name.md" }, planBody("draft"));
		fs.mkdirSync(path.join(root, ".plans", "specs"), { recursive: true });
		fs.writeFileSync(path.join(root, ".plans", "specs", "spec-b.md"), "local\n", "utf8");

		const { c, outs, errs } = makeContext(vault, root);
		const result = restore(c);

		assert.equal(result.code, 0);
		assert.deepEqual(errs, []);
		assert.deepEqual(outs, [
			"restored .plans/specs/spec-a.md",
			"skipped .plans/specs/spec-b.md: exists",
			"restored .plans/inbox/plan-a.md.draft",
			"skipped .plans/inbox/bad/../name.md.draft: bad file name",
		]);
		assert.deepEqual(result.event, { kind: "vault.restore", data: { restored: 2, skipped: 2 } });
	}),
);

test(
	"leaves a plan note without a file property alone and does not count it",
	withRoot(async ({ root }) => {
		makeRepo(root);
		const vault = path.join(root, "vault");
		makeVault(vault);
		writeNote(vault, "plan", "fileless-plan", { trace: "t", round: "1", repo: SLUG, status: "draft" }, planBody("draft"));

		const { c, outs, errs } = makeContext(vault, root);
		const result = restore(c);

		assert.equal(result.code, 0);
		assert.deepEqual(errs, []);
		assert.deepEqual(outs, []);
		assert.deepEqual(result.event, { kind: "vault.restore", data: { restored: 0, skipped: 0 } });
		assert.ok(!fs.existsSync(path.join(root, ".plans", "inbox")), "no folder and no plan written");
	}),
);

test(
	"reports a failed write on err and returns 1",
	withRoot(async ({ root }) => {
		makeRepo(root);
		const vault = path.join(root, "vault");
		makeVault(vault);
		writeNote(vault, "spec", "unwritable-spec", { trace: "t", repo: SLUG, status: "draft", file: "x.md" }, "text\n");
		// A regular file where the folder has to go makes the write fail.
		fs.writeFileSync(path.join(root, ".plans", "specs"), "not a folder\n", "utf8");

		const { c, outs, errs } = makeContext(vault, root);
		const result = restore(c);

		assert.equal(result.code, 1);
		assert.equal(result.event, undefined);
		assert.deepEqual(outs, []);
		assert.deepEqual(errs, ["restore: cannot write .plans/specs/x.md"]);
	}),
);
