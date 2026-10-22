/**
 * pi-plan-dispatch tracing: append-only event log, evidence snapshots, fault
 * detection and the gate. No Pi imports, so it can be tested on its own.
 *
 * One trace = one user request across all rounds. Events from the planner,
 * the dispatcher and the auditor all append to `.plans/traces/<trace>.jsonl`.
 * Spans link up through `parent`: audit -> plan -> prior plan (fix rounds).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { filesOverlap, type Plan, type PlanTask, type ToolRecord, type WorkerResult } from "./core.ts";
import type { ReviewFinding, ReviewReport } from "./review.ts";

// ---------- Event log ----------

export interface TraceEvent {
	v: 1;
	ts: string;
	trace: string;
	span: string;
	parent?: string;
	actor: string;
	kind: string;
	plan?: string;
	round?: number;
	task?: string;
	attempt?: number;
	data?: Record<string, unknown>;
}

export type NewEvent = Omit<TraceEvent, "v" | "ts">;

export const planSpan = (planId: string) => `plan:${planId}`;
export const taskSpan = (planId: string, taskId: string, attempt: number) => `task:${planId}/${taskId}#${attempt}`;

export function shortHash(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

export function tracePath(root: string, trace: string): string {
	return path.join(root, "traces", `${trace}.jsonl`);
}

export function appendEvent(root: string, ev: NewEvent): TraceEvent {
	const full: TraceEvent = { v: 1, ts: new Date().toISOString(), ...ev };
	const file = tracePath(root, ev.trace);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	// One short line per write: appends this small are effectively atomic.
	fs.appendFileSync(file, `${JSON.stringify(full)}\n`);
	return full;
}

export function readEvents(root: string, trace: string): TraceEvent[] {
	try {
		return fs
			.readFileSync(tracePath(root, trace), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l) as TraceEvent);
	} catch {
		return [];
	}
}

// ---------- Evidence: what actually changed in the checkout ----------

/** path -> content hash for every dirty file in the git checkout. undefined = not a git repo. */
export type Snapshot = Map<string, string>;

const MAX_HASH_BYTES = 5 * 1024 * 1024;

