/** Run with: cd pi-plan-dispatch && node --test vault/schema.test.ts (Node 24+) */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
	NOTE_TYPES,
	REQUIRED_PROPS,
	SCHEMA_VERSION,
	TYPE_FOLDER,
	VOCAB,
	fingerprintHash,
	parseNote,
	serializeNote,
	slug,
	validateNote,
	type Note,
	type NoteType,
} from "./schema.ts";

const REPO = "github.com/o/n";
const FINGERPRINT = `${REPO}:src/a.ts:bad-thing`;
const DATES = { created: "2026-10-22", updated: "2026-10-22" };

function validProps(type: NoteType): Record<string, string | string[]> {
	const base = { ...DATES };
	switch (type) {
		case "plan":
			return { ...base, trace: "agent-vault", round: "1", repo: REPO, status: "done" };
		case "run":
			return { ...base, trace: "agent-vault", repo: REPO, status: "done", gate: "pass" };
		case "finding":
			return {
				...base,
				trace: "agent-vault",
				repo: REPO,
				severity: "major",
				fingerprint: FINGERPRINT,
				source: "pair",
				status: "open",
			};
		case "decision":
			return { ...base, project: "demo", repo: REPO };
		case "lesson":
			return { ...base, project: "demo", repo: REPO };
		case "project":
			return { ...base, repos: [REPO] };
		case "codebase":
			return { ...base, repo: REPO, commit: "abc1234", graphify_version: "0.4.1" };
		case "spec":
			return {
				...base,
				trace: "agent-vault",
				repo: REPO,
				status: "confirmed",
				file: "20261022-1328-vault-core.md",
			};
		case "idea":
			return { ...base, status: "open", repo: REPO };
	}
	throw new Error(`no fixture for ${type}`);
}

function validBasename(type: NoteType): string {
	const basenames: Record<NoteType, string> = {
		plan: "20261022-1328-vault-core-r1",
		run: "20261022-1328-vault-core-r1-run",
		finding: `agent-vault-f-${fingerprintHash(FINGERPRINT)}`,
		decision: "decision-demo-use-x",
		lesson: "lesson-demo-avoid-y",
		project: "project-demo",
		codebase: "codebase-o-n",
		spec: "20261022-1328-vault-core-spec",
		idea: "idea-a-new-idea",
	};
	return basenames[type];
}

function makeNote(
	type: NoteType,
	over: Record<string, string | string[]> = {},
	basename?: string,
	body = "Body text.\n",
): Note {
	return { type, basename: basename ?? validBasename(type), props: { ...validProps(type), ...over }, body };
}

function hasErr(note: Note, re: RegExp): boolean {
	return validateNote(note).some((message) => re.test(message));
}

test("constants: schema version, note types, folders, required properties and vocabularies", () => {
	assert.equal(SCHEMA_VERSION, 1);
	assert.deepEqual([...NOTE_TYPES], [
		"plan",
		"run",
		"finding",
		"decision",
		"lesson",
		"project",
		"codebase",
		"spec",
		"idea",
	]);
	assert.deepEqual(TYPE_FOLDER, {
		plan: "plans",
		run: "runs",
		finding: "findings",
		decision: "decisions",
		lesson: "lessons",
		project: "projects",
		codebase: "codebases",
		spec: "specs",
		idea: "ideas",
	});
	assert.deepEqual(REQUIRED_PROPS.plan, ["trace", "round", "repo", "status"]);
	assert.deepEqual(REQUIRED_PROPS.run, ["trace", "repo", "status", "gate"]);
	assert.deepEqual(REQUIRED_PROPS.finding, ["trace", "repo", "severity", "fingerprint", "source", "status"]);
	assert.deepEqual(REQUIRED_PROPS.decision, ["project", "repo"]);
	assert.deepEqual(REQUIRED_PROPS.lesson, ["project", "repo"]);
	assert.deepEqual(REQUIRED_PROPS.project, ["repos"]);
	assert.deepEqual(REQUIRED_PROPS.codebase, ["repo", "commit", "graphify_version"]);
	assert.deepEqual(REQUIRED_PROPS.spec, ["trace", "repo", "status", "file"]);
	assert.deepEqual(REQUIRED_PROPS.idea, ["status", "repo"]);
	assert.deepEqual(VOCAB, {
		planRunStatus: ["done", "failed"],
		planStatus: ["draft", "ready", "done", "failed"],
		specStatus: ["draft", "confirmed", "done"],
		ideaStatus: ["open", "taken", "dropped"],
		audit: ["pass", "fail"],
		gate: ["pass", "fail"],
		findingStatus: ["open", "closed"],
		source: ["plan-audit", "auditor", "pair", "security", "gate"],
		severity: ["blocker", "major", "minor", "error", "warn", "info"],
	});
});

