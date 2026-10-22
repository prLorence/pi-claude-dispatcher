/**
 * The work folder commands of the agent vault (R5 to R8 of the work spec):
 * `work add` copies the record of a finished request into `work/<trace>/`,
 * `work pending` lists the finished requests the vault is missing or holds an
 * older copy of.
 *
 * The CLI builds the context `c` and emits the event this module returns, so
 * the logic here only decides. It is plain ESM with Node built-ins, loaded
 * lazily by vault.mjs, and reaches the storage rules through `c.modules`.
 *
 * Every message here names a path relative to the repo root, never an absolute
 * one, and never the slug of a repo the vault does not allow.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const TRACE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PLAN_END = "plan.end";
const PROBE_PREFIXES = ["probe-", "ref-", "make-ref-"];
const PROBES_HASH = "probes.sha256";
const SKIPPED_NAMES = new Set(["plan.md"]);
const SKIPPED_SUFFIX = ".prompt.md";
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });

let tempCounter = 0;

function readBytes(file) {
	try {
		return fs.readFileSync(file);
	} catch {
		return undefined;
	}
}

function parseJson(text) {
	try {
		const value = JSON.parse(text);
		return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function errorText(error) {
	return String(error?.message ?? error);
}

/** The lines of a JSONL file as byte slices, without the line endings. */
function traceLines(bytes) {
	const lines = [];
	let start = 0;
	for (let i = 0; i < bytes.length; i++) {
		if (bytes[i] !== 0x0a) continue;
		lines.push(bytes.subarray(start, i));
		start = i + 1;
	}
	if (start < bytes.length) lines.push(bytes.subarray(start));
	return lines;
}

function eventsOf(bytes) {
	const events = [];
	for (const line of traceLines(bytes)) {
		const event = parseJson(line.toString("utf8"));
		if (event !== undefined) events.push(event);
	}
	return events;
}

/**
 * The local trace without the lines whose actor is `vault`: `work add` appends
 * its own `vault.work` event to the local trace afterwards, so a copy that kept
 * those lines would never equal the local file. The other lines stay byte for
 * byte and each one ends with a single newline.
 */
function filteredTrace(bytes) {
	const kept = [];
	for (const line of traceLines(bytes)) {
		const event = parseJson(line.toString("utf8"));
		if (event !== undefined && event.actor === "vault") continue;
		kept.push(line);
	}
	const parts = [];
	for (const line of kept) parts.push(line, Buffer.from("\n"));
	return Buffer.concat(parts);
}

function isFinished(bytes) {
	return eventsOf(bytes).some((event) => event.kind === PLAN_END);
}

/** The distinct non-empty plan ids of a trace, sorted by name. */
function planIdsOf(bytes) {
	const ids = new Set();
	for (const event of eventsOf(bytes)) {
		if (typeof event.plan === "string" && event.plan !== "") ids.add(event.plan);
	}
	return [...ids].sort();
}

/** The text of a UTF-8 file, or undefined when the bytes are not UTF-8 text. */
function decodeText(bytes) {
	try {
		const text = TEXT_DECODER.decode(bytes);
		return text.includes("\0") ? undefined : text;
	} catch {
		return undefined;
	}
}

function compareNames(a, b) {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

function regularFileNames(dir) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter((entry) => entry.isFile())
		.map((entry) => entry.name)
		.sort(compareNames);
}

function subdirectoryNames(dir, prefix) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
		.map((entry) => entry.name)
		.sort(compareNames);
}

/** Every regular file below a folder, as slash-separated paths relative to it. */
function walkFiles(dir, relative = "") {
	const found = [];
	let entries;
	try {
		entries = fs.readdirSync(relative === "" ? dir : path.join(dir, relative), { withFileTypes: true });
	} catch {
		return found;
	}
	for (const entry of entries.sort((a, b) => compareNames(a.name, b.name))) {
		const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
		if (entry.isDirectory()) found.push(...walkFiles(dir, child));
		else if (entry.isFile()) found.push(child);
	}
	return found;
}

