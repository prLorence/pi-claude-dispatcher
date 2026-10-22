/**
 * Note files and the vault index: discovery, read and write, the log, the
 * generated index, the boot text and the stats.
 *
 * This is the only module that touches a vault on disk. It computes and writes;
 * validation, the allowlist, realpath containment and the schema-version
 * refusals belong to the CLI built on top of it.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Note, NoteType } from "./schema.ts";
import { NOTE_TYPES, TYPE_FOLDER, parseNote, serializeNote, slug } from "./schema.ts";
import type { Repos } from "./privacy.ts";
import { parseRepos } from "./privacy.ts";

const DEFAULT_BOOT_BUDGET_TOKENS = 4000;
const CHARS_PER_TOKEN = 4;
const LOG_TAIL_LINES = 20;
const NEWEST_SEVERITY: Record<string, number> = {
	blocker: 0,
	error: 0,
	major: 1,
	warn: 1,
	minor: 2,
	info: 2,
};

export interface VaultInfo {
	path: string;
	host: string;
	remote?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readText(file: string): string | undefined {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}

function readDirNames(dir: string): string[] {
	try {
		return fs.readdirSync(dir);
	} catch {
		return [];
	}
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function vaultInfo(vault: string, host: string, remote: string | undefined): VaultInfo {
	return remote === undefined ? { path: vault, host } : { path: vault, host, remote };
}

function readConfig(home: string): Record<string, unknown> {
	const text = readText(path.join(home, ".config", "agent-vault", "config.json"));
	if (text === undefined) return {};
	try {
		const parsed: unknown = JSON.parse(text);
		return isObject(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

export function findVault(env: NodeJS.ProcessEnv, home: string): VaultInfo | undefined {
	const config = readConfig(home);
	const host = nonEmptyString(config.host) ?? slug(os.hostname());
	const remote = nonEmptyString(config.remote);
	const fromEnv = nonEmptyString(env.AGENT_VAULT);
	if (fromEnv !== undefined) return vaultInfo(fromEnv, host, remote);
	const fromConfig = nonEmptyString(config.path);
	if (fromConfig === undefined) return undefined;
	return vaultInfo(fromConfig, host, remote);
}

export function readRepos(vault: string): Repos {
	return parseRepos(readText(path.join(vault, "repos.json")));
}

export function notePath(vault: string, type: NoteType, basename: string): string {
	return path.join(vault, TYPE_FOLDER[type], `${basename}.md`);
}

function findNoteFile(vault: string, basename: string): { type: NoteType; file: string } | undefined {
	for (const type of NOTE_TYPES) {
		const file = notePath(vault, type, basename);
		if (fs.existsSync(file)) return { type, file };
	}
	return undefined;
}

export function readNote(vault: string, basename: string): Note | undefined {
	const found = findNoteFile(vault, basename);
	if (found === undefined) return undefined;
	return parseNote(basename, fs.readFileSync(found.file, "utf8"));
}

export function listNotes(vault: string): Note[] {
	const notes: Note[] = [];
	for (const type of NOTE_TYPES) {
		const dir = path.join(vault, TYPE_FOLDER[type]);
		for (const name of readDirNames(dir)) {
			if (name.startsWith(".") || !name.endsWith(".md")) continue;
			const basename = name.slice(0, -".md".length);
			notes.push(parseNote(basename, fs.readFileSync(path.join(dir, name), "utf8")));
		}
	}
	return notes.sort(compareBasename);
}

export function removeNote(vault: string, basename: string): boolean {
	const found = findNoteFile(vault, basename);
	if (found === undefined) return false;
	try {
		fs.unlinkSync(found.file);
		return true;
	} catch {
		return false;
	}
}

let tempCounter = 0;

/** A temp file in the same folder, whose name starts with a dot, then a rename. */
function writeAtomic(file: string, text: string): void {
	const dir = path.dirname(file);
	fs.mkdirSync(dir, { recursive: true });
	tempCounter += 1;
	const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${tempCounter}.tmp`);
	try {
		fs.writeFileSync(temp, text, "utf8");
		fs.renameSync(temp, file);
	} catch (error) {
		fs.rmSync(temp, { force: true });
		throw error;
	}
}

function todayString(): string {
	const now = new Date();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	return `${now.getFullYear()}-${month}-${day}`;
}

function setOrDrop(props: Record<string, string | string[]>, key: string, value: string | string[] | undefined): void {
	if (typeof value === "string") {
		props[key] = value;
	} else {
		delete props[key];
	}
}

export function writeNote(vault: string, note: Note, opts: { today?: string } = {}): { path: string; changed: boolean } {
	const today = opts.today ?? todayString();
	const target = notePath(vault, note.type, note.basename);
	const existing = findNoteFile(vault, note.basename);
	if (existing !== undefined && existing.type !== note.type) {
		throw new Error(`basename ${note.basename} is already used by a ${existing.type} note`);
	}

	const props: Record<string, string | string[]> = { ...note.props };
	if (existing === undefined) {
		if (typeof props.created !== "string") props.created = today;
		props.updated = today;
		writeAtomic(target, serializeNote({ ...note, props }));
		return { path: target, changed: true };
	}

	const stored = parseNote(note.basename, fs.readFileSync(existing.file, "utf8"));
	setOrDrop(props, "created", stored.props.created);
	setOrDrop(props, "updated", stored.props.updated);
	if (serializeNote({ ...note, props }) === serializeNote(stored)) {
		return { path: existing.file, changed: false };
	}
	props.updated = today;
	setOrDrop(props, "created", stored.props.created);
	writeAtomic(existing.file, serializeNote({ ...note, props }));
	return { path: existing.file, changed: true };
}

export function appendLog(
	vault: string,
	e: { ts: string; host: string; repo: string; trace: string; text: string },
): void {
	const text = e.text.replace(/\r\n|\r|\n/g, " ");
	fs.appendFileSync(path.join(vault, "log.md"), `- ${e.ts} [${e.host}] ${e.repo} ${e.trace} ${text}\n`, "utf8");
}

function compareBasename(a: Note, b: Note): number {
	return compareStrings(a.basename, b.basename);
}

function compareStrings(a: string, b: string): number {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

function sectionTitle(type: NoteType): string {
	const folder = TYPE_FOLDER[type];
	return `${folder.charAt(0).toUpperCase()}${folder.slice(1)}`;
}

function indexText(notes: Note[]): string {
	const lines = ["# Index"];
	for (const type of NOTE_TYPES) {
		const sectionNotes = notes.filter((note) => note.type === type);
		if (sectionNotes.length === 0) continue;
		lines.push(`## ${sectionTitle(type)}`, ...sectionNotes.map((note) => `- [[${note.basename}]]`), "");
	}
	return `${lines.join("\n")}\n`;
}