test("slug: lowercases, joins runs, trims and cuts to 60", () => {
	assert.equal(slug("Hello, World!!"), "hello-world");
	assert.equal(slug("a_b.c"), "a-b-c");
	assert.equal(slug("---a---"), "a");
	assert.equal(slug("  Mixed CASE  "), "mixed-case");
	assert.equal(slug("A/B"), "a-b");
	assert.equal(slug(""), "");
	const long = slug(`${"x".repeat(100)} tail`);
	assert.equal(long.length, 60);
	assert.equal(long, "x".repeat(60));
	// The cut can leave a trailing dash, which the second trim removes.
	assert.equal(slug(`${"a".repeat(59)}-b`), "a".repeat(59));
});

test("fingerprintHash: first 8 hex characters of the sha1", () => {
	const want = createHash("sha1").update(FINGERPRINT, "utf8").digest("hex").slice(0, 8);
	assert.equal(fingerprintHash(FINGERPRINT), want);
	assert.match(fingerprintHash("anything"), /^[0-9a-f]{8}$/);
});

test("validateNote accepts one valid note of each type", () => {
	for (const type of NOTE_TYPES) {
		assert.deepEqual(validateNote(makeNote(type)), [], type);
	}
});

test("validateNote allows extra properties and lists", () => {
	const note = makeNote("finding", {
		plan: "[[20261022-1328-vault-core-r1]]",
		tags: ["gate", "security"],
	});
	assert.deepEqual(validateNote(note), []);
});

test("validateNote rejects an unknown type with that single error", () => {
	const note = makeNote("run");
	note.type = "memo" as NoteType;
	assert.deepEqual(validateNote(note), ["unknown note type: memo"]);
});

test("validateNote rejects created and updated that are not YYYY-MM-DD", () => {
	for (const key of ["created", "updated"]) {
		const note = makeNote("run", { [key]: "22-10-2026" });
		assert.ok(hasErr(note, new RegExp(`${key} must be YYYY-MM-DD`)), validateNote(note).join("; "));
	}
});

test("validateNote rejects a required property that is missing, empty or an empty list", () => {
	const missing = makeNote("run");
	delete missing.props.gate;
	assert.ok(hasErr(missing, /missing required property: gate/), validateNote(missing).join("; "));

	const undefinedValue = makeNote("plan", { trace: undefined as unknown as string });
	assert.ok(hasErr(undefinedValue, /missing required property: trace/), validateNote(undefinedValue).join("; "));

	const emptyString = makeNote("plan", { trace: "" });
	assert.ok(hasErr(emptyString, /missing required property: trace/), validateNote(emptyString).join("; "));

	const emptyList = makeNote("project", { repos: [] });
	assert.ok(hasErr(emptyList, /missing required property: repos/), validateNote(emptyList).join("; "));
});

test("validateNote rejects absolute paths, line breaks and non-string values", () => {
	assert.ok(hasErr(makeNote("run", { trace: "/etc/passwd" }), /trace must not be an absolute path/));
	assert.ok(hasErr(makeNote("run", { trace: "~/notes" }), /trace must not be an absolute path/));
	assert.ok(hasErr(makeNote("run", { trace: "C:\\temp\\x" }), /trace must not be an absolute path/));
	assert.ok(hasErr(makeNote("run", { trace: "two\nlines" }), /trace must be a one-line string/));
	assert.ok(hasErr(makeNote("project", { repos: [REPO, "~/x"] }), /repos must not be an absolute path/));
	assert.ok(hasErr(makeNote("project", { repos: ["a\nb"] }), /repos must be a one-line string/));
	assert.ok(hasErr(makeNote("run", { trace: 7 as unknown as string }), /trace must be a string or a list of strings/));
});