function writeAtomic(file, bytes) {
	const dir = path.dirname(file);
	fs.mkdirSync(dir, { recursive: true });
	tempCounter += 1;
	const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${tempCounter}.tmp`);
	try {
		fs.writeFileSync(temp, bytes);
		fs.renameSync(temp, file);
	} catch (error) {
		fs.rmSync(temp, { force: true });
		throw error;
	}
}

/** The plan folder of an id: done/ first, failed/ only when there is no done/ folder. */
function planFolder(root, id) {
	const done = path.join(root, ".plans", "done", id);
	if (fs.existsSync(done)) return { folder: done, label: `.plans/done/${id}` };
	const failed = path.join(root, ".plans", "failed", id);
	if (fs.existsSync(failed)) return { folder: failed, label: `.plans/failed/${id}` };
	return undefined;
}

/** The result files of every plan of the trace, without `plan.md` and prompts. */
function planSources(root, ids) {
	const entries = [];
	const bad = [];
	for (const id of ids) {
		if (!TRACE_ID_RE.test(id)) {
			bad.push(id);
			continue;
		}
		const found = planFolder(root, id);
		if (found === undefined) continue;
		for (const name of regularFileNames(found.folder)) {
			if (SKIPPED_NAMES.has(name) || name.endsWith(SKIPPED_SUFFIX)) continue;
			entries.push({
				dest: `${id}/${name}`,
				file: path.join(found.folder, name),
				label: `${found.label}/${name}`,
			});
		}
	}
	return { entries, bad };
}

/** The probe files of a request: the top-level names and every folder named ref-*. */
function probeSources(root) {
	const tools = path.join(root, ".plans", "tools");
	const entries = [];
	for (const name of regularFileNames(tools)) {
		if (!PROBE_PREFIXES.some((prefix) => name.startsWith(prefix)) && name !== PROBES_HASH) continue;
		entries.push({ dest: `probes/${name}`, file: path.join(tools, name), label: `.plans/tools/${name}` });
	}
	for (const name of subdirectoryNames(tools, "ref-")) {
		for (const relative of walkFiles(path.join(tools, name))) {
			entries.push({
				dest: `probes/${name}/${relative}`,
				file: path.join(tools, name, ...relative.split("/")),
				label: `.plans/tools/${name}/${relative}`,
			});
		}
	}
	return entries;
}

/**
 * The `unmirrored` property of every run note of the trace: the sorted relative
 * paths while something is unmirrored, dropped again once nothing is. A note
 * whose properties would not change is not written.
 */
function updateRunNotes(c, traceId, labels) {
	const value = labels.length === 0 ? undefined : labels.join(", ");
	let notes;
	try {
		notes = c.modules.notes.listNotes(c.vault);
	} catch (error) {
		c.err(`work add: could not read the notes (${errorText(error)})`);
		return;
	}
	for (const note of notes) {
		if (note.type !== "run" || note.props.trace !== traceId) continue;
		const current = note.props.unmirrored;
		if (value === undefined && current === undefined) continue;
		if (typeof current === "string" && current === value) continue;
		const props = { ...note.props };
		if (value === undefined) delete props.unmirrored;
		else props.unmirrored = value;
		c.modules.notes.writeNote(c.vault, { ...note, props });
	}
}

/**
 * `vault work add --trace <T> [--probes]`: copy the record of a finished
 * request into `work/<T>/` for a `full` repo, skipping anything that is not
 * UTF-8 text or names a secret or a repo the vault does not allow.
 */
export function workAdd(c, { trace, probes } = {}) {
	const traceId = typeof trace === "string" ? trace : "";
	if (!TRACE_ID_RE.test(traceId)) {
		c.err(`work add: bad trace id: ${traceId}`);
		return { code: 2 };
	}

	const repos = c.modules.notes.readRepos(c.vault);
	const slug = c.modules.url.repoSlugFromCwd(c.root, repos.aliases);
	const mode = c.modules.privacy.modeFor(repos, slug);
	if (mode === "none") {
		c.err("work add: this repo is not allowed in the vault");
		return { code: 3 };
	}
	if (mode === "meta") {
		c.out("work add: a meta repo copies no work files");
		return { code: 0 };
	}

	const traceFile = path.join(c.root, ".plans", "traces", `${traceId}.jsonl`);
	const localBytes = readBytes(traceFile);
	if (localBytes === undefined || !isFinished(localBytes)) {
		c.err("work add: request not finished");
		return { code: 1 };
	}

	const entries = [
		{ dest: "trace.jsonl", bytes: filteredTrace(localBytes), label: `.plans/traces/${traceId}.jsonl` },
	];
	const reportFile = path.join(c.root, ".plans", "traces", `${traceId}.md`);
	if (fs.existsSync(reportFile)) {
		entries.push({ dest: "trace.md", file: reportFile, label: `.plans/traces/${traceId}.md` });
	}
	const plans = planSources(c.root, planIdsOf(localBytes));
	entries.push(...plans.entries);
	if (probes === true) entries.push(...probeSources(c.root));

	const unmirrored = plans.bad.map((id) => ({ label: id, reason: "bad plan id" }));
	const workDir = path.join(c.vault, "work", traceId);
	let copied = 0;
	let unchanged = 0;

	for (const entry of entries) {
		const bytes = entry.bytes ?? readBytes(entry.file);
		const text = bytes === undefined ? undefined : decodeText(bytes);
		if (bytes === undefined || text === undefined) {
			unmirrored.push({ label: entry.label, reason: "not UTF-8 text" });
			continue;
		}
		const secrets = c.modules.git.scanSecrets(text);
		if (secrets.length > 0) {
			unmirrored.push({ label: entry.label, reason: `secret pattern: ${secrets.join(",")}` });
			continue;
		}
		if (c.modules.privacy.leaksNoneRepo(repos, text).length > 0) {
			unmirrored.push({ label: entry.label, reason: "names a repo that is not allowed" });
			continue;
		}
		const target = path.join(workDir, ...entry.dest.split("/"));
		if (!c.inside(target)) {
			unmirrored.push({ label: entry.label, reason: "outside the vault" });
			continue;
		}
		const existing = readBytes(target);
		if (existing !== undefined && existing.equals(bytes)) {
			unchanged += 1;
			continue;
		}
		writeAtomic(target, bytes);
		copied += 1;
	}

	unmirrored.sort((a, b) => compareNames(a.label, b.label));
	for (const item of unmirrored) c.err(`unmirrored ${item.label}: ${item.reason}`);
	const count = unmirrored.length;
	c.out(`work add: ${copied} copied, ${unchanged} unchanged, ${count} unmirrored`);

	updateRunNotes(
		c,
		traceId,
		unmirrored.map((item) => item.label),
	);

	return {
		code: count > 0 ? 6 : 0,
		event: { kind: "vault.work", data: { op: "add", trace: traceId, files: copied, unmirrored: count } },
	};
}

/**
 * `vault work pending`: one `pending <trace>` line per finished request whose
 * `work/<trace>/trace.jsonl` is missing from the vault or differs from the
 * local file, compared after dropping the local lines whose actor is `vault`.
 * It writes nothing and only a `full` repo prints anything.
 */
export function workPending(c) {
	const repos = c.modules.notes.readRepos(c.vault);
	const slug = c.modules.url.repoSlugFromCwd(c.root, repos.aliases);
	if (c.modules.privacy.modeFor(repos, slug) !== "full") return { code: 0 };

	const dir = path.join(c.root, ".plans", "traces");
	let names;
	try {
		names = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return { code: 0 };
	}
	const traces = names
		.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
		.map((entry) => entry.name)
		.sort(compareNames);

	for (const name of traces) {
		const local = readBytes(path.join(dir, name));
		if (local === undefined || !isFinished(local)) continue;
		const trace = name.slice(0, -".jsonl".length);
		const stored = readBytes(path.join(c.vault, "work", trace, "trace.jsonl"));
		if (stored === undefined || !stored.equals(filteredTrace(local))) c.out(`pending ${trace}`);
	}
	return { code: 0 };
}
