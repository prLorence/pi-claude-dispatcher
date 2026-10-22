/**
 * `vault.mjs restore --root <repo root>`: rebuild the working specs and draft
 * plans of a `full` repo from the vault, then list its open ideas and recent runs.
 *
 * Plain Node, no dependencies. The caller builds the context and emits the event
 * this module returns. Every write lands under <root>/.plans, never overwrites and
 * never leaves a plan without the .draft suffix.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;
const SPEC_STATUSES = ["draft", "confirmed"];
const PLAN_STATUSES = ["draft", "ready"];

let tempCounter = 0;

function isDirectory(dir) {
	try {
		return fs.statSync(dir).isDirectory();
	} catch {
		return false;
	}
}

/** A plain file name: the schema's rule, checked again before any path is built. */
function acceptableName(name) {
	return FILE_NAME_RE.test(name) && !name.includes("..") && name === path.basename(name);
}

/** The `file` property, or undefined when the note has none. A non-string fails the name check. */
function fileNameOf(note) {
	const value = note.props.file;
	if (value === undefined) return undefined;
	return typeof value === "string" ? value : "";
}

function propOf(note, key) {
	const value = note.props[key];
	return typeof value === "string" ? value : "-";
}

function compareText(a, b) {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

function compareBasenames(a, b) {
	return compareText(a.basename, b.basename);
}

/** Ends with exactly one newline. */
function oneNewline(text) {
	return `${text.replace(/\n+$/, "")}\n`;
}

function statusIn(note, allowed) {
	return typeof note.props.status === "string" && allowed.includes(note.props.status);
}

/**
 * A temp file in the same folder, then a rename. Returns "exists" instead of
 * writing when the target is already there, so a restore never overwrites.
 */
function writeNew(file, text) {
	if (fs.existsSync(file)) return "exists";
	const dir = path.dirname(file);
	fs.mkdirSync(dir, { recursive: true });
	tempCounter += 1;
	const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${tempCounter}.tmp`);
	try {
		fs.writeFileSync(temp, text, "utf8");
		fs.renameSync(temp, file);
		return "written";
	} catch (error) {
		fs.rmSync(temp, { force: true });
		throw error;
	}
}

function skip(c, rel, reason, counts) {
	c.out(`skipped ${rel}: ${reason}`);
	counts.skipped += 1;
}

/** Writes one restored file, or prints why not. False means an I/O failure. */
function emitWrite(c, target, rel, text, counts) {
	let result;
	try {
		result = writeNew(target, text);
	} catch {
		c.err(`restore: cannot write ${rel}`);
		return false;
	}
	if (result === "exists") {
		skip(c, rel, "exists", counts);
		return true;
	}
	c.out(`restored ${rel}`);
	counts.restored += 1;
	return true;
}

/** The plan text with the first frontmatter block's status line set to draft. */
function withDraftStatus(body) {
	const lines = body.split("\n");
	if (lines[0] !== "---") return { reason: "no front matter" };
	let close = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i] === "---") {
			close = i;
			break;
		}
	}
	if (close === -1) return { reason: "no front matter" };
	for (let i = 1; i < close; i++) {
		if (lines[i].startsWith("status:")) {
			lines[i] = "status: draft";
			return { text: lines.join("\n") };
		}
	}
	return { reason: "no status line" };
}

/** Every place a plan of that file name may already live under .plans. */
function planExists(root, file) {
	const plans = path.join(root, ".plans");
	const id = file.replace(/\.md$/, "");
	const candidates = [
		path.join(plans, "inbox", file),
		path.join(plans, "inbox", `${file}.draft`),
		path.join(plans, "running", file),
		path.join(plans, "failed", file),
		path.join(plans, "done", id, "plan.md"),
	];
	return candidates.some((candidate) => fs.existsSync(candidate));
}

function restoreSpecs(c, notes, repo, counts) {
	const specs = notes
		.filter((note) => note.type === "spec" && note.props.repo === repo && statusIn(note, SPEC_STATUSES))
		.sort(compareBasenames);
	for (const note of specs) {
		const file = fileNameOf(note);
		if (file === undefined) continue;
		const rel = `.plans/specs/${file}`;
		if (!acceptableName(file)) {
			skip(c, rel, "bad file name", counts);
			continue;
		}
		const target = path.join(c.root, ".plans", "specs", file);
		if (!emitWrite(c, target, rel, oneNewline(note.body), counts)) return false;
	}
	return true;
}

function restorePlans(c, notes, repo, counts) {
	const plans = notes
		.filter((note) => note.type === "plan" && note.props.repo === repo && statusIn(note, PLAN_STATUSES))
		.sort(compareBasenames);
	for (const note of plans) {
		const file = fileNameOf(note);
		if (file === undefined) continue;
		const rel = `.plans/inbox/${file}.draft`;
		if (!acceptableName(file)) {
			skip(c, rel, "bad file name", counts);
			continue;
		}
		if (planExists(c.root, file)) {
			skip(c, rel, "exists", counts);
			continue;
		}
		const drafted = withDraftStatus(note.body);
		if (drafted.reason !== undefined) {
			skip(c, rel, drafted.reason, counts);
			continue;
		}
		const target = path.join(c.root, ".plans", "inbox", `${file}.draft`);
		if (!emitWrite(c, target, rel, oneNewline(drafted.text), counts)) return false;
	}
	return true;
}

function printIdeas(c, notes, repo) {
	const ideas = notes
		.filter(
			(note) =>
				note.type === "idea" &&
				note.props.status === "open" &&
				(note.props.repo === "-" || note.props.repo === repo),
		)
		.sort(compareBasenames);
	for (const idea of ideas) c.out(`idea ${idea.basename}`);
}

function printRuns(c, notes, repo) {
	const runs = notes
		.filter((note) => note.type === "run" && note.props.repo === repo)
		.sort((a, b) => compareText(propOf(b, "updated"), propOf(a, "updated")) || compareBasenames(a, b))
		.slice(0, 3);
	for (const note of runs) c.out(`run ${note.basename} | ${propOf(note, "gate")} | ${propOf(note, "updated")}`);
}

/**
 * c = { vault, root, modules, out, err, inside }
 * Returns { code, event }.
 */
export function restore(c) {
	const repos = c.modules.notes.readRepos(c.vault);
	const repo = c.modules.url.repoSlugFromCwd(c.root, repos.aliases);
	const mode = c.modules.privacy.modeFor(repos, repo);
	if (mode !== "full") return { code: 0 };

	const plansDir = path.join(c.root, ".plans");
	if (!isDirectory(plansDir)) {
		c.err("restore: .plans does not exist");
		return { code: 1 };
	}

	const notes = c.modules.notes.listNotes(c.vault);
	const counts = { restored: 0, skipped: 0 };
	if (!restoreSpecs(c, notes, repo, counts)) return { code: 1 };
	if (!restorePlans(c, notes, repo, counts)) return { code: 1 };
	printIdeas(c, notes, repo);
	printRuns(c, notes, repo);
	return { code: 0, event: { kind: "vault.restore", data: counts } };
}
