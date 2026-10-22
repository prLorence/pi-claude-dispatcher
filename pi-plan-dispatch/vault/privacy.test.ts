/** Run with: cd pi-plan-dispatch && node --test vault/privacy.test.ts (Node 24+) */
import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeRemote } from "./url.ts";
import {
	checkNote,
	leaksNoneRepo,
	modeFor,
	parseRepos,
	renderMetaRunBody,
	type Repos,
} from "./privacy.ts";
import type { Note } from "./schema.ts";

const FULL = "github.com/owner/full";
const META = "github.com/owner/meta";
const NONE = "github.com/secret/none";

function reposJson(): string {
	return JSON.stringify({
		repos: {
			[FULL]: { mode: "full" },
			[META]: { mode: "meta" },
			[NONE]: { mode: "none" },
		},
		aliases: {},
	});
}

function note(type: Note["type"], props: Record<string, string | string[]>, body = ""): Note {
	return { type, basename: "test-note", props, body };
}

function malformed(repos: Repos): boolean {
	return repos.malformed === true && Object.keys(repos.repos).length === 0;
}

test("parseRepos treats missing, invalid and shapeless input as malformed", () => {
	for (const input of [
		undefined,
		"",
		"not json",
		"null",
		"[]",
		"{}",
		JSON.stringify({ aliases: {} }),
		JSON.stringify({ repos: [] }),
		JSON.stringify({ repos: null }),
	]) {
		const repos = parseRepos(input);
		assert.ok(malformed(repos), String(input));
		assert.deepEqual(repos.aliases, {});
	}
});

test("parseRepos rejects a bad mode and keeps no repos", () => {
	const repos = parseRepos(
		JSON.stringify({ repos: { [FULL]: { mode: "full" }, [META]: { mode: "public" } } }),
	);
	assert.ok(malformed(repos));
	assert.deepEqual(repos.repos, {});
});

test("parseRepos accepts valid entries and defaults aliases", () => {
	const repos = parseRepos(reposJson());
	assert.equal(repos.malformed, undefined);
	assert.deepEqual(repos.aliases, {});
	assert.deepEqual(repos.repos, {
		[FULL]: { mode: "full" },
		[META]: { mode: "meta" },
		[NONE]: { mode: "none" },
	});
});

test("parseRepos lowercases a key that already is a slug", () => {
	const repos = parseRepos(JSON.stringify({ repos: { "GitHub.COM/Owner/Full": { mode: "full" } } }));
	assert.deepEqual(repos.repos, { [FULL]: { mode: "full" } });
});

test("parseRepos normalises URI keys and applies aliases", () => {
	const aliases = { work: "github.com" };
	const repos = parseRepos(
		JSON.stringify({
			repos: {
				"git@github.com:owner/full.git": { mode: "full" },
				"https://github.com/owner/meta.git": { mode: "meta" },
				"git@work:secret/none.git": { mode: "none" },
			},
			aliases,
		}),
	);
	assert.equal(repos.malformed, undefined);
	assert.deepEqual(repos.aliases, aliases);
	assert.deepEqual(repos.repos, {
		[FULL]: { mode: "full" },
		[META]: { mode: "meta" },
		[NONE]: { mode: "none" },
	});
});

test("parseRepos makes the whole object malformed on an unnormalisable key", () => {
	const repos = parseRepos(
		JSON.stringify({ repos: { [FULL]: { mode: "full" }, "file:///tmp/x/y": { mode: "full" } } }),
	);
	assert.ok(malformed(repos));
	assert.deepEqual(repos.repos, {});
});

test("parseRepos normalises across every accepted URI form", () => {
	for (const form of [
		"git@github.com:owner/full.git",
		"ssh://git@github.com/owner/full.git",
		"https://github.com/owner/full.git",
		"git://github.com/owner/full.git",
	]) {
		const repos = parseRepos(JSON.stringify({ repos: { [form]: { mode: "full" } } }));
		assert.deepEqual(repos.repos, { [FULL]: { mode: "full" } }, form);
	}
});