test("validateNote rejects basenames that break the naming rules", () => {
	assert.ok(hasErr(makeNote("plan", {}, "Feat-R1"), /basename must match/));
	assert.ok(hasErr(makeNote("plan", {}, "feat--r1"), /basename must match/));
	assert.ok(hasErr(makeNote("plan", {}, "feat-r1-"), /basename must match/));
	assert.ok(hasErr(makeNote("run", {}, "feat-r1"), /a run basename must end with -run/));
	assert.ok(hasErr(makeNote("finding", {}, "agent-vault"), /must end with -f-<8 hex>/));
	assert.ok(hasErr(makeNote("finding", {}, "agent-vault-f-00000000"), /hash must equal fingerprintHash/));
	assert.ok(hasErr(makeNote("decision", {}, "demo-use-x"), /must start with decision-/));
	assert.ok(hasErr(makeNote("lesson", {}, "demo-avoid-y"), /must start with lesson-/));
	assert.ok(hasErr(makeNote("project", {}, "demo"), /must start with project-/));
	assert.ok(hasErr(makeNote("codebase", {}, "o-n"), /must start with codebase-/));
	assert.ok(hasErr(makeNote("spec", {}, "agent-vault"), /a spec basename must end with -spec/));
	assert.ok(hasErr(makeNote("idea", {}, "a-new-idea"), /a idea basename must start with idea-/));
});

test("validateNote rejects values outside their vocabulary", () => {
	assert.ok(hasErr(makeNote("plan", { status: "running" }), /status must be one of: draft, ready, done, failed/));
	assert.ok(hasErr(makeNote("run", { status: "draft" }), /status must be one of: done, failed/));
	assert.ok(hasErr(makeNote("run", { status: "running" }), /status must be one of: done, failed/));
	assert.ok(hasErr(makeNote("spec", { status: "open" }), /status must be one of: draft, confirmed, done/));
	assert.ok(hasErr(makeNote("idea", { status: "closed" }), /status must be one of: open, taken, dropped/));
	assert.ok(hasErr(makeNote("plan", { audit: "maybe" }), /audit must be one of: pass, fail/));
	assert.ok(hasErr(makeNote("run", { gate: "maybe" }), /gate must be one of: pass, fail/));
	assert.ok(hasErr(makeNote("finding", { status: "done" }), /status must be one of: open, closed/));
	assert.ok(hasErr(makeNote("finding", { source: "sonnet" }), /source must be one of/));
	assert.ok(hasErr(makeNote("finding", { severity: "medium" }), /severity must be one of/));
});

test("validateNote accepts every value of each status vocabulary", () => {
	for (const status of VOCAB.planStatus) {
		assert.deepEqual(validateNote(makeNote("plan", { status })), [], status);
	}
	for (const status of VOCAB.specStatus) {
		assert.deepEqual(validateNote(makeNote("spec", { status })), [], status);
	}
	for (const status of VOCAB.ideaStatus) {
		assert.deepEqual(validateNote(makeNote("idea", { status })), [], status);
	}
	for (const status of VOCAB.planRunStatus) {
		assert.deepEqual(validateNote(makeNote("run", { status })), [], status);
	}
	for (const audit of VOCAB.audit) {
		assert.deepEqual(validateNote(makeNote("plan", { audit })), [], audit);
	}
});

test("validateNote checks the file property of spec and plan notes", () => {
	const noFile = makeNote("spec");
	delete noFile.props.file;
	assert.ok(hasErr(noFile, /missing required property: file/), validateNote(noFile).join("; "));

	const BAD_FILE = /file must be a plain file name ending in \.md/;
	for (const file of ["a/b.md", "a..b.md", "..x.md", "x.txt", ".hidden.md", ""]) {
		assert.ok(hasErr(makeNote("spec", { file }), BAD_FILE), file);
	}
	assert.ok(hasErr(makeNote("plan", { file: "a/b.md" }), BAD_FILE));
	assert.ok(hasErr(makeNote("plan", { file: "..p.md" }), BAD_FILE));

	assert.deepEqual(validateNote(makeNote("spec", { file: "20261022-1328-vault-core.md" })), []);
	assert.deepEqual(validateNote(makeNote("plan", { file: "20261022-1328-vault-core-r1.md" })), []);
	assert.deepEqual(validateNote(makeNote("plan")), [], "file stays optional on a plan note");
});