export function buildIndex(vault: string): string {
	return indexText(listNotes(vault));
}

export function writeIndex(vault: string): void {
	writeAtomic(path.join(vault, "index.md"), buildIndex(vault));
}

function reposOf(note: Note): string[] {
	const value = note.props.repos;
	if (Array.isArray(value)) return value;
	return typeof value === "string" ? [value] : [];
}

function createdOf(note: Note): string {
	const value = note.props.created;
	return typeof value === "string" ? value : "";
}

function severityRank(note: Note): number {
	const value = note.props.severity;
	return typeof value === "string" ? (NEWEST_SEVERITY[value] ?? 3) : 3;
}

function compareFindings(a: Note, b: Note): number {
	const bySeverity = severityRank(a) - severityRank(b);
	if (bySeverity !== 0) return bySeverity;
	const createdA = createdOf(a);
	const createdB = createdOf(b);
	if (createdA !== createdB) return createdA < createdB ? 1 : -1;
	return compareBasename(a, b);
}

interface BootItem {
	header: string;
	content: string;
}

function projectFor(notes: Note[], repo: string | undefined): Note | undefined {
	if (repo === undefined) return undefined;
	return notes.find((note) => note.type === "project" && reposOf(note).includes(repo));
}

function propOf(note: Note, key: string): string | undefined {
	const value = note.props[key];
	return typeof value === "string" ? value : undefined;
}

function latestPlan(notes: Note[], trace: string | undefined): Note | undefined {
	if (trace === undefined) return undefined;
	let best: Note | undefined;
	for (const note of notes) {
		if (note.type !== "plan" || propOf(note, "trace") !== trace) continue;
		if (best === undefined) {
			best = note;
			continue;
		}
		const byRound = Number(propOf(note, "round") ?? 0) - Number(propOf(best, "round") ?? 0);
		if (byRound > 0 || (byRound === 0 && compareBasename(note, best) < 0)) best = note;
	}
	return best;
}