export function snapshotDirty(cwd: string): Snapshot | undefined {
	let out: string;
	try {
		out = execFileSync("git", ["status", "--porcelain", "-z", "--untracked-files=all"], {
			cwd,
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		return undefined;
	}
	const snap: Snapshot = new Map();
	const parts = out.split("\0");
	for (let i = 0; i < parts.length; i++) {
		const entry = parts[i];
		if (entry.length < 4) continue;
		const xy = entry.slice(0, 2);
		const file = entry.slice(3);
		if (/[RC]/.test(xy)) i++; // renames/copies carry the old path as the next token
		if (file.startsWith(".plans/")) continue;
		snap.set(file, hashFile(path.join(cwd, file)));
	}
	return snap;
}

function hashFile(abs: string): string {
	try {
		const st = fs.statSync(abs);
		if (!st.isFile()) return "not-a-file";
		if (st.size > MAX_HASH_BYTES) return `big:${st.size}:${st.mtimeMs}`;
		return createHash("sha1").update(fs.readFileSync(abs)).digest("hex");
	} catch {
		return "deleted";
	}
}

/** Repo-relative paths git already tracks (existed before the plan). undefined = not a git repo. */
export function trackedFiles(cwd: string): Set<string> | undefined {
	let out: string;
	try {
		out = execFileSync("git", ["ls-files", "-z"], {
			cwd,
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		return undefined;
	}
	return new Set(
		out
			.split("\0")
			.filter(Boolean)
			.map((f) => f.replace(/\\/g, "/")),
	);
}

/** Files whose state differs between two snapshots (new, edited again, or cleaned up). */
export function changedSince(before: Snapshot, after: Snapshot): string[] {
	const out = new Set<string>();
	for (const [f, h] of after) if (before.get(f) !== h) out.add(f);
	for (const f of before.keys()) if (!after.has(f)) out.add(f);
	return [...out].sort();
}

// ---------- Report parsing ----------

export interface ParsedReport {
	status?: string;
	changed: string[];
	tests: string;
	hasAll: boolean;
}

export function parseReport(output: string): ParsedReport {
	const keys = ["STATUS", "CHANGED", "TESTS", "NOTES", "NEEDS"] as const;
	const found = new Map<string, string[]>();
	let cur: string | undefined;
	for (const line of output.split(/\r?\n/)) {
		const m = /^(STATUS|CHANGED|TESTS|NOTES|NEEDS)\s*:\s*(.*)$/.exec(line.trim());
		if (m) {
			cur = m[1];
			const prev = found.get(cur);
			if (!prev) found.set(cur, m[2] ? [m[2]] : []);
			else if (m[2]) prev.push(m[2]);
		} else if (cur) found.get(cur)!.push(line);
	}
	const text = (k: string) => (found.get(k) || []).join("\n").trim();
	const changed = (found.get("CHANGED") || [])
		.map((l) => l.trim().replace(/^[-*]\s*/, "").replace(/^`|`$/g, "").trim())
		.filter((l) => l && !/^\(?(none|n\/a|nothing)/i.test(l) && !/^\(dry run/i.test(l));
	return { status: text("STATUS") || undefined, changed, tests: text("TESTS"), hasAll: keys.every((k) => found.has(k)) };
}

// ---------- Faults and gate ----------

export type Severity = "error" | "warn" | "info";

export interface Fault {
	code: string;
	severity: Severity;
	task?: string;
	message: string;
}

export interface Gate {
	pass: boolean;
	reasons: string[];
	counts: Record<Severity, number>;
	tasks: { done: number; failed: number; skipped: number };
	evidence: "git+tools" | "tools" | "dry-run";
}

const WRITE_TOOL = /edit|write|patch/i;
const READ_TOOL = /read/i;
const SHELL_TOOL = /bash|shell|exec/i;
const TEST_HINT = /\b(tests?|pytest|vitest|jest|go test|npm run|pnpm|yarn|tsc|lint|typecheck|build)\b/i;
const NO_TESTS = /^(none|n\/a|not run|no tests?|-|skipped)?\.?$/i;

export function relPath(cwd: string, p: string): string {
	const rel = path.isAbsolute(p) ? path.relative(cwd, p) : p;
	return rel.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function editedPaths(cwd: string, tools: ToolRecord[] | undefined): string[] {
	const set = new Set<string>();
	// A blocked call never ran, so it changed nothing.
	for (const t of tools || []) if (WRITE_TOOL.test(t.name) && t.path && !t.blocked) set.add(relPath(cwd, t.path));
	return [...set].sort();
}

/** A reviewer's parsed report, keyed by the task it reviewed. */
export interface ReviewEntry {
	role: string;
	report: ReviewReport;
}

/**
 * One read-only worker run: a pair reviewer run for a task, or a read-only task's own run.
 * `changed` is the dirty-file snapshot diff around the run; `concurrent` are the other tasks
 * that were running at some point during it, so a file of theirs may be their change.
 */
export interface WindowRecord {
	changed: string[];
	concurrent: string[];
}

/** Pair loop state for one task. */
export interface PairState {
	/** Implementer runs the pair review asked for so far */
	rounds: number;
	/** Findings still open when the rounds ran out */
	unresolved: ReviewFinding[];
	/** The last reviewer report could not be parsed */
	unparsed: boolean;
	/** The reviewer's last verdict, kept even when it listed no findings */
	finalVerdict?: "approve" | "changes" | "clean" | "issues" | "unknown";
}

export interface FaultInput {
cwd: string;
plan: Plan;
/** Final result per task id (absent for skipped tasks). */
results: Map<string, WorkerResult>;
/** Files changed in the checkout during the plan; undefined when git evidence is unavailable. */
changed: string[] | undefined;
/** Independent verification outcome per task id, or "*" for the plan-level check. */
verify?: Map<string, { ok: boolean; summary: string }>;
/** Whether a repo-relative path existed before the plan (git ls-files). Absent = skip that check. */
existed?: (relPath: string) => boolean;
/** Task ids whose resolved role is read-only: no implementer checks, edits are a violation. */
readonlyTasks?: Set<string>;
/** Parsed reviewer report per reviewed task id (pair reviews and the security role). */
reviews?: Map<string, ReviewEntry>;
/** Pair loop outcome per task id. */
pairs?: Map<string, PairState>;
/** Tool records of each task's pair reviewer runs, all rounds. */
reviewerTools?: Map<string, ToolRecord[]>;
/** One window per pair reviewer run, keyed by the reviewed task id, all rounds. */
reviewerWindows?: Map<string, WindowRecord[]>;
/** One window per attempt of a read-only task's own worker run, keyed by its task id. */
readonlyWindows?: Map<string, WindowRecord[]>;
dry: boolean;
}

type FaultAdd = (code: string, severity: Severity, message: string, task?: string) => void;
/** Merge one source of read-only changes into a task's single `readonly_violation`. */
type Blame = (taskId: string, label: string, files: string[]) => void;

export function detectFaults(inp: FaultInput): Fault[] {
	const { cwd, plan, results, changed, dry } = inp;
	const faults: Fault[] = [];
	const add = (code: string, severity: Severity, message: string, task?: string) =>
		faults.push({ code, severity, task, message });

	for (const t of plan.tasks) {
		if (t.state === "failed") add("task_failed", "error", firstLine(t.summary) || "worker failed", t.id);
		else if (t.state === "skipped") add("task_skipped", "warn", firstLine(t.summary) || "skipped", t.id);
		// Pair re-runs also grow `attempts`, so only failed attempts count as a retry.
		const implementerAttempts = t.attempts - t.pairRound;
		if (t.state === "done" && implementerAttempts > 1) add("retried", "info", `succeeded on attempt ${implementerAttempts}`, t.id);
	}
	if (dry) return faults;

	const changedSet = new Set(changed || []);
	const readonly = inp.readonlyTasks ?? new Set<string>();
	const owners = (file: string): PlanTask[] =>
		plan.tasks.filter((t) => t.files.length > 0 && filesOverlap([file], t.files));
	const violations = new Map<string, { label: string; files: Set<string> }>();
	const blame: Blame = (taskId, label, files) => {
		if (!files.length) return;
		const entry = violations.get(taskId) ?? { label, files: new Set<string>() };
		for (const f of files) entry.files.add(f);
		violations.set(taskId, entry);
	};

	// Window blame is needed twice: to raise the violation, and to keep the same files out of the
	// implementer's unreported_change list, so one change is reported once.
	const reviewerWindows = windowBlame(inp.reviewerWindows, plan, cwd);
	const readonlyWindows = windowBlame(inp.readonlyWindows, plan, cwd);

	for (const t of plan.tasks) {
		const r = results.get(t.id);
		if (!r || t.state !== "done") continue;
		const report = parseReport(r.output);
		const edited = editedPaths(cwd, r.tools);

		const outside = t.files.length ? edited.filter((p) => !filesOverlap([p], t.files)) : [];
		if (outside.length) add("out_of_scope_edit", "error", `edited outside its files: ${outside.join(", ")}`, t.id);

		// A read-only role changes nothing and speaks another report format, so the
		// implementer checks below would only report noise; any edit is the fault.
		// Attribution: a file an implementer also owns is the implementer's change, never
		// the reviewer's, so only files owned by read-only tasks alone count against it.
		if (readonly.has(t.id)) {
			const owned = t.files.length
				? (changed || []).filter((f) => filesOverlap([f], t.files) && owners(f).every((o) => readonly.has(o.id)))
				: [];
			// A shell write never reaches the tool stream, so the snapshot around its own run is the backstop.
			const window = readonlyWindows.get(t.id) ?? [];
			blame(t.id, "read-only task changed files", [...edited, ...owned, ...window]);
			continue;
		}

		if (!report.hasAll) add("report_malformed", "warn", "final report is missing STATUS/CHANGED/TESTS/NOTES/NEEDS sections", t.id);

		const claimedNotDone = report.changed.map((p) => relPath(cwd, p)).filter((p) => !changedSet.has(p) && !edited.includes(p));
		if (changed && claimedNotDone.length) add("claimed_not_changed", "warn", `reported as changed, but no edit seen: ${claimedNotDone.join(", ")}`, t.id);

		// A file its own pair reviewer changed is the reviewer's fault alone, never an unreported edit.
		const fromReviewer = new Set(reviewerWindows.get(t.id) ?? []);
		const unreported = [...new Set([...edited, ...(changed || []).filter((f) => owners(f).length === 1 && owners(f)[0].id === t.id)])]
			.filter((p) => !fromReviewer.has(p))
			.filter((p) => !report.changed.map((c) => relPath(cwd, c)).includes(p));
		if (unreported.length) add("unreported_change", "warn", `changed but not in its CHANGED list: ${unreported.join(", ")}`, t.id);

		const touchedOwned = t.files.length > 0 && (changed || []).some((f) => filesOverlap([f], t.files));
		if (edited.length === 0 && !touchedOwned) add("no_op_done", "warn", "marked done but no edit tool call and no change in its files", t.id);

		if (TEST_HINT.test(t.body) && NO_TESTS.test(report.tests)) add("tests_not_run", "warn", "task names tests or checks, but TESTS reports none", t.id);
	}

	for (const t of plan.tasks) {
		const r = results.get(t.id);
		if (r) blockedFault(add, t.id, r.tools);
	}

	reviewerFaults(add, cwd, plan, inp, blame, reviewerWindows);
	for (const [taskId, v] of violations) add("readonly_violation", "error", `${v.label}: ${[...v.files].sort().join(", ")}`, taskId);

	if (inp.existed) {
		for (const t of plan.tasks) {
			const r = results.get(t.id);
			if (!r) continue;
			const unread = unreadEdits(cwd, r.tools || [], inp.existed);
			if (unread.length) add("edit_unread_file", "warn", `edited without reading first: ${unread.join(", ")}`, t.id);
		}
	}

	for (const [id, v] of inp.verify || []) {
		if (!v.ok) add("verify_failed", "error", v.summary, id === "*" ? undefined : id);
	}

	for (const [taskId, { role, report }] of inp.reviews ?? new Map<string, ReviewEntry>()) {
		if (!isSecurityReview(role, report)) continue;
		for (const f of report.findings) {
			// An unlabelled security finding counts as medium: visible, but not a gate failure on its own.
			add("security_finding", FINDING_SEVERITY[f.severity ?? "medium"], findingText(f), taskId);
		}
		if (report.verdict === "unknown") add("review_unparsed", "warn", "security review returned no readable verdict; its findings may be missing", taskId);
	}

	for (const [taskId, p] of inp.pairs ?? new Map<string, PairState>()) {
		if (p.unresolved.length) {
			const shown = p.unresolved.slice(0, 3).map(findingText).join("; ");
			const more = p.unresolved.length > 3 ? ` (+${p.unresolved.length - 3} more)` : "";
			add("pair_unresolved", "warn", `${p.unresolved.length} finding(s) still open after ${p.rounds} pair round(s): ${shown}${more}`, taskId);
		} else if (p.finalVerdict === "changes" || p.finalVerdict === "issues") {
			// A `changes` or `issues` verdict with an empty findings list is still an open review.
			add("pair_unresolved", "warn", `pair review ended in ${p.finalVerdict} after ${p.rounds} pair round(s) and listed no findings`, taskId);
		}
		if (p.unparsed) add("review_unparsed", "warn", "pair review report could not be parsed, so the review did not count", taskId);
	}

	if (changed && !plan.tasks.some((t) => t.files.length === 0)) {
		const stray = changed.filter((f) => owners(f).length === 0);
		if (stray.length) add("unowned_change", "error", `changed but owned by no task: ${stray.join(", ")}`);
	}
	return faults;
}

/** Security findings map to fault severities; the gate fails on high only. */
const FINDING_SEVERITY: Record<"high" | "medium" | "low", Severity> = { high: "error", medium: "warn", low: "info" };

/** The security kind of review uses the clean/issues verdict; `role: security` decides too. */
function isSecurityReview(role: string, report: ReviewReport): boolean {
	return role === "security" || report.verdict === "clean" || report.verdict === "issues";
}

function findingText(f: ReviewFinding): string {
	return f.location ? `${f.location}: ${f.text}` : f.text;
}

/**
 * Pair reviewers are meant to be read-only. The guard blocks their edit tools, so a file
 * they did change shows up in the dirty-file snapshot around their run instead (G2).
 */
function reviewerFaults(add: FaultAdd, cwd: string, plan: Plan, inp: FaultInput, blame: Blame, windows: Map<string, string[]>) {
	const tools = inp.reviewerTools ?? new Map<string, ToolRecord[]>();
	for (const [taskId, records] of tools) blockedFault(add, taskId, records);
	for (const t of plan.tasks) {
		const records = tools.get(t.id) || [];
		blame(t.id, "pair reviewer changed files", [...editedPaths(cwd, records), ...(windows.get(t.id) ?? [])]);
	}
}

/** Files to blame on the read-only worker of each window, keyed by the window's task id. */
function windowBlame(windows: Map<string, WindowRecord[]> | undefined, plan: Plan, cwd: string): Map<string, string[]> {
	const out = new Map<string, string[]>();
	for (const [taskId, records] of windows ?? new Map<string, WindowRecord[]>()) {
		const files = new Set<string>();
		for (const r of records) for (const f of blamedInWindow(r, plan, cwd)) files.add(f);
		if (files.size) out.set(taskId, [...files].sort());
	}
	return out;
}

/**
 * A window file is the read-only worker's doing unless a task running beside it owns the file:
 * that task may have written it. Everything else is blamed, including files of tasks that had
 * already finished and files no task owns. The window's own task is never concurrent, so it
 * answers for its own files too. A task with no `files:` runs alone, so it cannot be concurrent.
 */
function blamedInWindow(record: WindowRecord, plan: Plan, cwd: string): string[] {
	const beside = plan.tasks.filter((t) => record.concurrent.includes(t.id) && t.files.length > 0);
	const theirs = beside.flatMap((t) => t.files.map((f) => relPath(cwd, f)));
	return record.changed.map((f) => relPath(cwd, f)).filter((f) => !filesOverlap([f], theirs));
}

/** One warn per task whose worker tried to do something the live guard blocked (G2). */
function blockedFault(add: FaultAdd, taskId: string, tools: ToolRecord[] | undefined) {
	const blocked = (tools || []).filter((t) => t.blocked);
	if (!blocked.length) return;
	const shown = blocked
		.slice(0, 3)
		.map((t) => `${t.name} ${t.path || t.detail || ""}`.trim())
		.join(", ");
	add("blocked_action", "warn", `${blocked.length} tool call(s) blocked by the guard: ${shown}`, taskId);
}

/** Edits to files that existed before the plan, with no earlier read or bash mention of the path (G3). */
function unreadEdits(cwd: string, tools: ToolRecord[], existed: (relPath: string) => boolean): string[] {
	const read = new Set<string>();
	const shell: string[] = [];
	const hits = new Set<string>();
	for (const t of tools) {
		const p = t.path ? relPath(cwd, t.path) : undefined;
		if (READ_TOOL.test(t.name) && p) read.add(p);
		if (SHELL_TOOL.test(t.name) && t.detail) shell.push(t.detail);
		if (!WRITE_TOOL.test(t.name) || !p) continue;
		if (existed(p) && !read.has(p) && !shell.some((c) => c.includes(p))) hits.add(p);
	}
	return [...hits].sort();
}

function firstLine(s?: string): string {
	return (s || "").split("\n")[0].slice(0, 200);
}

export function evaluateGate(plan: Plan, faults: Fault[], dry: boolean, haveGit: boolean): Gate {
	const counts: Record<Severity, number> = { error: 0, warn: 0, info: 0 };
	for (const f of faults) counts[f.severity]++;
	const n = (s: string) => plan.tasks.filter((t) => t.state === s).length;
	const tasks = { done: n("done"), failed: n("failed"), skipped: n("skipped") };
	const reasons: string[] = [];
	if (dry) reasons.push("dry run: nothing was changed");
	if (tasks.failed) reasons.push(`${tasks.failed} task(s) failed`);
	if (tasks.skipped) reasons.push(`${tasks.skipped} task(s) skipped`);
	if (counts.error) reasons.push(`${counts.error} error fault(s)`);
	return {
		pass: reasons.length === 0,
		reasons,
		counts,
		tasks,
		evidence: dry ? "dry-run" : haveGit ? "git+tools" : "tools",
	};
}

// ---------- Per-task stats for events and evidence.json ----------

export function toolStats(tools: ToolRecord[] | undefined, cwd: string) {
	const byName: Record<string, number> = {};
	for (const t of tools || []) byName[t.name] = (byName[t.name] || 0) + 1;
	return {
		total: (tools || []).length,
		by_name: byName,
		edits: editedPaths(cwd, tools),
		errors: (tools || []).filter((t) => t.isError).length,
		blocked: (tools || []).filter((t) => t.blocked).length,
	};
}