test("modeFor fails closed for undefined, malformed, unlisted and invalid modes", () => {
	const repos = parseRepos(reposJson());
	assert.equal(modeFor(repos, undefined), "none");
	assert.equal(modeFor(repos, "github.com/owner/unknown"), "none");
	assert.equal(modeFor(parseRepos(undefined), FULL), "none");
	const broken = parseRepos(JSON.stringify({ repos: { [FULL]: { mode: "bogus" } } }));
	assert.equal(modeFor(broken, FULL), "none");
	const forged: Repos = { repos: { [FULL]: { mode: "public" as never } }, aliases: {} };
	assert.equal(modeFor(forged, FULL), "none");
});

test("modeFor returns the listed mode", () => {
	const repos = parseRepos(reposJson());
	assert.equal(modeFor(repos, FULL), "full");
	assert.equal(modeFor(repos, META), "meta");
	assert.equal(modeFor(repos, NONE), "none");
	assert.equal(modeFor(repos, FULL.toUpperCase()), "full");
});

test("leaksNoneRepo finds the full slug and owner/name, in any case", () => {
	const repos = parseRepos(reposJson());
	// The full slug also contains the short needle at a token boundary.
	assert.deepEqual(leaksNoneRepo(repos, `see ${NONE} for details`), [NONE, "secret/none"]);
	assert.deepEqual(leaksNoneRepo(repos, "see secret/none for details"), ["secret/none"]);
	assert.deepEqual(leaksNoneRepo(repos, "see GITHUB.COM/Secret/None"), [NONE, "secret/none"]);
	assert.deepEqual(leaksNoneRepo(repos, "secret/NONE is here"), ["secret/none"]);
	assert.deepEqual(leaksNoneRepo(repos, `${NONE} and secret/none`), [NONE, "secret/none"]);
});

test("leaksNoneRepo does not hit a similar slug or a partial token", () => {
	const repos = parseRepos(reposJson());
	assert.deepEqual(leaksNoneRepo(repos, "o/xy"), []);
	assert.deepEqual(leaksNoneRepo(repos, "secret/nonexistent"), []);
	assert.deepEqual(leaksNoneRepo(repos, "mysecret/none"), []);
	assert.deepEqual(leaksNoneRepo(repos, "github.com.secret/none"), []);
	// The full slug is glued to a letter, but its short needle is not.
	assert.deepEqual(leaksNoneRepo(repos, "x" + NONE), ["secret/none"]);
	assert.deepEqual(leaksNoneRepo(repos, `${NONE}-fork`), []);
	assert.deepEqual(leaksNoneRepo(repos, ""), []);
});

test("leaksNoneRepo ignores full and meta repos", () => {
	const repos = parseRepos(reposJson());
	assert.deepEqual(leaksNoneRepo(repos, `${FULL} ${META} owner/full owner/meta`), []);
	assert.deepEqual(leaksNoneRepo(parseRepos(undefined), NONE), []);
});

test("renderMetaRunBody writes the fixed key order and joins lists", () => {
	const props = {
		faults: ["warn", "error"],
		gate: "pass",
		tasks_done: "3",
		tasks_failed: "0",
		cost: "0.12",
		models: ["sonnet", "deepseek"],
		ignored: "nope",
	};
	assert.equal(
		renderMetaRunBody(props),
		[
			"- gate: pass",
			"- tasks_done: 3",
			"- tasks_failed: 0",
			"- cost: 0.12",
			"- models: sonnet, deepseek",
			"- faults: warn, error",
			"",
		].join("\n"),
	);
});

test("renderMetaRunBody returns an empty string when no key is present", () => {
	assert.equal(renderMetaRunBody({}), "");
	assert.equal(renderMetaRunBody({ other: "x" }), "");
	assert.equal(renderMetaRunBody({ gate: "fail" }), "- gate: fail\n");
});

