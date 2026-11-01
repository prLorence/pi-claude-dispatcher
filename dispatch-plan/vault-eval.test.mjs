/** Run with: node --test dispatch-plan/vault-eval.test.mjs (Node 24+) */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { evalAdd, evalList } from "./vault-eval.mjs";

const cli = path.join(import.meta.dirname, "vault.mjs");
const dispatcher = path.resolve(import.meta.dirname, "..", "pi-plan-dispatch");

/** The real vault modules of this repo, loaded the way vault.mjs loads them. */
function loadModule(name) {
	return import(pathToFileURL(path.join(dispatcher, "vault", name)).href);
}

const [schema, notes, privacy, url, lock, git] = await Promise.all(
	["schema.ts", "notes.ts", "privacy.ts", "url.ts", "lock.ts", "git.ts"].map(loadModule),
);
const modules = { schema, notes, privacy, url, lock, git };

const FULL_REPO = "github.com/o/n";
const NONE_REPO = "github.com/o/secret";

function writeText(root, relative, text) {
	const file = path.join(root, ...relative.split("/"));
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
	return file;
}

function note(type, basename, body) {
	return `---\ntype: ${type}\nproject: p\nrepo: -\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n${body}\n`;
}

/** A vault with two knowledge notes and a none-mode repo for the leak check. */
function makeVault(root) {
	const vault = path.join(root, "vault");
	fs.mkdirSync(vault, { recursive: true });
	fs.mkdirSync(path.join(vault, ".git"), { recursive: true });
	const repos = { [FULL_REPO]: { mode: "full" }, [NONE_REPO]: { mode: "none" } };
	writeText(vault, "repos.json", `${JSON.stringify({ repos, aliases: {} }, null, 2)}\n`);
	writeText(vault, "decisions/decision-alpha.md", note("decision", "decision-alpha", "Alpha decision."));
	writeText(vault, "lessons/lesson-beta.md", note("lesson", "lesson-beta", "Beta lesson."));
	return vault;
}

function makeContext(vault) {
	const out = [];
	const err = [];
	return { c: { vault, root: path.dirname(vault), modules, out: (t) => out.push(t), err: (t) => err.push(t) }, out, err };
}

function goldenFile(vault) {
	return path.join(vault, "eval", "golden.json");
}

function bytesOf(vault) {
	try {
		return fs.readFileSync(goldenFile(vault), "utf8");
	} catch {
		return undefined;
	}
}

