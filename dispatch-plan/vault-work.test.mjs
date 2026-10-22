/** Run with: node --test dispatch-plan/vault-work.test.mjs (Node 24+) */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { workAdd, workPending } from "./vault-work.mjs";

const dispatcher = path.resolve(import.meta.dirname, "..", "pi-plan-dispatch");

/** The real vault modules of this repo, loaded the way vault.mjs loads them. */
function loadModule(name) {
	return import(pathToFileURL(path.join(dispatcher, "vault", name)).href);
}

const [schema, notes, privacy, url, lock, git] = await Promise.all(
	["schema.ts", "notes.ts", "privacy.ts", "url.ts", "lock.ts", "git.ts"].map(loadModule),
);
const modules = { schema, notes, privacy, url, lock, git };

const FULL_REMOTE = "git@github.com:o/n.git";
const META_REMOTE = "git@github.com:o/m.git";
const NONE_REMOTE = "git@github.com:o/w.git";
const NONE_SLUG = "github.com/o/w";
const UNLISTED_REMOTE = "git@github.com:o/u.git";
const REPOS = {
	"github.com/o/n": { mode: "full" },
	"github.com/o/m": { mode: "meta" },
	[NONE_SLUG]: { mode: "none" },
};

const TRACE = "20261023-1010-work";
const TRACE_MARKDOWN = "# Report\n\n| round | verdict |\n| 1 | pass |\n";

/** Built from parts, so no secret pattern sits in this file itself. */
const SECRET = ["sk", "ant"].join("-") + "-" + "x".repeat(30);

/** Git stays away from the real global config and takes its identity from here. */
const GIT_ENV = {
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
	GIT_AUTHOR_NAME: "vault work test",
	GIT_AUTHOR_EMAIL: "vault-work@example.test",
	GIT_COMMITTER_NAME: "vault work test",
	GIT_COMMITTER_EMAIL: "vault-work@example.test",
};

