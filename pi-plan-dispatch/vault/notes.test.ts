/** Run with: cd pi-plan-dispatch && node --test vault/notes.test.ts (Node 24+) */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { Note, NoteType } from "./schema.ts";
import { NOTE_TYPES, TYPE_FOLDER, serializeNote, slug } from "./schema.ts";
import {
	appendLog,
	bootText,
	buildIndex,
	findVault,
	listNotes,
	notePath,
	readNote,
	readRepos,
	removeNote,
	statsFor,
	writeIndex,
	writeNote,
} from "./notes.ts";

const REPO = "github.com/acme/web";
const OTHER_REPO = "github.com/acme/other";

const makeVault = (): string => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-vault-notes-"));
	for (const type of NOTE_TYPES) fs.mkdirSync(path.join(dir, TYPE_FOLDER[type]), { recursive: true });
	fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# Vault\n\nRules.\n", "utf8");
	fs.writeFileSync(path.join(dir, "log.md"), "", "utf8");
	fs.writeFileSync(
		path.join(dir, "repos.json"),
		JSON.stringify({ repos: { [REPO]: { mode: "full" }, [OTHER_REPO]: { mode: "full" } }, aliases: {} }),
		"utf8",
	);
	return dir;
};

const withVault = (fn: (dir: string) => void): void => {
	const dir = makeVault();
	try {
		fn(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
};

const noteOf = (
	type: NoteType,
	basename: string,
	props: Record<string, string | string[]> = {},
	body = "Body.\n",
): Note => ({
	type,
	basename,
	props: { created: "2026-01-01", updated: "2026-01-01", ...props },
	body,
});

const put = (dir: string, note: Note): void => {
	fs.writeFileSync(notePath(dir, note.type, note.basename), serializeNote(note), "utf8");
};

const putFinding = (
	dir: string,
	basename: string,
	repo: string,
	trace: string,
	created: string,
	fingerprint: string,
	extra: Record<string, string | string[]> = {},
): void => {
	put(
		dir,
		noteOf(
			"finding",
			basename,
			{
				trace,
				repo,
				severity: "major",
				fingerprint,
				source: "pair",
				status: "open",
				created,
				updated: created,
				...extra,
			},
			`Body of ${basename}.\n`,
		),
	);
};

const findingNote = (basename: string, props: Record<string, string | string[]> = {}, body = "Body.\n"): Note =>
	noteOf("finding", basename, { trace: "t-1", repo: REPO, severity: "major", fingerprint: "fp", source: "pair", status: "open", ...props }, body);

const dotFiles = (dir: string): string[] => fs.readdirSync(dir).filter((name: string) => name.startsWith("."));

// 1. writeNote: create, idempotence on another day, a real change, the clash.

test("writeNote: a new note gets today's dates and its folder is created", () => {
	withVault((dir) => {
		fs.rmSync(path.join(dir, "findings"), { recursive: true });
		const note = findingNote("f-new");
		delete note.props.created;
		delete note.props.updated;
		const result = writeNote(dir, note, { today: "2026-02-03" });
		assert.equal(result.path, notePath(dir, "finding", "f-new"));
		assert.equal(result.changed, true);
		const text = fs.readFileSync(result.path, "utf8");
		assert.match(text, /^created: 2026-02-03$/m);
		assert.match(text, /^updated: 2026-02-03$/m);
		assert.deepEqual(dotFiles(path.join(dir, "findings")), [], "no temp file is left behind");
	});
});

test("writeNote: keeps a created date the caller gave on a new note", () => {
	withVault((dir) => {
		const result = writeNote(dir, findingNote("f-created", { created: "2025-12-24" }), { today: "2026-02-03" });
		const text = fs.readFileSync(result.path, "utf8");
		assert.match(text, /^created: 2025-12-24$/m);
		assert.match(text, /^updated: 2026-02-03$/m);
	});
});

test("writeNote: the same note written on two different days stays byte for byte", () => {
	withVault((dir) => {
		const note = findingNote("f-same");
		const first = writeNote(dir, note, { today: "2026-02-03" });
		assert.equal(first.changed, true);
		const before = fs.readFileSync(first.path, "utf8");

		const again = writeNote(dir, note, { today: "2026-04-09" });
		assert.equal(again.changed, false);
		assert.equal(again.path, first.path);
		assert.equal(fs.readFileSync(again.path, "utf8"), before);
		assert.match(before, /^updated: 2026-02-03$/m);
	});
});

test("writeNote: a real change keeps created and advances updated", () => {
	withVault((dir) => {
		const note = findingNote("f-change", { created: "2025-12-24" });
		writeNote(dir, note, { today: "2026-02-03" });
		const result = writeNote(dir, { ...note, body: "New body.\n" }, { today: "2026-03-04" });
		assert.equal(result.changed, true);
		const text = fs.readFileSync(result.path, "utf8");
		assert.match(text, /^created: 2025-12-24$/m);
		assert.match(text, /^updated: 2026-03-04$/m);
		assert.ok(text.endsWith("New body.\n"));
	});
});

test("writeNote: a basename used by another type throws and changes nothing", () => {
	withVault((dir) => {
		const first = writeNote(dir, findingNote("shared-name"), { today: "2026-02-03" });
		const before = fs.readFileSync(first.path, "utf8");
		const project = noteOf("project", "shared-name", { repos: [REPO] });
		assert.throws(() => writeNote(dir, project, { today: "2026-02-03" }), /already used by a finding note/);
		assert.equal(fs.readFileSync(first.path, "utf8"), before);
		assert.equal(fs.existsSync(notePath(dir, "project", "shared-name")), false);
	});
});

// 2. readRepos, notePath, readNote, listNotes, removeNote.

test("readRepos: parses repos.json and treats a missing file as malformed", () => {
	withVault((dir) => {
		const repos = readRepos(dir);
		assert.equal(repos.malformed, undefined);
		assert.equal(repos.repos[REPO]?.mode, "full");
		fs.rmSync(path.join(dir, "repos.json"));
		assert.equal(readRepos(dir).malformed, true);
	});
});

test("notePath is the type folder plus basename.md", () => {
	const dir = path.join(os.tmpdir(), "vault-x");
	assert.equal(notePath(dir, "decision", "decision-web-x"), path.join(dir, "decisions", "decision-web-x.md"));
	assert.equal(notePath(dir, "codebase", "codebase-acme-web"), path.join(dir, "codebases", "codebase-acme-web.md"));
});

test("readNote finds the basename in any type folder and listNotes sorts by basename", () => {
	withVault((dir) => {
		put(dir, findingNote("c-finding"));
		put(dir, noteOf("decision", "a-decision", { project: "web", repo: REPO }));
		put(dir, noteOf("lesson", "b-lesson", { project: "web", repo: REPO }));
		fs.writeFileSync(path.join(dir, "findings", ".hidden.md"), "not a note", "utf8");
		fs.writeFileSync(path.join(dir, "findings", "notes.txt"), "not a note", "utf8");

		const found = readNote(dir, "a-decision");
		assert.equal(found?.type, "decision");
		assert.equal(readNote(dir, "nope"), undefined);
		assert.deepEqual(
			listNotes(dir).map((note) => note.basename),
			["a-decision", "b-lesson", "c-finding"],
		);
	});
});

test("removeNote deletes a note once and reports the second try", () => {
	withVault((dir) => {
		put(dir, findingNote("gone"));
		assert.equal(removeNote(dir, "gone"), true);
		assert.equal(readNote(dir, "gone"), undefined);
		assert.equal(removeNote(dir, "gone"), false);
	});
});

// 3. appendLog.

test("appendLog writes one line with a single space for each line break", () => {
	withVault((dir) => {
		appendLog(dir, {
			ts: "2026-02-03T10:11:12Z",
			host: "mac-1",
			repo: REPO,
			trace: "t-1",
			text: "first line\nsecond\r\nthird",
		});
		appendLog(dir, { ts: "2026-02-04T00:00:00Z", host: "mac-1", repo: "-", trace: "-", text: "plain" });
		const text = fs.readFileSync(path.join(dir, "log.md"), "utf8");
		assert.equal(
			text,
			`- 2026-02-03T10:11:12Z [mac-1] ${REPO} t-1 first line second third\n- 2026-02-04T00:00:00Z [mac-1] - - plain\n`,
		);
	});
});

// 4. buildIndex and writeIndex.

test("buildIndex is deterministic and groups the notes per type", () => {
	withVault((dir) => {
		put(dir, findingNote("f-2"));
		put(dir, findingNote("f-1"));
		put(dir, noteOf("plan", "p-1", { trace: "t-1", round: "1", repo: REPO, status: "done" }));
		const first = buildIndex(dir);
		assert.equal(buildIndex(dir), first);
		assert.equal(
			first,
			"# Index\n## Plans\n- [[p-1]]\n\n## Findings\n- [[f-1]]\n- [[f-2]]\n\n",
		);
		writeIndex(dir);
		assert.equal(fs.readFileSync(path.join(dir, "index.md"), "utf8"), first);
		assert.deepEqual(dotFiles(dir), []);
	});
});

test("buildIndex of an empty vault is just the heading", () => {
	withVault((dir) => {
		assert.equal(buildIndex(dir), "# Index\n");
	});
});

// 5. bootText: order, finding order, exclusions, the log tail, truncation.

test("bootText starts with CLAUDE.md, then the project, the findings, the log tail and the index", () => {
	withVault((dir) => {
		put(dir, noteOf("project", "project-web", { repos: [REPO] }, "Project body.\n"));
		putFinding(dir, "f-minor", REPO, "t-1", "2026-03-01", "fp-minor", { severity: "minor" });
		putFinding(dir, "f-major-old", REPO, "t-1", "2026-01-15", "fp-major-old");
		putFinding(dir, "f-major-new", REPO, "t-1", "2026-02-01", "fp-major-new");
		putFinding(dir, "f-blocker", REPO, "t-1", "2025-12-01", "fp-blocker", { severity: "blocker" });
		putFinding(dir, "f-closed", REPO, "t-1", "2026-04-01", "fp-closed", { status: "closed" });
		putFinding(dir, "f-other", OTHER_REPO, "t-1", "2026-04-01", "fp-other");
		fs.writeFileSync(path.join(dir, "log.md"), "entry-1\nentry-2\n", "utf8");

		const claude = "# Vault\n\nRules.\n";
		const out = bootText(dir, { repo: REPO });
		assert.ok(out.startsWith(claude), "the text starts with CLAUDE.md exactly");
		const headers = [...out.matchAll(/^=== (project|finding) (\S+) ===$/gm)].map((m) => `${m[1]} ${m[2]}`);
		assert.deepEqual(headers, [
			"project project-web",
			"finding f-blocker",
			"finding f-major-new",
			"finding f-major-old",
			"finding f-minor",
		]);
		assert.ok(out.includes("=== project project-web ===\n" + serializeNote(readNote(dir, "project-web") as Note)));
		assert.ok(out.indexOf("=== finding f-blocker ===") < out.indexOf("=== log tail ==="));
		assert.ok(out.indexOf("=== log tail ===") < out.indexOf("=== index ==="));
		assert.ok(out.includes("=== log tail ===\nentry-1\nentry-2\n"));
		assert.ok(out.trimEnd().endsWith("- [[project-web]]"), "the index ends the text");
		assert.equal(out.includes("=== finding f-closed ==="), false, "a closed finding is absent");
		assert.equal(out.includes("=== finding f-other ==="), false, "another repo's finding is absent");
	});
});

test("bootText without a repo has no project and no finding item", () => {
	withVault((dir) => {
		put(dir, noteOf("project", "project-web", { repos: [REPO] }));
		putFinding(dir, "f-open", REPO, "t-1", "2026-01-01", "fp-open");
		const out = bootText(dir);
		assert.equal(out.includes("=== project "), false);
		assert.equal(out.includes("=== finding "), false);
		assert.ok(out.includes("=== index ==="));
	});
});

test("bootText keeps the last 20 lines of the log that are not empty", () => {
	withVault((dir) => {
		const lines = Array.from({ length: 25 }, (_, i) => `entry-${i + 1}`);
		fs.writeFileSync(path.join(dir, "log.md"), `${lines.join("\n\n")}\n\n`, "utf8");
		const out = bootText(dir);
		assert.ok(out.includes("=== log tail ===\nentry-6\n"));
		assert.equal(out.includes("entry-5\n"), false);
		assert.ok(out.includes("entry-25\n"));
	});
});

test("bootText truncates whole items with a tiny budget on a vault of 200 findings", () => {
	withVault((dir) => {
		fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# Vault\n", "utf8");
		fs.writeFileSync(path.join(dir, "log.md"), "", "utf8");
		const notes = new Map<string, Note>();
		for (let i = 0; i < 200; i++) {
			const basename = `f-${String(i).padStart(3, "0")}`;
			const note = findingNote(basename, { fingerprint: `fp-${i}`, trace: `t-${i}` });
			notes.set(basename, note);
			put(dir, note);
		}
		const budgetTokens = 300;
		const budgetChars = budgetTokens * 4;
		const claude = "# Vault\n";
		const out = bootText(dir, { repo: REPO, budgetTokens });
		const after = out.slice(claude.length);
		assert.ok(out.startsWith(claude));
		assert.ok(after.length <= budgetChars, `boot text is ${after.length} chars, budget ${budgetChars}`);
		const marker = /\n\[truncated: (\d+) items\]$/.exec(after);
		if (marker === null) throw new Error("the text does not end with the truncation line");
		const dropped = Number(marker[1]);
		assert.ok(dropped > 0 && dropped < 201, `dropped ${dropped} items`);

		const kept = after.slice(0, after.lastIndexOf("\n[truncated:"));
		const blocks = kept.split("\n=== ").slice(1);
		assert.equal(blocks.length, 201 - dropped, "every dropped item is gone and every kept item is whole");
		for (const block of blocks) {
			const newline = block.indexOf("\n");
			const header = /^finding (\S+) ===$/.exec(block.slice(0, newline));
			if (header === null) throw new Error(`unexpected header: ${block.slice(0, newline)}`);
			const basename = header[1];
			assert.equal(block.slice(newline + 1), serializeNote(notes.get(basename) as Note), `item ${basename} is cut`);
		}
	});
});

test("bootText charges the budget after CLAUDE.md, not against it", () => {
	withVault((dir) => {
		const claude = `${'y'.repeat(301)}\n`;
		fs.writeFileSync(path.join(dir, "CLAUDE.md"), claude, "utf8");
		putFinding(dir, "f-fits", REPO, "t-1", "2026-01-01", "fp-fits");
		const budgetChars = 400;
		const out = bootText(dir, { repo: REPO, budgetTokens: budgetChars / 4 });
		const after = out.slice(claude.length);
		assert.ok(out.startsWith(claude));
		assert.ok(after.length <= budgetChars, `the text after CLAUDE.md is ${after.length} chars`);
		assert.ok(out.includes("=== finding f-fits ==="), "the finding fits the budget");
		assert.equal(after.includes("[truncated:"), false);
	});
});

test("bootText keeps the truncation line even when not a single item fits", () => {
	withVault((dir) => {
		fs.writeFileSync(path.join(dir, "CLAUDE.md"), "", "utf8");
		putFinding(dir, "f-tiny", REPO, "t-1", "2026-01-01", "fp-tiny");
		const out = bootText(dir, { repo: REPO, budgetTokens: 0 });
		assert.match(out, /\n\[truncated: 2 items\]$/, "one finding and the index are both dropped");
		assert.equal(out.includes("=== finding f-tiny ==="), false);
	});
});

test("bootText puts a blank line between CLAUDE.md without a final newline and the first item", () => {
	withVault((dir) => {
		fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# Vault", "utf8");
		putFinding(dir, "f-gap", REPO, "t-1", "2026-01-01", "fp-gap");
		const out = bootText(dir, { repo: REPO });
		assert.ok(out.startsWith("# Vault\n\n=== finding f-gap ===\n"), out.slice(0, 60));
		assert.match(out, /Body of f-gap\.\n\n=== index ===/, "a blank line before each later item too");
	});
});

test("bootText with CLAUDE.md over the budget prints it and the over budget line only", () => {
	withVault((dir) => {
		const claude = `${"x".repeat(60)}\n`;
		fs.writeFileSync(path.join(dir, "CLAUDE.md"), claude, "utf8");
		const out = bootText(dir, { repo: REPO, budgetTokens: 2 });
		assert.equal(out, `${claude}\n[over budget: CLAUDE.md]\n`);
	});
});

test("bootText writes nothing", () => {
	withVault((dir) => {
		put(dir, findingNote("f-read"));
		const snapshot = (): string =>
			fs
				.readdirSync(dir)
				.sort()
				.map((name: string) => {
					const full = path.join(dir, name);
					if (fs.statSync(full).isDirectory()) {
						return `${name}/:${fs.readdirSync(full).sort().join(",")}`;
					}
					return `${name}:${fs.readFileSync(full, "utf8")}`;
				})
				.join("\n");
		const before = snapshot();
		bootText(dir, { repo: REPO });
		bootText(dir);
		assert.equal(snapshot(), before);
	});
});

// 6. findVault precedence.

const withHome = (fn: (home: string) => void): void => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-vault-home-"));
	try {
		fn(home);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
};

const writeConfig = (home: string, config: Record<string, unknown> | string): void => {
	const dir = path.join(home, ".config", "agent-vault");
	fs.mkdirSync(dir, { recursive: true });
	const text = typeof config === "string" ? config : JSON.stringify(config);
	fs.writeFileSync(path.join(dir, "config.json"), text, "utf8");
};

test("findVault: AGENT_VAULT wins over the config", () => {
	withHome((home) => {
		writeConfig(home, { path: "/vaults/config", remote: "git@github.com:acme/vault.git", host: "mac-1" });
		const env = { AGENT_VAULT: "/vaults/env" };
		assert.deepEqual(findVault(env, home), {
			path: "/vaults/env",
			host: "mac-1",
			remote: "git@github.com:acme/vault.git",
		});
		assert.deepEqual(findVault({}, home), {
			path: "/vaults/config",
			host: "mac-1",
			remote: "git@github.com:acme/vault.git",
		});
	});
});

test("findVault: the host falls back to slug(os.hostname()) and the remote is optional", () => {
	withHome((home) => {
		assert.deepEqual(findVault({ AGENT_VAULT: "/vaults/env" }, home), {
			path: "/vaults/env",
			host: slug(os.hostname()),
		});
		writeConfig(home, "not json");
		assert.equal(findVault({}, home), undefined);
		writeConfig(home, {});
		assert.equal(findVault({}, home), undefined);
	});
});

// 7. statsFor: counts, boot size and the repeat-finding rate.

test("statsFor counts notes, measures boot text and computes the repeat rate per repo", () => {
	withVault((dir) => {
		putFinding(dir, "a-1", REPO, "t-1", "2026-01-01", "fp-a1");
		putFinding(dir, "a-2", REPO, "t-1", "2026-01-01", "fp-a2");
		putFinding(dir, "a-7", REPO, "t-1", "2026-01-01", "fp-shared");
		putFinding(dir, "a-3", REPO, "t-2", "2026-01-02", "fp-a1");
		putFinding(dir, "a-4", REPO, "t-2", "2026-01-02", "fp-a3");
		putFinding(dir, "a-5", REPO, "t-3", "2026-01-03", "fp-a2");
		putFinding(dir, "a-6", REPO, "t-3", "2026-01-03", "fp-a4");
		putFinding(dir, "b-1", OTHER_REPO, "t-1", "2026-01-01", "fp-b1");
		putFinding(dir, "b-4", OTHER_REPO, "t-2", "2026-01-02", "fp-shared");
		putFinding(dir, "b-2", OTHER_REPO, "t-4", "2026-01-04", "fp-b1");
		putFinding(dir, "b-3", OTHER_REPO, "t-5", "2026-01-05", "fp-b2");
		put(dir, noteOf("plan", "p-1", { trace: "t-1", round: "1", repo: REPO, status: "done" }));

		const lastTwo = statsFor(dir, { repo: REPO, lastTraces: 2 });
		assert.equal(lastTwo.total, 4);
		assert.equal(lastTwo.repeats, 2);
		assert.equal(lastTwo.repeatRate, 0.5);

		const allA = statsFor(dir, { repo: REPO });
		assert.equal(allA.total, 7);
		assert.equal(allA.repeats, 2);

		const otherB = statsFor(dir, { repo: OTHER_REPO, lastTraces: 3 });
		assert.equal(otherB.total, 3);
		assert.equal(otherB.repeats, 1, "the same title in another repo is not a repeat here");
		assert.ok(Math.abs((otherB.repeatRate ?? 0) - 1 / 3) < 1e-9);

		assert.equal(allA.counts.finding, 11);
		assert.equal(allA.counts.plan, 1);
		assert.equal(allA.counts.run, 0);
		const boot = bootText(dir, { repo: REPO, budgetTokens: 1e9 });
		assert.equal(allA.bootTokens, Math.ceil(boot.length / 4));

		const none = statsFor(dir, { repo: "github.com/acme/none" });
		assert.equal(none.total, 0);
		assert.equal(none.repeatRate, null);
	});
});

// 8. The work sections of bootText and the work size of statsFor.

const putSpec = (dir: string, basename: string, props: Record<string, string | string[]> = {}): void => {
	const note = noteOf(
		"spec",
		basename,
		{ trace: basename, repo: REPO, status: "confirmed", file: `${basename}.md`, ...props },
		"Spec body.\n",
	);
	put(dir, note);
};

const putPlan = (dir: string, basename: string, props: Record<string, string | string[]>): void => {
	put(dir, noteOf("plan", basename, { repo: REPO, status: "draft", round: "1", ...props }, "Plan body.\n"));
};

const putIdea = (dir: string, basename: string, props: Record<string, string | string[]> = {}): void => {
	put(dir, noteOf("idea", basename, { status: "open", repo: REPO, ...props }, "Idea body.\n"));
};

const putRun = (
	dir: string,
	basename: string,
	updated: string,
	props: Record<string, string | string[]> = {},
): void => {
	put(
		dir,
		noteOf(
			"run",
			basename,
			{ trace: basename, repo: REPO, status: "done", gate: "pass", created: "2026-01-01", updated, ...props },
			"Run body.\n",
		),
	);
};

/** The content of one boot item, without its header line and the blank line after it. */
const sectionOf = (text: string, title: string): string | undefined => {
	const start = text.indexOf(`=== ${title} ===\n`);
	if (start < 0) return undefined;
	const rest = text.slice(start + title.length + 9);
	const next = rest.search(/\n=== /);
	return next < 0 ? rest : rest.slice(0, next);
};

/** A vault with specs, plans of two rounds, ideas and runs in two repos. */
const withWorkVault = (fn: (dir: string) => void): void => {
	withVault((dir) => {
		putSpec(dir, "a-spec", { trace: "t-1", host: "mac-mini" });
		putSpec(dir, "b-spec", { trace: "t-2", status: "draft" });
		putSpec(dir, "c-spec", { trace: "t-3", status: "done" });
		putSpec(dir, "d-spec", { trace: "t-4", repo: OTHER_REPO });
		putSpec(dir, "e-spec", { trace: "t-9", status: "draft" });
		putSpec(dir, "f-spec", { trace: "t-5" });
		putPlan(dir, "p-1-r1", { trace: "t-1", round: "1", status: "done" });
		putPlan(dir, "p-1-r2", { trace: "t-1", round: "2", status: "ready", audit: "pass", audit_round: "2" });
		putPlan(dir, "p-2-r1", { trace: "t-2", round: "1", status: "draft" });
		putPlan(dir, "p-2-r2", { trace: "t-2", round: "2", status: "draft", host: "laptop" });
		putPlan(dir, "q-2-r2", { trace: "t-2", round: "2", status: "done" });
		putPlan(dir, "p-3-r1", { trace: "t-3", round: "1", status: "done" });
		putPlan(dir, "p-5-r1", { trace: "t-5", round: "1", status: "failed", audit: "fail" });
		putIdea(dir, "idea-a-open");
		putIdea(dir, "idea-b-general", { repo: "-" });
		putIdea(dir, "idea-c-taken", { status: "taken" });
		putIdea(dir, "idea-d-other", { repo: OTHER_REPO });
		putRun(dir, "a-run", "2026-01-01");
		putRun(dir, "b-run", "2026-05-01", { gate: "fail" });
		putRun(dir, "c-run", "2026-03-01");
		putRun(dir, "d-run", "2026-04-01");
		putRun(dir, "e-run", "2026-03-01");
		putRun(dir, "z-run", "2026-09-01", { repo: OTHER_REPO });
		fn(dir);
	});
};

test("bootText: unfinished requests name the latest plan, its audit and the spec's host", () => {
	withWorkVault((dir) => {
		const out = bootText(dir, { repo: REPO, budgetTokens: 1e9 });
		assert.equal(
			sectionOf(out, "unfinished requests"),
			[
				"a-spec | plan p-1-r2 ready audit pass round 2 | host mac-mini",
				"b-spec | plan p-2-r2 draft | host -",
				"e-spec | no plan yet | host -",
				"f-spec | plan p-5-r1 failed audit fail | host -",
				"",
			].join("\n"),
		);
	});
});

test("bootText: open ideas are the basenames of the general and this repo's open ideas", () => {
	withWorkVault((dir) => {
		const out = bootText(dir, { repo: REPO, budgetTokens: 1e9 });
		assert.equal(sectionOf(out, "open ideas"), "idea-a-open\nidea-b-general\n");
	});
});

test("bootText: recent runs are the last 3 of this repo, newest first, with the gate and the date", () => {
	withWorkVault((dir) => {
		const out = bootText(dir, { repo: REPO, budgetTokens: 1e9 });
		assert.equal(sectionOf(out, "recent runs"), "b-run | fail | 2026-05-01\nd-run | pass | 2026-04-01\nc-run | pass | 2026-03-01\n");
	});
});

test("bootText leaves a done spec and another repo's spec out of the unfinished requests", () => {
	withWorkVault((dir) => {
		const out = bootText(dir, { repo: REPO, budgetTokens: 1e9 });
		const section = sectionOf(out, "unfinished requests") ?? "";
		assert.equal(section.includes("c-spec"), false);
		assert.equal(section.includes("d-spec"), false);
	});
});

test("bootText puts the work sections between the findings and the log tail", () => {
	withWorkVault((dir) => {
		putFinding(dir, "f-order", REPO, "t-1", "2026-01-01", "fp-order");
		fs.writeFileSync(path.join(dir, "log.md"), "entry-1\n", "utf8");
		const out = bootText(dir, { repo: REPO });
		const headers = [
			"=== finding f-order ===",
			"=== unfinished requests ===",
			"=== open ideas ===",
			"=== recent runs ===",
			"=== log tail ===",
			"=== index ===",
		];
		const positions = headers.map((header) => out.indexOf(header));
		assert.ok(positions.every((position) => position >= 0), JSON.stringify(positions));
		for (let i = 1; i < positions.length; i++) assert.ok((positions[i] ?? -1) > (positions[i - 1] ?? -1), JSON.stringify(positions));
	});
});

test("bootText omits a work section that has no entries", () => {
	withVault((dir) => {
		const out = bootText(dir, { repo: REPO });
		assert.equal(out.includes("=== unfinished requests ==="), false);
		assert.equal(out.includes("=== open ideas ==="), false);
		assert.equal(out.includes("=== recent runs ==="), false);
	});
});

test("bootText without a repo shows only the general open ideas", () => {
	withWorkVault((dir) => {
		const out = bootText(dir, { budgetTokens: 1e9 });
		assert.equal(out.includes("=== unfinished requests ==="), false);
		assert.equal(out.includes("=== recent runs ==="), false);
		assert.equal(sectionOf(out, "open ideas"), "idea-b-general\n");
	});
});

test("a small budget drops the work sections from the end, before the log tail and the index", () => {
	withWorkVault((dir) => {
		fs.writeFileSync(path.join(dir, "log.md"), "entry-1\n", "utf8");
		const full = bootText(dir, { repo: REPO, budgetTokens: 1e9 });
		const specBlock = full.slice(full.indexOf("\n=== unfinished requests ==="), full.indexOf("\n=== open ideas ==="));
		assert.ok(specBlock.length > 0, "the unfinished requests item is in the full text");
		const budgetChars = specBlock.length + "\n[truncated: 4 items]".length;
		const out = bootText(dir, { repo: REPO, budgetTokens: Math.ceil(budgetChars / 4) });
		assert.ok(out.includes("=== unfinished requests ==="), out);
		assert.equal(out.includes("=== open ideas ==="), false);
		assert.equal(out.includes("=== recent runs ==="), false);
		assert.equal(out.includes("=== log tail ==="), false);
		assert.match(out, /\n\[truncated: 4 items\]$/);
	});
});

test("buildIndex lists the spec and idea notes under Specs and Ideas", () => {
	withWorkVault((dir) => {
		const index = buildIndex(dir);
		assert.match(index, /## Specs\n(- \[\[[a-z0-9-]+\]\]\n)*?- \[\[a-spec\]\]/);
		assert.match(index, /## Ideas\n- \[\[idea-a-open\]\]\n- \[\[idea-b-general\]\]\n- \[\[idea-c-taken\]\]\n- \[\[idea-d-other\]\]\n/);
	});
});

test("statsFor counts the new note types and measures work/ without the .gitkeep files", () => {
	withWorkVault((dir) => {
		fs.mkdirSync(path.join(dir, "work", "t-1", "probes"), { recursive: true });
		fs.writeFileSync(path.join(dir, "work", ".gitkeep"), "", "utf8");
		fs.writeFileSync(path.join(dir, "work", "t-1", ".gitkeep"), "", "utf8");
		fs.writeFileSync(path.join(dir, "work", "t-1", "a.txt"), "12345", "utf8");
		fs.writeFileSync(path.join(dir, "work", "t-1", "probes", "b.txt"), "1234567890", "utf8");
		const stats = statsFor(dir, { repo: REPO });
		assert.equal(stats.counts.spec, 6);
		assert.equal(stats.counts.idea, 4);
		assert.equal(stats.workFiles, 2);
		assert.equal(stats.workBytes, 15);
	});
});

test("statsFor reports 0 work files and 0 bytes when work/ is missing", () => {
	withVault((dir) => {
		const stats = statsFor(dir, { repo: REPO });
		assert.equal(stats.workFiles, 0);
		assert.equal(stats.workBytes, 0);
	});
});