function withRoot(body) {
	return async () => {
		const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vault-eval-")));
		try {
			await body({ root, vault: makeVault(root) });
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	};
}

test(
	"an add appends the entry, writes the file shape and lists it back",
	withRoot(async ({ vault }) => {
		const { c, out, err } = makeContext(vault);
		const added = evalAdd(c, { query: "  alpha decision  ", expect: "decision-alpha" });
		assert.equal(added.code, 0);
		assert.deepEqual(err, []);
		assert.equal(out[0], goldenFile(vault));
		assert.deepEqual(added.event, { kind: "vault.write", data: { type: "eval", op: "add" } });
		assert.equal(
			bytesOf(vault),
			'[\n  {\n    "query": "alpha decision",\n    "expect": "decision-alpha"\n  }\n]\n',
		);

		const listed = evalList(makeContext(vault).c);
		assert.equal(listed.code, 0);
		assert.deepEqual(makeContext(vault).out, []);
		const listedAgain = makeContext(vault);
		evalList(listedAgain.c);
		assert.deepEqual(listedAgain.out, ["1 | decision-alpha | alpha decision"]);
	}),
);

test(
	"a second add keeps the earlier entry and appends after it",
	withRoot(async ({ vault }) => {
		assert.equal(evalAdd(makeContext(vault).c, { query: "alpha", expect: "decision-alpha" }).code, 0);
		const { c, out } = makeContext(vault);
		assert.equal(evalAdd(c, { query: "beta", expect: "lesson-beta" }).code, 0);
		assert.equal(out[0], goldenFile(vault));
		const listed = makeContext(vault);
		evalList(listed.c);
		assert.deepEqual(listed.out, ["1 | decision-alpha | alpha", "2 | lesson-beta | beta"]);
	}),
);

test(
	"an empty or multi-line query is refused and writes nothing",
	withRoot(async ({ vault }) => {
		for (const query of ["", "   ", "one\ntwo", "one\rtwo"]) {
			const { c, err } = makeContext(vault);
			assert.equal(evalAdd(c, { query, expect: "decision-alpha" }).code, 2);
			assert.equal(err.length, 1);
			assert.equal(bytesOf(vault), undefined);
		}
	}),
);

test(
	"an expected note that does not exist is refused and writes nothing",
	withRoot(async ({ vault }) => {
		const { c, err } = makeContext(vault);
		assert.equal(evalAdd(c, { query: "alpha", expect: "decision-missing" }).code, 2);
		assert.equal(err.length, 1);
		assert.equal(bytesOf(vault), undefined);
	}),
);

test(
	"a query that names a none-mode repo is refused and writes nothing",
	withRoot(async ({ vault }) => {
		const { c, err } = makeContext(vault);
		assert.equal(evalAdd(c, { query: `what about ${NONE_REPO}`, expect: "decision-alpha" }).code, 2);
		assert.equal(err.length, 1);
		assert.match(err[0], /not allowed/);
		assert.equal(bytesOf(vault), undefined);
	}),
);

test(
	"a duplicate pair is refused and leaves the file byte-identical",
	withRoot(async ({ vault }) => {
		assert.equal(evalAdd(makeContext(vault).c, { query: "alpha", expect: "decision-alpha" }).code, 0);
		const before = bytesOf(vault);
		const { c, err } = makeContext(vault);
		assert.equal(evalAdd(c, { query: "  alpha  ", expect: "decision-alpha" }).code, 2);
		assert.equal(err.length, 1);
		assert.equal(bytesOf(vault), before);
	}),
);

test(
	"an unparsable or wrongly shaped golden file is a failure and is left alone",
	withRoot(async ({ vault }) => {
		fs.mkdirSync(path.join(vault, "eval"), { recursive: true });
		for (const text of ["not json", '{"query": "alpha"}\n', '[{"query": "alpha"}]\n', "[]\n[]\n"]) {
			fs.writeFileSync(goldenFile(vault), text);
			const { c, err } = makeContext(vault);
			assert.equal(evalAdd(c, { query: "alpha", expect: "decision-alpha" }).code, 1);
			assert.equal(err.length, 1);
			assert.equal(bytesOf(vault), text);
		}
	}),
);

test(
	"list marks an entry whose expected note is gone",
	withRoot(async ({ vault }) => {
		fs.mkdirSync(path.join(vault, "eval"), { recursive: true });
		fs.writeFileSync(
			goldenFile(vault),
			`${JSON.stringify([{ query: "gone", expect: "decision-gone" }], null, 2)}\n`,
		);
		const { c, out } = makeContext(vault);
		assert.equal(evalList(c).code, 0);
		assert.deepEqual(out, ["1 | decision-gone | gone (missing)"]);
	}),
);

test(
	"list says no entries when the file is absent or empty",
	withRoot(async ({ vault }) => {
		const absent = makeContext(vault);
		assert.equal(evalList(absent.c).code, 0);
		assert.deepEqual(absent.out, ["no entries"]);

		fs.mkdirSync(path.join(vault, "eval"), { recursive: true });
		fs.writeFileSync(goldenFile(vault), "[]\n");
		const empty = makeContext(vault);
		assert.equal(evalList(empty.c).code, 0);
		assert.deepEqual(empty.out, ["no entries"]);
	}),
);

/** Spawn the CLI: no worker flag, no inherited vault, a throwaway HOME. */
function run(root, args, vault) {
	const env = {
		...process.env,
		HOME: path.join(root, "home"),
		PI_PLAN_DISPATCH_DIR: dispatcher,
		AGENT_VAULT: vault,
	};
	delete env.PI_PLAN_DISPATCH_WORKER;
	delete env.AGENT_VAULT_LOCK_WAIT_MS;
	const result = spawnSync(process.execPath, [cli, ...args], {
		env,
		cwd: root,
		encoding: "utf8",
		timeout: 60_000,
	});
	return { code: result.status, out: result.stdout, err: result.stderr };
}

test(
	"the CLI round-trips an entry and returns the documented exit codes",
	withRoot(async ({ root, vault }) => {
		const listed = run(root, ["eval", "list"], vault);
		assert.equal(listed.code, 0);
		assert.equal(listed.out, "no entries\n");

		const added = run(root, ["eval", "add", "--query", "alpha", "--expect", "decision-alpha"], vault);
		assert.equal(added.code, 0);
		assert.equal(added.out, `${goldenFile(vault)}\n`);

		const after = run(root, ["eval", "list"], vault);
		assert.equal(after.code, 0);
		assert.equal(after.out, "1 | decision-alpha | alpha\n");

		const badNote = run(root, ["eval", "add", "--query", "beta", "--expect", "decision-missing"], vault);
		assert.equal(badNote.code, 2);
		assert.match(badNote.err, /no note named decision-missing/);

		const duplicate = run(root, ["eval", "add", "--query", "alpha", "--expect", "decision-alpha"], vault);
		assert.equal(duplicate.code, 2);
		assert.equal(bytesOf(vault), `${JSON.stringify([{ query: "alpha", expect: "decision-alpha" }], null, 2)}\n`);
	}),
);