test("checkNote allows every type in a full repo", () => {
	const repos = parseRepos(reposJson());
	for (const type of ["plan", "run", "finding", "decision", "lesson", "codebase"] as const) {
		assert.deepEqual(checkNote(repos, note(type, { repo: FULL }, "anything goes")), [], type);
	}
});

test("checkNote rejects an unlisted repo, no repo, and a none repo", () => {
	const repos = parseRepos(reposJson());
	assert.deepEqual(checkNote(repos, note("run", { repo: "github.com/owner/unknown" }), "x"), [
		"repo github.com/owner/unknown is not allowed",
	]);
	assert.deepEqual(checkNote(repos, note("decision", {}, "x")), ["repo (none) is not allowed"]);
	assert.deepEqual(checkNote(repos, note("run", { repo: NONE }, "x")), [
		`repo ${NONE} is not allowed`,
	]);
	assert.equal(checkNote(parseRepos(undefined), note("run", { repo: FULL }, "x")).length, 1);
});

test("checkNote in meta mode allows only run, decision and lesson", () => {
	const repos = parseRepos(reposJson());
	for (const type of ["plan", "finding", "codebase"] as const) {
		assert.deepEqual(checkNote(repos, note(type, { repo: META }, "x")), [
			`${type} notes are not allowed for a meta repo`,
		]);
	}
	assert.deepEqual(checkNote(repos, note("decision", { repo: META }, "plain text")), []);
	assert.deepEqual(checkNote(repos, note("lesson", { repo: META }, "plain text")), []);
});

test("checkNote meta run body must match the meta fields", () => {
	const repos = parseRepos(reposJson());
	const props = { repo: META, gate: "pass", tasks_done: "2", tasks_failed: "0" };
	const body = renderMetaRunBody(props);
	assert.deepEqual(checkNote(repos, note("run", props, body)), []);
	assert.deepEqual(checkNote(repos, note("run", props, `\n${body}\n`)), []);
	assert.deepEqual(checkNote(repos, note("run", props, body.replace("pass", "fail"))), [
		"run body must match its meta fields",
	]);
	assert.deepEqual(checkNote(repos, note("run", { repo: META, gate: "pass" }, "free text")), [
		"run body must match its meta fields",
	]);
});

test("checkNote meta decision/lesson bodies reject fenced code", () => {
	const repos = parseRepos(reposJson());
	for (const body of ["```\ncode\n```", "text\n   ```js", "\t```"]) {
		assert.deepEqual(checkNote(repos, note("decision", { repo: META }, body)), [
			"meta decision body must not contain fenced code blocks",
		]);
		assert.deepEqual(checkNote(repos, note("lesson", { repo: META }, body)), [
			"meta lesson body must not contain fenced code blocks",
		]);
	}
	assert.deepEqual(checkNote(repos, note("decision", { repo: META }, "a `inline` fence")), []);
});

test("checkNote meta decision/lesson bodies reject tracked file paths", () => {
	const repos = parseRepos(reposJson());
	const tracked = new Set(["src/app.ts", "lib/deep/module.ts"]);
	assert.deepEqual(
		checkNote(repos, note("decision", { repo: META }, "see src/app.ts for the seam"), tracked),
		["meta decision body must not name a tracked file: src/app.ts"],
	);
	assert.deepEqual(
		checkNote(repos, note("lesson", { repo: META }, "changed `lib/deep/module.ts`."), tracked),
		["meta lesson body must not name a tracked file: lib/deep/module.ts"],
	);
	assert.deepEqual(
		checkNote(repos, note("lesson", { repo: META }, "(src/app.ts),"), tracked),
		["meta lesson body must not name a tracked file: src/app.ts"],
	);
	assert.deepEqual(checkNote(repos, note("decision", { repo: META }, "see other/file.ts"), tracked), []);
	assert.deepEqual(checkNote(repos, note("decision", { repo: META }, "see src/app.ts")), []);
});