function gitRun(cwd, args) {
	return execFileSync("git", ["-C", cwd, ...args], {
		env: { ...process.env, ...GIT_ENV },
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

/** `repoSlugFromCwd` shells out to git in this process, so keep it off the real config. */
function withRoot(body) {
	return async () => {
		const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vault-work-")));
		const saved = process.env.GIT_CONFIG_GLOBAL;
		process.env.GIT_CONFIG_GLOBAL = "/dev/null";
		try {
			await body({ root });
		} finally {
			if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
			else process.env.GIT_CONFIG_GLOBAL = saved;
			fs.rmSync(root, { recursive: true, force: true });
		}
	};
}

function writeText(root, relative, text) {
	const file = path.join(root, ...relative.split("/"));
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
	return file;
}

function writeBytes(root, relative, bytes) {
	const file = path.join(root, ...relative.split("/"));
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, bytes);
	return file;
}

function makeRepo(root, remote, name = "repo") {
	const dir = path.join(root, name);
	fs.mkdirSync(dir, { recursive: true });
	gitRun(dir, ["init", "-q"]);
	gitRun(dir, ["remote", "add", "origin", remote]);
	return dir;
}

function makeVault(root, repos = REPOS) {
	const vault = path.join(root, "vault");
	fs.mkdirSync(vault, { recursive: true });
	fs.writeFileSync(path.join(vault, "repos.json"), `${JSON.stringify({ repos, aliases: {} }, null, 2)}\n`);
	return vault;
}

function makeContext({ vault, root, inside = () => true }) {
	const out = [];
	const err = [];
	return { c: { vault, root, modules, inside, out: (t) => out.push(t), err: (t) => err.push(t) }, out, err };
}

function listFiles(dir) {
	const found = [];
	const walk = (folder, relative) => {
		let entries;
		try {
			entries = fs.readdirSync(folder, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
			if (entry.isDirectory()) walk(path.join(folder, entry.name), child);
			else found.push(child);
		}
	};
	walk(dir, "");
	return found.sort();
}

function traceLine(event) {
	return `${JSON.stringify({ ts: "2026-10-23T10:10:00.000Z", actor: "pi-dispatch", ...event })}\n`;
}

function traceText(trace, { secondPlan = false, finished = true, extraLines = [] } = {}) {
	const first = `${trace}-r1`;
	const lines = [
		traceLine({ kind: "spec.confirmed", plan: first }),
		traceLine({ kind: "task.start", plan: first, task: "t1" }),
		traceLine({ actor: "vault", kind: "vault.write", plan: first, type: "plan", id: "plan-x" }),
	];
	if (finished) lines.push(traceLine({ kind: "plan.end", plan: first }));
	if (secondPlan) {
		const second = `${trace}-r2`;
		lines.push(traceLine({ kind: "plan.drafted", plan: second }));
		if (finished) lines.push(traceLine({ kind: "plan.end", plan: second }));
	}
	lines.push(...extraLines);
	return lines.join("");
}

const DONE_FILES = {
	"_summary.md": "gate: pass\n",
	"evidence.json": "{}\n",
	"plan.md": "---\nid: r1\n---\n",
	"t1.md": "task one report\n",
	"t1.prompt.md": "the prompt, never copied\n",
	"t1.verify.md": "verify output\n",
};

const FAILED_FILES = {
	"_summary.md": "gate: fail\n",
	"error.md": "rejected by preflight\n",
	"plan.md": "---\nid: r2\n---\n",
	"t2.prompt.md": "the prompt, never copied\n",
};

function makeFixture({ root, remote = FULL_REMOTE, trace = TRACE, finished = true }) {
	const repo = makeRepo(root, remote);
	writeText(repo, `.plans/traces/${trace}.jsonl`, traceText(trace, { secondPlan: true, finished }));
	writeText(repo, `.plans/traces/${trace}.md`, TRACE_MARKDOWN);
	for (const [name, text] of Object.entries(DONE_FILES)) writeText(repo, `.plans/done/${trace}-r1/${name}`, text);
	for (const [name, text] of Object.entries(FAILED_FILES)) {
		writeText(repo, `.plans/failed/${trace}-r2/${name}`, text);
	}
	writeText(repo, `.plans/running/${trace}-r1/state.json`, "{}\n");
	writeText(repo, `.plans/sessions/${trace}-r1/session.jsonl`, "{}\n");
	writeText(repo, `.plans/inbox/${trace}-r1.md`, "a plan body\n");
	return repo;
}

function expectedDestinations(trace) {
	return [
		`${trace}-r1/_summary.md`,
		`${trace}-r1/evidence.json`,
		`${trace}-r1/t1.md`,
		`${trace}-r1/t1.verify.md`,
		`${trace}-r2/_summary.md`,
		`${trace}-r2/error.md`,
		"trace.jsonl",
		"trace.md",
	].sort();
}

function localTraceText(repo, trace) {
	return fs.readFileSync(path.join(repo, ".plans", "traces", `${trace}.jsonl`), "utf8");
}

/** The local trace without its vault lines, computed here again on its own. */
function expectedTraceCopy(repo, trace) {
	return localTraceText(repo, trace)
		.split("\n")
		.filter((line) => line !== "")
		.filter((line) => JSON.parse(line).actor !== "vault")
		.map((line) => `${line}\n`)
		.join("");
}

function runNote(trace, repoSlug = "github.com/o/n") {
	return [
		"---",
		"type: run",
		"created: 2026-10-20",
		"updated: 2026-10-20",
		`trace: ${trace}`,
		`repo: ${repoSlug}`,
		"status: done",
		"gate: pass",
		"---",
		"- gate: pass",
		"",
	].join("\n");
}

function runNotes(vault) {
	return notes.listNotes(vault).filter((note) => note.type === "run");
}

test(
	"work add copies the record of a finished request and nothing else",
	withRoot(async ({ root }) => {
		const vault = makeVault(root);
		const repo = makeFixture({ root });
		const { c, out, err } = makeContext({ vault, root: repo });

		const result = workAdd(c, { trace: TRACE, probes: false });

		assert.equal(result.code, 0);
		assert.deepEqual(err, []);
		assert.deepEqual(out, ["work add: 8 copied, 0 unchanged, 0 unmirrored"]);
		assert.deepEqual(listFiles(path.join(vault, "work", TRACE)), expectedDestinations(TRACE));
		assert.equal(
			fs.readFileSync(path.join(vault, "work", TRACE, "trace.jsonl"), "utf8"),
			expectedTraceCopy(repo, TRACE),
		);
		assert.equal(fs.readFileSync(path.join(vault, "work", TRACE, "trace.md"), "utf8"), TRACE_MARKDOWN);
		assert.equal(
			fs.readFileSync(path.join(vault, "work", TRACE, `${TRACE}-r1`, "_summary.md"), "utf8"),
			"gate: pass\n",
		);
		assert.deepEqual(result.event, {
			kind: "vault.work",
			data: { op: "add", trace: TRACE, files: 8, unmirrored: 0 },
		});
		assert.ok(!listFiles(path.join(vault, "work", TRACE)).some((name) => name.endsWith(".prompt.md")));
		assert.ok(!listFiles(path.join(vault, "work", TRACE)).some((name) => name.endsWith("/plan.md")));
	}),
);

test(
	"work add is idempotent, also after a vault.work event landed in the local trace",
	withRoot(async ({ root }) => {
		const vault = makeVault(root);
		const repo = makeFixture({ root });
		const first = makeContext({ vault, root: repo });
		assert.equal(workAdd(first.c, { trace: TRACE }).code, 0);
		const stored = fs.readFileSync(path.join(vault, "work", TRACE, "trace.jsonl"), "utf8");

		const second = makeContext({ vault, root: repo });
		assert.equal(workAdd(second.c, { trace: TRACE }).code, 0);
		assert.deepEqual(second.out, ["work add: 0 copied, 8 unchanged, 0 unmirrored"]);

		fs.appendFileSync(
			path.join(repo, ".plans", "traces", `${TRACE}.jsonl`),
			traceLine({ actor: "vault", kind: "vault.work", plan: `${TRACE}-r1` }),
		);
		const third = makeContext({ vault, root: repo });
		assert.equal(workAdd(third.c, { trace: TRACE }).code, 0);
		assert.deepEqual(third.out, ["work add: 0 copied, 8 unchanged, 0 unmirrored"]);
		assert.equal(fs.readFileSync(path.join(vault, "work", TRACE, "trace.jsonl"), "utf8"), stored);
		assert.ok(!stored.includes('"kind":"vault.work"'));
	}),
);

test(
	"a changed file is replaced",
	withRoot(async ({ root }) => {
		const vault = makeVault(root);
		const repo = makeFixture({ root });
		assert.equal(workAdd(makeContext({ vault, root: repo }).c, { trace: TRACE }).code, 0);

		fs.appendFileSync(path.join(repo, ".plans", "done", `${TRACE}-r1`, "t1.md"), "a later line\n");
		const again = makeContext({ vault, root: repo });
		assert.equal(workAdd(again.c, { trace: TRACE }).code, 0);
		assert.deepEqual(again.out, ["work add: 1 copied, 7 unchanged, 0 unmirrored"]);
		assert.match(fs.readFileSync(path.join(vault, "work", TRACE, `${TRACE}-r1`, "t1.md"), "utf8"), /a later line/);
	}),
);

test(
	"probes are copied only with the flag, including a ref- folder tree",
	withRoot(async ({ root }) => {
		const vault = makeVault(root);
		const repo = makeFixture({ root });
		writeText(repo, ".plans/tools/probe-a.sh", "echo probe\n");
		writeText(repo, ".plans/tools/ref-b.txt", "ref b\n");
		writeText(repo, ".plans/tools/make-ref-c.txt", "make ref c\n");
		writeText(repo, ".plans/tools/probes.sha256", "deadbeef  probe-a.sh\n");
		writeText(repo, ".plans/tools/other.txt", "not a probe\n");
		writeText(repo, ".plans/tools/ref-tree/deep/inner.txt", "nested\n");
		writeText(repo, ".plans/tools/subdir/probe-x.sh", "not top level\n");

		const without = makeContext({ vault, root: repo });
		assert.equal(workAdd(without.c, { trace: TRACE }).code, 0);
		assert.deepEqual(listFiles(path.join(vault, "work", TRACE)), expectedDestinations(TRACE));

		const withProbes = makeContext({ vault, root: repo });
		assert.equal(workAdd(withProbes.c, { trace: TRACE, probes: true }).code, 0);
		assert.deepEqual(listFiles(path.join(vault, "work", TRACE)), [
			...expectedDestinations(TRACE),
			"probes/make-ref-c.txt",
			"probes/probe-a.sh",
			"probes/probes.sha256",
			"probes/ref-b.txt",
			"probes/ref-tree/deep/inner.txt",
		].sort());
		assert.ok(!fs.existsSync(path.join(vault, "work", TRACE, "probes", "other.txt")));
		assert.ok(!fs.existsSync(path.join(vault, "work", TRACE, "probes", "subdir")));
	}),
);

test(
	"a meta repo copies nothing, a none repo and an unlisted repo exit 3",
	withRoot(async ({ root }) => {
		const metaVault = makeVault(root, REPOS);
		const metaRepo = makeFixture({ root, remote: META_REMOTE, trace: "20261023-1020-meta" });
		const meta = makeContext({ vault: metaVault, root: metaRepo });
		const metaResult = workAdd(meta.c, { trace: "20261023-1020-meta" });
		assert.equal(metaResult.code, 0);
		assert.deepEqual(meta.out, ["work add: a meta repo copies no work files"]);
		assert.equal(metaResult.event, undefined);
		assert.ok(!fs.existsSync(path.join(metaVault, "work", "20261023-1020-meta")));

		const noneRepo = makeRepo(root, NONE_REMOTE, "none-repo");
		writeText(noneRepo, ".plans/traces/20261023-1030-none.jsonl", traceText("20261023-1030-none"));
		const none = makeContext({ vault: metaVault, root: noneRepo });
		const noneResult = workAdd(none.c, { trace: "20261023-1030-none" });
		assert.equal(noneResult.code, 3);
		assert.deepEqual(none.err, ["work add: this repo is not allowed in the vault"]);
		assert.equal(noneResult.event, undefined);

		const unlistedRepo = makeRepo(root, UNLISTED_REMOTE, "unlisted-repo");
		writeText(unlistedRepo, ".plans/traces/20261023-1040-unlisted.jsonl", traceText("20261023-1040-unlisted"));
		const unlisted = makeContext({ vault: metaVault, root: unlistedRepo });
		const unlistedResult = workAdd(unlisted.c, { trace: "20261023-1040-unlisted" });
		assert.equal(unlistedResult.code, 3);
		assert.deepEqual(unlisted.err, ["work add: this repo is not allowed in the vault"]);
	}),
);

test(
	"an unfinished request exits 1 and copies nothing",
	withRoot(async ({ root }) => {
		const vault = makeVault(root);
		const repo = makeFixture({ root, finished: false });
		const { c, out, err } = makeContext({ vault, root: repo });

		const result = workAdd(c, { trace: TRACE });

		assert.equal(result.code, 1);
		assert.deepEqual(out, []);
		assert.deepEqual(err, ["work add: request not finished"]);
		assert.ok(!fs.existsSync(path.join(vault, "work", TRACE)));
	}),
);

test(
	"a bad trace id exits 2 and copies nothing",
	withRoot(async ({ root }) => {
		const vault = makeVault(root);
		const repo = makeFixture({ root });
		for (const trace of ["bad trace", "../escape", "", "-leading"]) {
			const { c, out, err } = makeContext({ vault, root: repo });
			const result = workAdd(c, { trace });
			assert.equal(result.code, 2, trace);
			assert.deepEqual(out, []);
			assert.deepEqual(err, [`work add: bad trace id: ${trace}`]);
		}
		assert.ok(!fs.existsSync(path.join(vault, "work")));
	}),
);

test(
	"a secret, a none repo name and a binary file are unmirrored, the rest is copied",
	withRoot(async ({ root }) => {
		const vault = makeVault(root);
		const repo = makeFixture({ root });
		writeText(repo, `.plans/done/${TRACE}-r1/secret.md`, `const key = "${SECRET}";\n`);
		writeText(repo, `.plans/done/${TRACE}-r1/leak.md`, `repo: ${NONE_SLUG}\n`);
		writeBytes(repo, `.plans/done/${TRACE}-r1/binary.md`, Buffer.from([0xff, 0xfe, 0x00, 0x41]));
		const { c, out, err } = makeContext({ vault, root: repo });

		const result = workAdd(c, { trace: TRACE });

		assert.equal(result.code, 6);
		assert.deepEqual(out, ["work add: 8 copied, 0 unchanged, 3 unmirrored"]);
		assert.deepEqual(err, [
			`unmirrored .plans/done/${TRACE}-r1/binary.md: not UTF-8 text`,
			`unmirrored .plans/done/${TRACE}-r1/leak.md: names a repo that is not allowed`,
			`unmirrored .plans/done/${TRACE}-r1/secret.md: secret pattern: anthropic-key`,
		]);
		const printed = [...out, ...err].join("\n");
		assert.ok(!printed.includes(NONE_SLUG));
		assert.ok(!printed.includes("o/w"));
		const copied = listFiles(path.join(vault, "work", TRACE));
		assert.deepEqual(copied, expectedDestinations(TRACE));
		assert.equal(result.event?.data.unmirrored, 3);
	}),
);

test(
	"a plan id that is not a trace id is unmirrored and its folder is not read",
	withRoot(async ({ root }) => {
		const vault = makeVault(root);
		const repo = makeFixture({ root });
		fs.appendFileSync(
			path.join(repo, ".plans", "traces", `${TRACE}.jsonl`),
			traceLine({ kind: "plan.end", plan: "bad plan" }),
		);
		const { c, out, err } = makeContext({ vault, root: repo });

		const result = workAdd(c, { trace: TRACE });

		assert.equal(result.code, 6);
		assert.deepEqual(out, ["work add: 8 copied, 0 unchanged, 1 unmirrored"]);
		assert.deepEqual(err, ["unmirrored bad plan: bad plan id"]);
	}),
);

test(
	"every run note of the trace gets the unmirrored property and loses it again",
	withRoot(async ({ root }) => {
		const vault = makeVault(root);
		const repo = makeFixture({ root });
		writeText(vault, "runs/run-a.md", runNote(TRACE));
		writeText(vault, "runs/run-b.md", runNote(TRACE));
		writeText(vault, "runs/run-other.md", runNote("20261023-9999-other"));

		const secretFile = writeText(repo, `.plans/done/${TRACE}-r1/secret.md`, `const key = "${SECRET}";\n`);
		assert.equal(workAdd(makeContext({ vault, root: repo }).c, { trace: TRACE }).code, 6);
		for (const note of runNotes(vault)) {
			if (note.basename === "run-other") {
				assert.equal(note.props.unmirrored, undefined);
				continue;
			}
			assert.equal(note.props.unmirrored, `.plans/done/${TRACE}-r1/secret.md`);
		}

		fs.rmSync(secretFile);
		const clean = makeContext({ vault, root: repo });
		assert.equal(workAdd(clean.c, { trace: TRACE }).code, 0);
		assert.deepEqual(clean.out, ["work add: 0 copied, 8 unchanged, 0 unmirrored"]);
		for (const note of runNotes(vault)) assert.equal(note.props.unmirrored, undefined);
	}),
);

test(
	"an unreadable note listing is reported and the copy still stands",
	withRoot(async ({ root }) => {
		const vault = makeVault(root);
		const repo = makeFixture({ root });
		writeText(vault, "plans/broken.md", "not a note at all\n");
		const { c, out, err } = makeContext({ vault, root: repo });

		const result = workAdd(c, { trace: TRACE });

		assert.equal(result.code, 0);
		assert.deepEqual(out, ["work add: 8 copied, 0 unchanged, 0 unmirrored"]);
		assert.equal(err.length, 1);
		assert.match(err[0], /^work add: could not read the notes \(.+\)$/);
	}),
);

test(
	"a target outside the vault is unmirrored",
	withRoot(async ({ root }) => {
		const vault = makeVault(root);
		const repo = makeFixture({ root });
		const { c, out, err } = makeContext({ vault, root: repo, inside: () => false });

		const result = workAdd(c, { trace: TRACE });

		assert.equal(result.code, 6);
		assert.deepEqual(out, ["work add: 0 copied, 0 unchanged, 8 unmirrored"]);
		assert.equal(err.length, 8);
		for (const line of err) assert.match(line, /: outside the vault$/);
		assert.ok(!fs.existsSync(path.join(vault, "work", TRACE)));
	}),
);

test(
	"work pending lists finished traces that are missing or changed, and writes nothing",
	withRoot(async ({ root }) => {
		const vault = makeVault(root);
		const repo = makeFixture({ root });
		writeText(repo, ".plans/traces/20261023-1011-unfinished.jsonl", traceText("20261023-1011-unfinished", { finished: false }));

		const before = makeContext({ vault, root: repo });
		assert.equal(workPending(before.c).code, 0);
		assert.deepEqual(before.out, [`pending ${TRACE}`]);
		assert.ok(!fs.existsSync(path.join(vault, "work")));

		assert.equal(workAdd(makeContext({ vault, root: repo }).c, { trace: TRACE }).code, 0);

		const after = makeContext({ vault, root: repo });
		assert.equal(workPending(after.c).code, 0);
		assert.deepEqual(after.out, []);

		fs.appendFileSync(
			path.join(repo, ".plans", "traces", `${TRACE}.jsonl`),
			traceLine({ kind: "loop.stop", plan: `${TRACE}-r1` }),
		);
		const changed = makeContext({ vault, root: repo });
		assert.equal(workPending(changed.c).code, 0);
		assert.deepEqual(changed.out, [`pending ${TRACE}`]);
		assert.deepEqual(changed.err, []);
	}),
);

test(
	"work pending prints nothing for a meta, none or unlisted repo",
	withRoot(async ({ root }) => {
		const vault = makeVault(root);
		for (const [name, remote] of [
			["meta", META_REMOTE],
			["none", NONE_REMOTE],
			["unlisted", UNLISTED_REMOTE],
		]) {
			const repo = makeRepo(root, remote, `${name}-repo`);
			writeText(repo, `.plans/traces/${TRACE}.jsonl`, traceText(TRACE));
			const { c, out } = makeContext({ vault, root: repo });
			assert.equal(workPending(c).code, 0, name);
			assert.deepEqual(out, [], name);
		}
	}),
);