test("validateNote checks a plan note's audit_round", () => {
	assert.deepEqual(validateNote(makeNote("plan", { audit: "pass", audit_round: "1" })), []);
	assert.deepEqual(validateNote(makeNote("plan", { audit: "fail", audit_round: "12" })), []);
	const BAD_ROUND = /audit_round must be a positive whole number/;
	for (const round of ["0", "01", "1.5", "-1", "x", ""]) {
		assert.ok(hasErr(makeNote("plan", { audit_round: round }), BAD_ROUND), round);
	}
});

test("an old plan note with status done and no file stays valid", () => {
	const note = makeNote("plan", { status: "done" });
	assert.equal("file" in note.props, false);
	assert.deepEqual(validateNote(note), []);
});

test("validateNote rejects repos that are not slugs and - outside decision, lesson and idea", () => {
	assert.ok(hasErr(makeNote("run", { repo: "github.com" }), /repo must be a slug/));
	assert.ok(hasErr(makeNote("run", { repo: "GitHub.com/O/N" }), /repo must be a slug/));
	assert.ok(hasErr(makeNote("finding", { repo: "-" }), /repo - is allowed on decision, lesson and idea notes only/));
	for (const type of ["spec", "plan", "run"] as NoteType[]) {
		assert.ok(
			hasErr(makeNote(type, { repo: "-" }), /repo - is allowed on decision, lesson and idea notes only/),
			type,
		);
	}
	assert.deepEqual(validateNote(makeNote("decision", { repo: "-" })), []);
	assert.deepEqual(validateNote(makeNote("lesson", { repo: "-" })), []);
	assert.deepEqual(validateNote(makeNote("idea", { repo: "-" })), []);
});

test("validateNote checks every project repos entry", () => {
	assert.deepEqual(validateNote(makeNote("project", { repos: [REPO, "github.com/o/m"] })), []);
	assert.ok(hasErr(makeNote("project", { repos: [REPO, "github.com"] }), /repos entry must be a slug/));
	assert.ok(hasErr(makeNote("project", { repos: [REPO, "-"] }), /repos entry must be a slug/));
	assert.ok(hasErr(makeNote("project", { repos: REPO }), /repos must be a list/));
});

test("validateNote rejects a list where a single value belongs", () => {
	assert.ok(hasErr(makeNote("run", { status: ["done"] }), /status must be one of/));
	assert.ok(hasErr(makeNote("run", { repo: [REPO] }), /repo must be a single slug/));
});

test("serializeNote writes type, created, updated, required properties in order, then the rest sorted", () => {
	const note: Note = {
		type: "run",
		basename: "20261022-1328-vault-core-r1-run",
		props: {
			zeta: "z",
			updated: "2026-10-23",
			gate: "pass",
			created: "2026-10-22",
			status: "done",
			repo: REPO,
			trace: "agent-vault",
			alpha: "a",
		},
		body: "Digest.\n",
	};
	assert.equal(
		serializeNote(note),
		[
			"---",
			"type: run",
			"created: 2026-10-22",
			"updated: 2026-10-23",
			"trace: agent-vault",
			`repo: ${REPO}`,
			"status: done",
			"gate: pass",
			"alpha: a",
			"zeta: z",
			"---",
			"Digest.\n",
		].join("\n"),
	);
});

test("serializeNote writes a list as key plus items and an empty list as a bare key", () => {
	const note = makeNote("project", { repos: [REPO, "github.com/o/m"] });
	const text = serializeNote(note);
	assert.ok(text.includes(`repos:\n  - ${REPO}\n  - github.com/o/m\n`), text);

	const empty = makeNote("project", { repos: [] });
	const emptyText = serializeNote(empty);
	assert.ok(emptyText.includes("repos:\n---\n"), emptyText);
	assert.deepEqual(parseNote(empty.basename, emptyText).props.repos, []);
});

test("serializeNote quotes a value or list item that would not parse back bare", () => {
	const quoted = [
		"",
		" leading",
		"trailing ",
		'"quoted"',
		"'single",
		"[list]",
		"]",
		"{map}",
		"}",
		">block",
		"|pipe",
		"*star",
		"&anchor",
		"!tag",
		"%percent",
		"@at",
		"`tick`",
		",comma",
		"-dash",
		"#hash",
		"?question",
		":colon",
		"ends:",
		"has: space",
		"has # hash",
		"line\nbreak",
	];
	for (const value of quoted) {
		const line = serializeNote(makeNote("lesson", { note: value }))
			.split("\n")
			.find((l) => l.startsWith("note: "));
		assert.equal(line, `note: ${JSON.stringify(value)}`, JSON.stringify(value));
	}
	const bare = ["plain", "a:b", "has#hash", "a-b", "C:no", "x/y"];
	for (const value of bare) {
		const line = serializeNote(makeNote("lesson", { note: value }))
			.split("\n")
			.find((l) => l.startsWith("note: "));
		assert.equal(line, `note: ${value}`, value);
	}
	const list = serializeNote(makeNote("lesson", { tags: ["plain", "has: space", "-leading"] }));
	assert.ok(list.includes('  - plain\n  - "has: space"\n  - "-leading"\n'), list);
});