function planPart(notes: Note[], spec: Note): string {
	const plan = latestPlan(notes, propOf(spec, "trace"));
	if (plan === undefined) return "no plan yet";
	const audit = propOf(plan, "audit");
	const round = propOf(plan, "audit_round");
	const auditPart = audit === undefined ? "" : ` audit ${audit}${round === undefined ? "" : ` round ${round}`}`;
	return `plan ${plan.basename} ${propOf(plan, "status") ?? "-"}${auditPart}`;
}

function unfinishedLines(notes: Note[], repo: string | undefined): string[] {
	if (repo === undefined) return [];
	return notes
		.filter(
			(note) =>
				note.type === "spec" &&
				note.props.repo === repo &&
				(note.props.status === "draft" || note.props.status === "confirmed"),
		)
		.sort(compareBasename)
		.map((spec) => `${spec.basename} | ${planPart(notes, spec)} | host ${propOf(spec, "host") ?? "-"}`);
}

function ideaLines(notes: Note[], repo: string | undefined): string[] {
	return notes
		.filter(
			(note) =>
				note.type === "idea" &&
				note.props.status === "open" &&
				(note.props.repo === "-" || (repo !== undefined && note.props.repo === repo)),
		)
		.sort(compareBasename)
		.map((note) => note.basename);
}

function runLines(notes: Note[], repo: string | undefined): string[] {
	if (repo === undefined) return [];
	return notes
		.filter((note) => note.type === "run" && note.props.repo === repo)
		.sort((a, b) => compareStrings(propOf(b, "updated") ?? "", propOf(a, "updated") ?? "") || compareBasename(a, b))
		.slice(0, 3)
		.map((note) => `${note.basename} | ${propOf(note, "gate") ?? "-"} | ${propOf(note, "updated") ?? "-"}`);
}

function sectionItem(header: string, lines: string[]): BootItem[] {
	return lines.length === 0 ? [] : [{ header, content: `${lines.join("\n")}\n` }];
}

function bootItems(notes: Note[], repo: string | undefined, logLines: string[]): BootItem[] {
	const items: BootItem[] = [];
	const project = projectFor(notes, repo);
	if (project !== undefined) {
		items.push({ header: `=== project ${project.basename} ===`, content: serializeNote(project) });
	}
	if (repo !== undefined) {
		const findings = notes
			.filter((note) => note.type === "finding" && note.props.status === "open" && note.props.repo === repo)
			.sort(compareFindings);
		for (const finding of findings) {
			items.push({ header: `=== finding ${finding.basename} ===`, content: serializeNote(finding) });
		}
	}
	items.push(...sectionItem("=== unfinished requests ===", unfinishedLines(notes, repo)));
	items.push(...sectionItem("=== open ideas ===", ideaLines(notes, repo)));
	items.push(...sectionItem("=== recent runs ===", runLines(notes, repo)));
	if (logLines.length > 0) {
		items.push({ header: "=== log tail ===", content: `${logLines.join("\n")}\n` });
	}
	items.push({ header: "=== index ===", content: indexText(notes) });
	return items;
}

function logTail(vault: string): string[] {
	const text = readText(path.join(vault, "log.md")) ?? "";
	return text.split("\n").filter((line) => line.trim() !== "").slice(-LOG_TAIL_LINES);
}

/** A blank line, a header line and the content; the separator completes the last line first. */
function itemChunks(claude: string, items: BootItem[]): string[] {
	const chunks: string[] = [];
	let atLineStart = claude === "" || claude.endsWith("\n");
	for (const item of items) {
		chunks.push(`${atLineStart ? "\n" : "\n\n"}${item.header}\n${item.content}`);
		atLineStart = item.content.endsWith("\n");
	}
	return chunks;
}

function truncationLine(dropped: number): string {
	return `\n[truncated: ${dropped} items]`;
}

/** The budget covers the items and the truncation line, not the CLAUDE.md text before them. */
function bestLayout(
	claude: string,
	items: BootItem[],
	budgetChars: number,
): { body: string; kept: number } | undefined {
	const chunks = itemChunks(claude, items);
	const lengths: number[] = [0];
	for (const chunk of chunks) lengths.push((lengths[lengths.length - 1] ?? 0) + chunk.length);
	for (let kept = items.length; kept >= 0; kept--) {
		const tail = kept === items.length ? "" : truncationLine(items.length - kept);
		if ((lengths[kept] ?? 0) + tail.length <= budgetChars) {
			return { body: chunks.slice(0, kept).join("") + tail, kept };
		}
	}
	return undefined;
}