test("checkNote holds a '-' repo to the meta rules", () => {
	const repos = parseRepos(reposJson());
	assert.deepEqual(checkNote(repos, note("decision", { repo: "-" }, "plain")), []);
	assert.deepEqual(checkNote(repos, note("lesson", { repo: "-" }, "plain")), []);
	assert.deepEqual(checkNote(repos, note("plan", { repo: "-" }, "plain")), [
		"plan notes are not allowed for a meta repo",
	]);
	assert.deepEqual(checkNote(repos, note("decision", { repo: "-" }, "```\nx\n```")), [
		"meta decision body must not contain fenced code blocks",
	]);
	const runProps = { repo: "-", gate: "pass" };
	assert.deepEqual(checkNote(repos, note("run", runProps, renderMetaRunBody(runProps))), []);
});

test("checkNote checks every project repos entry", () => {
	const repos = parseRepos(reposJson());
	assert.deepEqual(checkNote(repos, note("project", { repos: [FULL, META] }, "ok")), []);
	assert.deepEqual(checkNote(repos, note("project", { repos: [FULL, NONE] }, "ok")), [
		`project repos entry ${NONE} is not allowed`,
	]);
	assert.deepEqual(checkNote(repos, note("project", { repos: FULL }, "ok")), []);
	assert.deepEqual(checkNote(repos, note("project", { repos: ["github.com/owner/unknown"] })), [
		"project repos entry github.com/owner/unknown is not allowed",
	]);
});

test("checkNote applies the leak rule to bodies and property values", () => {
	const repos = parseRepos(reposJson());
	const both = [
		`names a repo that is not allowed: ${NONE}`,
		"names a repo that is not allowed: secret/none",
	];
	assert.deepEqual(
		checkNote(repos, note("decision", { repo: FULL }, `notes on ${NONE}`)),
		both,
	);
	assert.deepEqual(checkNote(repos, note("lesson", { repo: FULL }, "secret/none taught us")), [
		"names a repo that is not allowed: secret/none",
	]);
	assert.deepEqual(
		checkNote(
			repos,
			note("plan", { repo: FULL, trace: "t-1", notes: [`about ${NONE}`] }, "ok"),
		),
		both,
	);
	assert.deepEqual(checkNote(repos, note("project", { repos: [FULL] }, `see ${NONE}`)), both);
});

test("checkNote does not leak-check the repo and repos properties", () => {
	const repos = parseRepos(reposJson());
	assert.deepEqual(checkNote(repos, note("run", { repo: NONE, extra: "x" }, "clean")), [
		`repo ${NONE} is not allowed`,
	]);
	assert.deepEqual(checkNote(repos, note("project", { repos: [] }, "clean")), []);
});

test("checkNote reports each leak once", () => {
	const repos = parseRepos(reposJson());
	const errors = checkNote(
		repos,
		note("lesson", { repo: FULL, project: NONE }, `${NONE} ${NONE}`),
	);
	assert.deepEqual(errors, [
		`names a repo that is not allowed: ${NONE}`,
		"names a repo that is not allowed: secret/none",
	]);
});

test("parseRepos and checkNote agree on a normalised URI key", () => {
	const repos = parseRepos(
		JSON.stringify({
			repos: {
				[FULL]: { mode: "full" },
				"git@github.com:secret/none.git": { mode: "none" },
			},
		}),
	);
	assert.equal(modeFor(repos, NONE), "none");
	const slug = normalizeRemote("git@github.com:secret/none.git");
	assert.equal(slug, NONE);
	assert.deepEqual(checkNote(repos, note("decision", { repo: FULL }, `about ${slug}`)), [
		`names a repo that is not allowed: ${NONE}`,
		"names a repo that is not allowed: secret/none",
	]);
});