test("serializeNote(parseNote(x, serializeNote(n))) equals serializeNote(n)", () => {
	const note = makeNote("finding", {
		source: "plan-audit",
		title: "Keep the format: stable # even with tabs",
		tags: ["a", "b: c", "#hash", "-dash"],
		ref: "Use [[20261022-1328-vault-core-r1]] here",
	});
	const text = serializeNote(note);
	const back = parseNote(note.basename, text);
	assert.equal(back.type, note.type);
	assert.deepEqual(back.props, note.props);
	assert.equal(back.body, note.body);
	assert.equal(serializeNote(back), text);
});

test("parseNote reads frontmatter, lists and the body", () => {
	const text = [
		"---",
		"type: project",
		"created: 2026-10-22",
		"updated: 2026-10-22",
		"repos:",
		`  - ${REPO}`,
		"  - github.com/o/m",
		"---",
		"Lives here.",
		"",
	].join("\n");
	assert.deepEqual(parseNote("project-demo", text), {
		type: "project",
		basename: "project-demo",
		props: { created: "2026-10-22", updated: "2026-10-22", repos: [REPO, "github.com/o/m"] },
		body: "Lives here.\n",
	});
});

test("serializeNote round-trips a spec note with host", () => {
	const note: Note = {
		type: "spec",
		basename: "20261022-1328-vault-core-spec",
		props: {
			created: "2026-10-22",
			updated: "2026-10-22",
			trace: "agent-vault",
			repo: REPO,
			status: "confirmed",
			file: "20261022-1328-vault-core.md",
			host: "mac mini: one",
		},
		body: "# Spec\n\nText with a [[link]].\n",
	};
	assert.deepEqual(validateNote(note), []);
	const back = parseNote(note.basename, serializeNote(note));
	assert.deepEqual(back, note);
	assert.equal(serializeNote(back), serializeNote(note));
});

test("serializeNote round-trips a plan note with file, audit, audit_round and host", () => {
	const note: Note = {
		type: "plan",
		basename: "20261022-1328-vault-core-r1",
		props: {
			...DATES,
			trace: "agent-vault",
			round: "1",
			repo: REPO,
			status: "ready",
			file: "20261022-1328-vault-core-r1.md",
			audit: "pass",
			audit_round: "2",
			host: "macbook",
		},
		body: "Plan text.\n",
	};
	assert.deepEqual(validateNote(note), []);
	const back = parseNote(note.basename, serializeNote(note));
	assert.deepEqual(back, note);
	assert.equal(serializeNote(back), serializeNote(note));
});

test("a body that holds --- lines survives a round trip", () => {
	const body = "Line one\n---\nstatus: fake\n---\nEnd.\n";
	const note = makeNote("spec", {}, "20261022-1328-vault-core-spec", body);
	const back = parseNote(note.basename, serializeNote(note));
	assert.equal(back.body, body);
	assert.deepEqual(back.props, note.props);
	assert.deepEqual(validateNote(back), []);
});

test("parseNote throws on bad frontmatter", () => {
	assert.throws(() => parseNote("x", "no frontmatter"), /must start with ---/);
	assert.throws(() => parseNote("x", "--- type: run\n---\n"), /must start with ---/);
	assert.throws(() => parseNote("x", "---\ntype: run\ncreated: 2026-10-22\n"), /no closing ---/);
	assert.throws(() => parseNote("x", "---\ncreated: 2026-10-22\n---\n"), /no type/);
	assert.throws(() => parseNote("x", "---\ntype: run\nbadline\n---\n"), /bad frontmatter line/);
	assert.throws(() => parseNote("x", "---\ntype: run\n  - orphan\n---\n"), /list item without a key/);
	assert.throws(() => parseNote("x", '---\ntype: run\ntrace: "unterminated\n---\n'), /bad quoted value/);
});