export function bootText(vault: string, opts: { repo?: string; budgetTokens?: number } = {}): string {
	const budgetChars = Math.max(0, (opts.budgetTokens ?? DEFAULT_BOOT_BUDGET_TOKENS) * CHARS_PER_TOKEN);
	const claude = readText(path.join(vault, "CLAUDE.md")) ?? "";
	if (claude.length > budgetChars) return `${claude}\n[over budget: CLAUDE.md]\n`;

	const notes = listNotes(vault);
	const tail = logTail(vault);
	const counts = tail.length === 0 ? [0] : tail.map((_, i) => tail.length - i);
	let best: { kept: number; text: string } | undefined;
	for (const count of counts) {
		const items = bootItems(notes, opts.repo, count === 0 ? [] : tail.slice(-count));
		const layout = bestLayout(claude, items, budgetChars);
		if (layout === undefined) continue;
		if (best === undefined || layout.kept > best.kept) best = { kept: layout.kept, text: claude + layout.body };
		if (best.kept === items.length) break;
	}
	if (best !== undefined) return best.text;
	const items = bootItems(notes, opts.repo, tail);
	return `${claude}${truncationLine(items.length)}`;
}

function traceOf(note: Note): string {
	const value = note.props.trace;
	return typeof value === "string" ? value : "";
}

function fingerprintOf(note: Note): string {
	const value = note.props.fingerprint;
	return typeof value === "string" ? value : "";
}

/** The regular files below work/ at any depth, without the .gitkeep placeholders. */
function workSize(dir: string): { workFiles: number; workBytes: number } {
	let workFiles = 0;
	let workBytes = 0;
	const walk = (folder: string): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(folder, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = path.join(folder, entry.name);
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			if (!entry.isFile() || entry.name === ".gitkeep") continue;
			try {
				workFiles += 1;
				workBytes += fs.statSync(full).size;
			} catch {
				// A file removed between the listing and the stat is not counted.
			}
		}
	};
	walk(path.join(dir, "work"));
	return { workFiles, workBytes };
}

export function statsFor(
	vault: string,
	opts: { repo?: string; all?: boolean; lastTraces?: number } = {},
): {
	bootTokens: number;
	counts: Record<string, number>;
	repeats: number;
	total: number;
	repeatRate: number | null;
	workFiles: number;
	workBytes: number;
} {
	const notes = listNotes(vault);
	const counts: Record<string, number> = {};
	for (const type of NOTE_TYPES) counts[type] = 0;
	for (const note of notes) counts[note.type] = (counts[note.type] ?? 0) + 1;

	const bootTokens = Math.ceil(bootText(vault, { repo: opts.repo, budgetTokens: 1e9 }).length / CHARS_PER_TOKEN);

	const repo = opts.all === true ? undefined : opts.repo;
	const findings = notes.filter(
		(note) => note.type === "finding" && (repo === undefined || note.props.repo === repo),
	);

	const earliest = new Map<string, string>();
	for (const finding of findings) {
		const trace = traceOf(finding);
		const current = earliest.get(trace);
		const created = createdOf(finding);
		if (current === undefined || created < current) earliest.set(trace, created);
	}
	const order = [...earliest.keys()].sort((a, b) => {
		const byCreated = compareStrings(earliest.get(a) ?? "", earliest.get(b) ?? "");
		return byCreated !== 0 ? byCreated : compareStrings(a, b);
	});
	const position = new Map(order.map((trace, index) => [trace, index]));

	const firstSeen = new Map<string, number>();
	for (const finding of findings) {
		const index = position.get(traceOf(finding)) ?? 0;
		const fingerprint = fingerprintOf(finding);
		const seen = firstSeen.get(fingerprint);
		if (seen === undefined || index < seen) firstSeen.set(fingerprint, index);
	}

	const wanted = opts.lastTraces ?? 10;
	const window: Set<string> = wanted <= 0 ? new Set() : new Set(order.slice(-wanted));
	let total = 0;
	let repeats = 0;
	for (const finding of findings) {
		const trace = traceOf(finding);
		if (!window.has(trace)) continue;
		total += 1;
		const index = position.get(trace) ?? 0;
		const seen = firstSeen.get(fingerprintOf(finding));
		if (seen !== undefined && seen < index) repeats += 1;
	}
	return { bootTokens, counts, repeats, total, repeatRate: total === 0 ? null : repeats / total, ...workSize(vault) };
}
