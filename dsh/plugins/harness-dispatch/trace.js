/** Append-only event log, evidence snapshots, fault detection and the gate. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { filesOverlap } from "./schedule.js";

export const planSpan = (planId) => `plan:${planId}`;
export const taskSpan = (planId, taskId, attempt) => `task:${planId}/${taskId}#${attempt}`;

export function shortHash(text) {
	return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

export function tracePath(root, trace) {
	return path.join(root, "traces", `${trace}.jsonl`);
}

export function appendEvent(root, ev) {
	const full = { v: 1, ts: new Date().toISOString(), ...ev };
	const file = tracePath(root, ev.trace);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.appendFileSync(file, `${JSON.stringify(full)}\n`);
	return full;
}

export function readEvents(root, trace) {
	try {
		return fs
			.readFileSync(tracePath(root, trace), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
	} catch {
		return [];
	}
}

const MAX_HASH_BYTES = 5 * 1024 * 1024;

export function snapshotDirty(cwd) {
	let out;
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
	const snap = new Map();
	const parts = out.split("\0");
	for (let i = 0; i < parts.length; i++) {
		const entry = parts[i];
		if (entry.length < 4) continue;
		const xy = entry.slice(0, 2);
		const file = entry.slice(3);
		if (/[RC]/.test(xy)) i++;
		if (file.startsWith(".plans/")) continue;
		snap.set(file, hashFile(path.join(cwd, file)));
	}
	return snap;
}

function hashFile(abs) {
	try {
		const st = fs.statSync(abs);
		if (!st.isFile()) return "not-a-file";
		if (st.size > MAX_HASH_BYTES) return `big:${st.size}:${st.mtimeMs}`;
		return createHash("sha1").update(fs.readFileSync(abs)).digest("hex");
	} catch {
		return "deleted";
	}
}

export function trackedFiles(cwd) {
	let out;
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

export function changedSince(before, after) {
	const out = new Set();
	for (const [f, h] of after) if (before.get(f) !== h) out.add(f);
	for (const f of before.keys()) if (!after.has(f)) out.add(f);
	return [...out].sort();
}

export function parseReport(output) {
	const keys = ["STATUS", "CHANGED", "TESTS", "NOTES", "NEEDS"];
	const found = new Map();
	let cur;
	for (const line of output.split(/\r?\n/)) {
		const m = /^(STATUS|CHANGED|TESTS|NOTES|NEEDS)\s*:\s*(.*)$/.exec(line.trim());
		if (m) {
			cur = m[1];
			const prev = found.get(cur);
			if (!prev) found.set(cur, m[2] ? [m[2]] : []);
			else if (m[2]) prev.push(m[2]);
		} else if (cur) found.get(cur).push(line);
	}
	const text = (k) => (found.get(k) || []).join("\n").trim();
	const changed = (found.get("CHANGED") || [])
		.map((l) => l.trim().replace(/^[-*]\s*/, "").replace(/^`|`$/g, "").trim())
		.filter((l) => l && !/^\(?(none|n\/a|nothing)/i.test(l) && !/^\(dry run/i.test(l));
	return { status: text("STATUS") || undefined, changed, tests: text("TESTS"), hasAll: keys.every((k) => found.has(k)) };
}

const WRITE_TOOL = /edit|write|patch/i;
const READ_TOOL = /read/i;
const SHELL_TOOL = /bash|shell|exec/i;
const TEST_HINT = /\b(tests?|pytest|vitest|jest|go test|npm run|pnpm|yarn|tsc|lint|typecheck|build)\b/i;
const NO_TESTS = /^(none|n\/a|not run|no tests?|-|skipped)?\.?$/i;

export function relPath(cwd, p) {
	const rel = path.isAbsolute(p) ? path.relative(cwd, p) : p;
	return rel.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function editedPaths(cwd, tools) {
	const set = new Set();
	for (const t of tools || []) if (WRITE_TOOL.test(t.name) && t.path && !t.blocked) set.add(relPath(cwd, t.path));
	return [...set].sort();
}

export function detectFaults(inp) {
	const { cwd, plan, results, changed, dry } = inp;
	const faults = [];
	const add = (code, severity, message, task) => faults.push({ code, severity, task, message });

	for (const t of plan.tasks) {
		if (t.state === "failed") add("task_failed", "error", firstLine(t.summary) || "worker failed", t.id);
		else if (t.state === "skipped") add("task_skipped", "warn", firstLine(t.summary) || "skipped", t.id);
		const implementerAttempts = t.attempts - t.pairRound;
		if (t.state === "done" && implementerAttempts > 1) add("retried", "info", `succeeded on attempt ${implementerAttempts}`, t.id);
	}
	if (dry) return faults;

	const changedSet = new Set(changed || []);
	const readonly = inp.readonlyTasks ?? new Set();
	const owners = (file) => plan.tasks.filter((t) => t.files.length > 0 && filesOverlap([file], t.files));
	const violations = new Map();
	const blame = (taskId, label, files) => {
		if (!files.length) return;
		const entry = violations.get(taskId) ?? { label, files: new Set() };
		for (const f of files) entry.files.add(f);
		violations.set(taskId, entry);
	};

	const reviewerWindows = windowBlame(inp.reviewerWindows, plan, cwd);
	const readonlyWindows = windowBlame(inp.readonlyWindows, plan, cwd);

	for (const t of plan.tasks) {
		const r = results.get(t.id);
		if (!r || t.state !== "done") continue;
		const report = parseReport(r.output);
		const edited = editedPaths(cwd, r.tools);

		const outside = t.files.length ? edited.filter((p) => !filesOverlap([p], t.files)) : [];
		if (outside.length) add("out_of_scope_edit", "error", `edited outside its files: ${outside.join(", ")}`, t.id);

		if (readonly.has(t.id)) {
			const owned = t.files.length
				? (changed || []).filter((f) => filesOverlap([f], t.files) && owners(f).every((o) => readonly.has(o.id)))
				: [];
			const window = readonlyWindows.get(t.id) ?? [];
			blame(t.id, "read-only task changed files", [...edited, ...owned, ...window]);
			continue;
		}

		if (!report.hasAll) add("report_malformed", "warn", "final report is missing STATUS/CHANGED/TESTS/NOTES/NEEDS sections", t.id);

		const claimedNotDone = report.changed.map((p) => relPath(cwd, p)).filter((p) => !changedSet.has(p) && !edited.includes(p));
		if (changed && claimedNotDone.length) add("claimed_not_changed", "warn", `reported as changed, but no edit seen: ${claimedNotDone.join(", ")}`, t.id);

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

	for (const [taskId, { role, report }] of inp.reviews ?? new Map()) {
		if (!isSecurityReview(role, report)) continue;
		for (const f of report.findings) {
			add("security_finding", FINDING_SEVERITY[f.severity ?? "medium"], findingText(f), taskId);
		}
		if (report.verdict === "unknown") add("review_unparsed", "warn", "security review returned no readable verdict; its findings may be missing", taskId);
	}

	for (const [taskId, p] of inp.pairs ?? new Map()) {
		if (p.unresolved.length) {
			const shown = p.unresolved.slice(0, 3).map(findingText).join("; ");
			const more = p.unresolved.length > 3 ? ` (+${p.unresolved.length - 3} more)` : "";
			add("pair_unresolved", "warn", `${p.unresolved.length} finding(s) still open after ${p.rounds} pair round(s): ${shown}${more}`, taskId);
		} else if (p.finalVerdict === "changes" || p.finalVerdict === "issues") {
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

const FINDING_SEVERITY = { high: "error", medium: "warn", low: "info" };

function isSecurityReview(role, report) {
	return role === "security" || report.verdict === "clean" || report.verdict === "issues";
}

function findingText(f) {
	return f.location ? `${f.location}: ${f.text}` : f.text;
}

function reviewerFaults(add, cwd, plan, inp, blame, windows) {
	const tools = inp.reviewerTools ?? new Map();
	for (const [taskId, records] of tools) blockedFault(add, taskId, records);
	for (const t of plan.tasks) {
		const records = tools.get(t.id) || [];
		blame(t.id, "pair reviewer changed files", [...editedPaths(cwd, records), ...(windows.get(t.id) ?? [])]);
	}
}

function windowBlame(windows, plan, cwd) {
	const out = new Map();
	for (const [taskId, records] of windows ?? new Map()) {
		const files = new Set();
		for (const r of records) for (const f of blamedInWindow(r, plan, cwd)) files.add(f);
		if (files.size) out.set(taskId, [...files].sort());
	}
	return out;
}

function blamedInWindow(record, plan, cwd) {
	const beside = plan.tasks.filter((t) => record.concurrent.includes(t.id) && t.files.length > 0);
	const theirs = beside.flatMap((t) => t.files.map((f) => relPath(cwd, f)));
	return record.changed.map((f) => relPath(cwd, f)).filter((f) => !filesOverlap([f], theirs));
}

function blockedFault(add, taskId, tools) {
	const blocked = (tools || []).filter((t) => t.blocked);
	if (!blocked.length) return;
	const shown = blocked
		.slice(0, 3)
		.map((t) => `${t.name} ${t.path || t.detail || ""}`.trim())
		.join(", ");
	add("blocked_action", "warn", `${blocked.length} tool call(s) blocked by the guard: ${shown}`, taskId);
}

function unreadEdits(cwd, tools, existed) {
	const read = new Set();
	const shell = [];
	const hits = new Set();
	for (const t of tools) {
		const p = t.path ? relPath(cwd, t.path) : undefined;
		if (READ_TOOL.test(t.name) && p) read.add(p);
		if (SHELL_TOOL.test(t.name) && t.detail) shell.push(t.detail);
		if (!WRITE_TOOL.test(t.name) || !p) continue;
		if (existed(p) && !read.has(p) && !shell.some((c) => c.includes(p))) hits.add(p);
	}
	return [...hits].sort();
}

function firstLine(s) {
	return (s || "").split("\n")[0].slice(0, 200);
}

export function evaluateGate(plan, faults, dry, haveGit) {
	const counts = { error: 0, warn: 0, info: 0 };
	for (const f of faults) counts[f.severity]++;
	const n = (s) => plan.tasks.filter((t) => t.state === s).length;
	const tasks = { done: n("done"), failed: n("failed"), skipped: n("skipped") };
	const reasons = [];
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

export function toolStats(tools, cwd) {
	const byName = {};
	for (const t of tools || []) byName[t.name] = (byName[t.name] || 0) + 1;
	return {
		total: (tools || []).length,
		by_name: byName,
		edits: editedPaths(cwd, tools),
		errors: (tools || []).filter((t) => t.isError).length,
		blocked: (tools || []).filter((t) => t.blocked).length,
	};
}
