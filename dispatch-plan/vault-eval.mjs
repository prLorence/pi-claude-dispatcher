/**
 * The golden-set commands of the agent vault (R12 of the forget/search spec):
 * `eval add` appends one `{query, expect}` entry to `eval/golden.json` and
 * `eval list` prints the entries with the mark for an expected note that no
 * longer exists.
 *
 * The CLI builds the context `c` and emits the event this module returns, so
 * the logic here only decides. It is plain ESM with Node built-ins, loaded
 * lazily by vault.mjs, and reaches the note rules through `c.modules`.
 *
 * A refusal writes nothing, and the file is always replaced whole through a
 * temp file in `eval/` and a rename, so a reader never sees a half-written set.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const EVAL_DIR = "eval";
const EVAL_FILE = "golden.json";
const LINE_BREAK_RE = /[\r\n]/;
// Mirrors BASENAME_RE in pi-plan-dispatch/vault/schema.ts, so an expected name
// stays a note basename and can never walk out of the vault with `/`, `\` or `..`.
const EXPECT_BASENAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

let tempCounter = 0;

function errorText(error) {
	return String(error?.message ?? error);
}

function evalPath(c) {
	return path.join(c.vault, EVAL_DIR, EVAL_FILE);
}

function isEntry(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	return typeof value.query === "string" && value.query !== "" && typeof value.expect === "string" && value.expect !== "";
}

/** The entries of the golden set, or the message that says why they cannot be read. */
function readEntries(c) {
	const file = evalPath(c);
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (error) {
		if (error?.code === "ENOENT") return { entries: [] };
		return { error: `eval/golden.json cannot be read: ${errorText(error)}` };
	}
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { error: "eval/golden.json is not valid JSON" };
	}
	if (!Array.isArray(parsed) || !parsed.every(isEntry)) {
		return { error: "eval/golden.json must be a JSON array of {query, expect} strings" };
	}
	return { entries: parsed };
}

/** Replace the file whole: a dot temp file in `eval/`, then a rename. */
function writeEntries(c, entries) {
	const dir = path.join(c.vault, EVAL_DIR);
	const target = path.join(dir, EVAL_FILE);
	fs.mkdirSync(dir, { recursive: true });
	const temp = path.join(dir, `.${EVAL_FILE}.tmp-${process.pid}-${Date.now()}-${tempCounter++}`);
	try {
		fs.writeFileSync(temp, `${JSON.stringify(entries, null, 2)}\n`);
		fs.renameSync(temp, target);
	} finally {
		fs.rmSync(temp, { force: true });
	}
	return target;
}

/** Refuse a bad query or a bad entry without touching the file. */
function refusal(c, message) {
	c.err(message);
	return { code: 2 };
}

/**
 * Append one `{query, expect}` entry. The query is trimmed and must be one
 * non-empty line, the expected note must exist, the pair must be new, and the
 * query must not name a repo the vault does not allow.
 */
export function evalAdd(c, { query, expect }) {
	const raw = typeof query === "string" ? query : "";
	const trimmed = raw.trim();
	const basename = typeof expect === "string" ? expect : "";
	if (trimmed === "") return refusal(c, "eval add needs a non-empty --query");
	if (LINE_BREAK_RE.test(raw)) return refusal(c, "eval add --query must be a single line");
	if (basename === "") return refusal(c, "eval add needs --expect");
	if (!EXPECT_BASENAME_RE.test(basename)) {
		return refusal(c, `eval add --expect must match ^[a-z0-9]+(-[a-z0-9]+)*$: ${basename}`);
	}
	if (c.modules.notes.readNote(c.vault, basename) === undefined) {
		return refusal(c, `no note named ${basename}`);
	}
	const repos = c.modules.notes.readRepos(c.vault);
	for (const needle of c.modules.privacy.leaksNoneRepo(repos, trimmed)) {
		return refusal(c, `the query names a repo that is not allowed: ${needle}`);
	}

	const read = readEntries(c);
	if (read.error !== undefined) {
		c.err(read.error);
		return { code: 1 };
	}
	if (read.entries.some((entry) => entry.query === trimmed && entry.expect === basename)) {
		return refusal(c, `eval/golden.json already has that query and expect: ${basename}`);
	}

	const target = writeEntries(c, [...read.entries, { query: trimmed, expect: basename }]);
	c.out(target);
	return { code: 0, event: { kind: "vault.write", data: { type: "eval", op: "add" } } };
}

/** Print each entry with its 1-based position, marking a missing expected note. */
export function evalList(c) {
	const read = readEntries(c);
	if (read.error !== undefined) {
		c.err(read.error);
		return { code: 1 };
	}
	if (read.entries.length === 0) {
		c.out("no entries");
		return { code: 0 };
	}
	read.entries.forEach((entry, index) => {
		const missing = c.modules.notes.readNote(c.vault, entry.expect) === undefined ? " (missing)" : "";
		c.out(`${index + 1} | ${entry.expect} | ${entry.query}${missing}`);
	});
	return { code: 0 };
}
