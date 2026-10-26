/**
 * pi-plan-dispatch core: plan parsing, scheduling, and worker execution.
 * No Pi imports here, so it can be tested on its own.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BLOCKED_MARKER, GUARD_ENV, VAULT_ENV } from "./guard.ts";
import { StallTracker } from "./resilience.ts";

// ---------- Roles ----------

/**
 * A role is a named job (implement, review, security, qa) with its own model,
 * thinking level and prompt. Plans name a role; `.plans/config.json` maps it to
 * a model, so a provider change is a config change.
 */
export interface RoleConfig {
	model?: string;
	/** Empty or missing means: do not pass --thinking to Pi */
	thinking?: string;
	/** A read-only role may not edit anything; findings go in the final message */
	readonly?: boolean;
	/** Appended to the worker prompt as a "## Your role" section */
	prompt?: string;
}

export const DEFAULT_ROLES: Record<string, RoleConfig> = {
	implement: {
		// No model or thinking: both fall back to the plan and config defaults.
		prompt: [
			"You implement exactly one task, in the files you own.",
			"Read every file before you edit it, then change only what the task asks for, run the checks it names, and report what you actually did.",
			"Do not refactor nearby code, do not add features nobody asked for, and do not touch files outside your list.",
		].join("\n"),
	},
	review: {
		model: "opencode-go/minimax-m3.1-flash-free",
		thinking: "low",
		readonly: true,
		prompt: [
			"You review another engineer's change for one task. You are read-only: inspect with the read tools and `git diff -- <files>`, and never edit anything.",
			"The checkout may contain unrelated uncommitted edits, so judge only the task's files and instructions.",
			"Look for wrong behaviour, missed requirements, unhandled edge cases, broken interfaces and invented APIs.",
			"Do not praise, and do not nitpick style. Reply in the review format: `VERDICT: approve | changes`, then `FINDINGS:` with `- <path>:<line>: <problem>. <fix>.` or `none`.",
		].join("\n"),
	},
	security: {
		model: "opencode-go/glm-5.3-flash",
		thinking: "high",
		readonly: true,
		prompt: [
			"You are a security reviewer, and you are read-only.",
			"Look for injection, unsafe deserialisation, path traversal, authn/authz gaps, secrets in code, unsafe shell use, missing input validation, SSRF and insecure defaults.",
			"Give every finding a severity, and say `clean` only if you actually read the files.",
			"Reply in the security format: `VERDICT: clean | issues`, then `FINDINGS:` with `- [high|medium|low] <path>:<line>: <problem>. <fix>.` or `none`.",
		].join("\n"),
	},
	qa: {
		model: "opencode-go/mimo-v2.6-flash",
		// Empty thinking: no --thinking flag, because MiMo's levels are unknown.
		thinking: "",
		prompt: [
			"You write and run tests for the behaviour this task describes, in the files you own (test files unless the task says otherwise).",
			"Read the code under test first, cover the real behaviour and the edge cases, and put any bug you find under NEEDS prefixed `BUG:`.",
			"Do not change production code, and report the command output you actually saw.",
		].join("\n"),
	},
};

/** Pair review rounds when a plan does not set `pair_rounds:` */
export const DEFAULT_PAIR_ROUNDS = 2;

function cloneRoles(roles: Record<string, RoleConfig>): Record<string, RoleConfig> {
	return Object.fromEntries(Object.entries(roles).map(([name, role]) => [name, { ...role }]));
}

/** Keep only the known RoleConfig fields, so a config typo cannot leak into a role. */
function roleFrom(value: unknown): RoleConfig {
	const o = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	const role: RoleConfig = {};
	if (typeof o.model === "string") role.model = o.model;
	if (typeof o.thinking === "string") role.thinking = o.thinking;
	if (typeof o.readonly === "boolean") role.readonly = o.readonly;
	if (typeof o.prompt === "string") role.prompt = o.prompt;
	return role;
}

/** A user entry for a role overrides only the fields it sets. */
function mergeRoles(over: unknown): Record<string, RoleConfig> {
	const merged = cloneRoles(DEFAULT_ROLES);
	const o = over && typeof over === "object" && !Array.isArray(over) ? (over as Record<string, unknown>) : {};
	for (const [name, value] of Object.entries(o)) merged[name] = { ...(merged[name] ?? {}), ...roleFrom(value) };
	return merged;
}

// ---------- Types ----------

export interface DispatchConfig {
	/** Worker model, e.g. "opencode-go/deepseek-v4.1-flash" */
	model: string;
	/** Worker thinking level (DeepSeek V4.1 Flash supports low | high | max) */
	thinking: string;
	/** Default parallel workers when a plan doesn't set max_parallel */
	maxParallel: number;
	/** Kill a worker after this many minutes */
	timeoutMinutes: number;
	/** Retries per failed task (0 = no retry) */
	retries: number;
	/** Optional --tools list for workers (empty = Pi defaults + your extensions) */
	tools: string[];
	/** Command used to launch workers */
	piCommand: string;
	/** Simulate workers instead of calling a model */
	dryRun: boolean;
	/** Save each worker's Pi session under .plans/sessions/<plan>/ so it can be reopened (false = ephemeral) */
	persistSessions: boolean;
	/** Kill a `verify:` command after this many minutes (0 = no timeout) */
	verifyTimeoutMinutes: number;
	/** Register the worker-side `tool_call` guard in worker processes (G2) */
	workerGuards: boolean;
	/** Reject a plan whose task lists more files than this */
	maxFilesPerTask: number;
	/** Reject a plan whose task body is longer than this many characters */
	maxTaskChars: number;
	/** Role name to model, thinking, read-only flag and prompt */
	roles: Record<string, RoleConfig>;
	/** Cap on worker runs for one task: implementer runs plus pair reviewer runs */
	maxRunsPerTask: number;
	/** Resumes of the same session after a transient error, before `retries` applies (0 = off) */
	transientRetries: number;
	/** Seconds to wait before resume n (1-based); past the end the last value repeats */
	backoffSeconds: number[];
	/** Kill a worker that prints nothing for this many minutes (0 = off) */
	stallMinutes: number;
	/** Give up on an outage after this many minutes without a healthy probe */
	outagePauseMinutes: number;
	/** Wait this long between network probes while an outage is open */
	probeSeconds: number;
	/** Any of these URLs answering with any HTTP status means the network is up */
	probeUrls: string[];
}

export const DEFAULT_CONFIG: DispatchConfig = {
	model: "opencode-go/deepseek-v4.1-flash",
	thinking: "low",
	maxParallel: 3,
	timeoutMinutes: 20,
	retries: 1,
	tools: [],
	piCommand: "pi",
	dryRun: false,
	persistSessions: true,
	verifyTimeoutMinutes: 10,
	workerGuards: true,
	maxFilesPerTask: 10,
	maxTaskChars: 8000,
	roles: cloneRoles(DEFAULT_ROLES),
	maxRunsPerTask: 8,
	transientRetries: 6,
	backoffSeconds: [15, 30, 60, 120, 300, 300],
	stallMinutes: 3,
	outagePauseMinutes: 30,
	probeSeconds: 30,
	probeUrls: ["https://openrouter.ai", "https://opencode.ai"],
};

export type TaskState = "pending" | "running" | "done" | "failed" | "skipped";

export interface PlanTask {
	id: string;
	files: string[];
	dependsOn: string[];
	model?: string;
	thinking?: string;
	/** Role name from the `role:` line (default `implement`) */
	role?: string;
	/** Role that reviews this task after it passes (`pair:`); must be read-only */
	pair?: string;
	/** Pair review rounds to run before an open review is recorded (1-3, default 2) */
	pairRounds?: number;
	/** Implementer re-runs caused by a pair review so far; counted apart from retries */
	pairRound: number;
	/** Shell command the dispatcher runs after a successful attempt (exit 0 = verified) */
	verify?: string;
	/** Resumes of this task's session after transient errors so far; counted apart from attempts */
	resumes?: number;
	/** Failure output fed to the next attempt */
	feedback?: string;
	/** What `feedback` is: a verify failure (default) or review findings */
	feedbackKind?: "verify" | "review";
	body: string;
	state: TaskState;
	attempts: number;
	summary?: string;
	cost?: number;
	startedAt?: number;
	endedAt?: number;
}

export interface Plan {
	id: string;
	status: string;
	maxParallel?: number;
	model?: string;
	thinking?: string;
	/** Trace id shared by every plan of one user request (defaults to the plan id) */
	trace: string;
	/** Id of the plan this one follows up (fix rounds), for span linking */
	parent?: string;
	/** 1 for the first plan of a trace, +1 per fix round */
	round?: number;
	/** Integration check run once after every task is done */
	verify?: string;
	/** Text between frontmatter and the first task: shared context for every worker */
	context: string;
	tasks: PlanTask[];
}

export interface Dirs {
	root: string;
	inbox: string;
	running: string;
	done: string;
	failed: string;
}

export function getDirs(cwd: string): Dirs {
	const root = path.join(cwd, ".plans");
	return {
		root,
		inbox: path.join(root, "inbox"),
		running: path.join(root, "running"),
		done: path.join(root, "done"),
		failed: path.join(root, "failed"),
	};
}

export function ensureDirs(d: Dirs) {
	for (const p of [d.inbox, d.running, d.done, d.failed]) fs.mkdirSync(p, { recursive: true });
}

/** A finite number that passes `ok`, else the default; fractions are allowed. */
function numberOr(value: unknown, fallback: number, ok: (n: number) => boolean = (n) => n >= 0): number {
	return typeof value === "number" && Number.isFinite(value) && ok(value) ? value : fallback;
}

/** A list of positive numbers, else the default. An empty list is valid. */
function numbersOr(value: unknown, fallback: number[]): number[] {
	if (!Array.isArray(value)) return [...fallback];
	if (!value.every((v) => typeof v === "number" && Number.isFinite(v) && v > 0)) return [...fallback];
	return [...(value as number[])];
}

/** A list of non-empty strings, else the default. An empty list is valid. */
function stringsOr(value: unknown, fallback: string[]): string[] {
	if (!Array.isArray(value)) return [...fallback];
	if (!value.every((v) => typeof v === "string" && v.length > 0)) return [...fallback];
	return [...(value as string[])];
}

export function loadConfig(d: Dirs): DispatchConfig {
	const file = path.join(d.root, "config.json");
	let raw: any;
	try {
		raw = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return { ...DEFAULT_CONFIG, roles: cloneRoles(DEFAULT_ROLES) };
	}
	const cfg: DispatchConfig = { ...DEFAULT_CONFIG, ...raw, roles: mergeRoles(raw?.roles) };
	// Resilience keys are repaired rather than trusted: a typo must not turn a
	// guard off silently or make the dispatcher wait forever.
	cfg.transientRetries = numberOr(raw?.transientRetries, DEFAULT_CONFIG.transientRetries, (n) => Number.isInteger(n) && n >= 0);
	cfg.backoffSeconds = numbersOr(raw?.backoffSeconds, DEFAULT_CONFIG.backoffSeconds);
	cfg.stallMinutes = numberOr(raw?.stallMinutes, DEFAULT_CONFIG.stallMinutes, (n) => n >= 0);
	cfg.outagePauseMinutes = numberOr(raw?.outagePauseMinutes, DEFAULT_CONFIG.outagePauseMinutes, (n) => n > 0);
	cfg.probeSeconds = numberOr(raw?.probeSeconds, DEFAULT_CONFIG.probeSeconds, (n) => n > 0);
	cfg.probeUrls = stringsOr(raw?.probeUrls, DEFAULT_CONFIG.probeUrls);
	return cfg;
}

/** Every role name the config knows: the built-ins plus any the user added. */
export function knownRoles(cfg: DispatchConfig): string[] {
	return [...new Set([...Object.keys(DEFAULT_ROLES), ...Object.keys(cfg.roles ?? {})])];
}

/** The role's config, with the built-in defaults for every field the user did not set. */
export function resolveRole(cfg: DispatchConfig | undefined, name: string): RoleConfig {
	return { ...(DEFAULT_ROLES[name] ?? {}), ...(cfg?.roles?.[name] ?? {}) };
}

export interface ResolvedModel {
	model: string;
	/** Empty means: do not pass --thinking */
	thinking: string;
	role: string;
}

/**
 * Pick the model, thinking level and role for a task, highest first:
 * the task's own `model:`/`thinking:` line, the task's role, the plan
 * frontmatter, the config defaults. An empty thinking level means no flag.
 */
export function resolveModel(cfg: DispatchConfig, plan: Plan, task: PlanTask): ResolvedModel {
	const role = task.role || "implement";
	const rc = resolveRole(cfg, role);
	return {
		model: task.model || rc.model || plan.model || cfg.model,
		thinking: task.thinking ?? rc.thinking ?? plan.thinking ?? cfg.thinking ?? "",
		role,
	};
}

// ---------- Parsing ----------

function parseList(v: string): string[] {
	const s = v.trim().replace(/^\[/, "").replace(/\]$/, "");
	return s
		.split(",")
		.map((x) => x.trim().replace(/^["']|["']$/g, ""))
		.filter(Boolean);
}

function stripComment(v: string): string {
	return v.replace(/\s+#.*$/, "").trim();
}

export class PlanParseError extends Error {}

export function safeId(v: string): string {
	return v.replace(/[^\w.-]+/g, "-");
}

export function parsePlan(text: string, fallbackId: string): Plan {
	const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
	if (!fm) throw new PlanParseError("Missing frontmatter (--- ... ---) at top of plan");
	const meta: Record<string, string> = {};
	let planVerify: string | undefined;
	for (const line of fm[1].split(/\r?\n/)) {
		const m = /^([\w-]+)\s*:\s*(.*)$/.exec(line);
		if (!m) continue;
		const key = m[1].toLowerCase();
		// A verify command is a shell line: `#` is not a comment there.
		if (key === "verify") planVerify = m[2].trim() || undefined;
		else meta[key] = stripComment(m[2]);
	}
	const rest = text.slice(fm[0].length);

	const parts = rest.split(/^##\s+task:\s*/im);
	const context = parts[0].trim();
	const tasks: PlanTask[] = [];
	const seen = new Set<string>();

	for (const chunk of parts.slice(1)) {
		const lines = chunk.split(/\r?\n/);
		const id = lines[0].trim().split(/\s+/)[0];
		if (!id) throw new PlanParseError("A '## task:' heading has no id");
		if (seen.has(id)) throw new PlanParseError(`Duplicate task id: ${id}`);
		seen.add(id);

		const task: PlanTask = { id, files: [], dependsOn: [], body: "", state: "pending", attempts: 0, pairRound: 0 };
		let i = 1;
		// Leading "key: value" lines are task metadata; the rest is the body.
		for (; i < lines.length; i++) {
			const m = /^(files|depends_on|model|thinking|verify|role|pair|pair_rounds)\s*:\s*(.*)$/i.exec(lines[i].trim());
			if (!m) {
				if (lines[i].trim() === "") continue;
				break;
			}
			const key = m[1].toLowerCase();
			if (key === "verify") {
				// Raw shell line: `#` is not a comment here.
				task.verify = m[2].trim() || undefined;
				continue;
			}
			const val = stripComment(m[2]);
			if (key === "files") task.files = parseList(val);
			else if (key === "depends_on") task.dependsOn = parseList(val);
			else if (key === "model") task.model = val;
			else if (key === "thinking") task.thinking = val;
			else if (key === "role") task.role = val || undefined;
			else if (key === "pair") task.pair = val || undefined;
			// A non-numeric pair_rounds becomes NaN, which preflight rejects.
			else if (key === "pair_rounds") task.pairRounds = val === "" ? Number.NaN : Number.parseInt(val, 10);
		}
		if (task.pair && task.pairRounds === undefined) task.pairRounds = DEFAULT_PAIR_ROUNDS;
		task.body = lines.slice(i).join("\n").trim();
		if (!task.body) throw new PlanParseError(`Task ${id} has no instructions`);
		tasks.push(task);
	}

	if (tasks.length === 0) throw new PlanParseError("Plan has no '## task: <id>' sections");
	for (const t of tasks)
		for (const dep of t.dependsOn)
			if (!seen.has(dep)) throw new PlanParseError(`Task ${t.id} depends on unknown task ${dep}`);
	detectCycle(tasks);

	const id = safeId(meta["id"] || fallbackId);
	const mp = meta["max_parallel"] ? Number.parseInt(meta["max_parallel"], 10) : undefined;
	return {
		id,
		trace: meta["trace"] ? safeId(meta["trace"]) : id,
		parent: meta["parent"] ? safeId(meta["parent"]) : undefined,
		round: meta["round"] && Number.parseInt(meta["round"], 10) > 0 ? Number.parseInt(meta["round"], 10) : undefined,
		status: (meta["status"] || "").toLowerCase(),
		maxParallel: mp && mp > 0 ? mp : undefined,
		model: meta["model"] || undefined,
		thinking: meta["thinking"] || undefined,
		verify: planVerify,
		context,
		tasks,
	};
}

function detectCycle(tasks: PlanTask[]) {
	const byId = new Map(tasks.map((t) => [t.id, t]));
	const mark = new Map<string, 1 | 2>();
	const visit = (id: string, trail: string[]) => {
		if (mark.get(id) === 2) return;
		if (mark.get(id) === 1) throw new PlanParseError(`Dependency cycle: ${[...trail, id].join(" -> ")}`);
		mark.set(id, 1);
		for (const d of byId.get(id)!.dependsOn) visit(d, [...trail, id]);
		mark.set(id, 2);
	};
	for (const t of tasks) visit(t.id, []);
}

/** Read just the status field without fully parsing (cheap check for pickup). */
export function readStatus(text: string): string {
	const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	if (!fm) return "";
	const m = /^status\s*:\s*(.*)$/im.exec(fm[1]);
	return m ? stripComment(m[1]).toLowerCase() : "";
}

// ---------- Scheduling ----------

function norm(p: string): string {
	return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/** Two file lists overlap if they share a path, or one is a directory prefix of the other. */
export function filesOverlap(a: string[], b: string[]): boolean {
	for (const x of a.map(norm))
		for (const y of b.map(norm)) {
			if (x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)) return true;
		}
	return false;
}

/** True when `target` is `root` or lies below it, both already resolved. */
function insideRepo(root: string, target: string): boolean {
	return target === root || target.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
}

/**
 * Follow symlinks in the deepest part of `target` that exists and append the
 * parts that do not exist yet, then say whether the result is outside `root`.
 * This closes the symlink route out of the repo, e.g. a link to the vault.
 */
function escapesRepo(root: string, target: string): boolean {
	let base = target;
	const rest: string[] = [];
	for (;;) {
		try {
			return !insideRepo(root, path.join(fs.realpathSync(base), ...rest));
		} catch {
			const parent = path.dirname(base);
			if (parent === base) return true;
			rest.unshift(path.basename(base));
			base = parent;
		}
	}
}

/**
 * Reject an unsafe or oversized plan before any worker starts (G4).
 * Returns human-readable problems; an empty list means the plan may run.
 * Executable checks on `verify:` commands live with the caller (`commandExists`).
 * With `cwd`, a `files:` entry that leaves the repo through a symlink is
 * rejected; without it, only the textual checks run.
 */
export function preflightPlan(plan: Plan, cfg: DispatchConfig, cwd?: string): string[] {
	const errors: string[] = [];
	const names = knownRoles(cfg).join(", ");
	// Resolved once, so a symlinked checkout still matches. A cwd that cannot be
	// resolved turns the check off rather than failing the plan.
	let repo: string | undefined;
	if (cwd !== undefined) {
		try {
			repo = fs.realpathSync(cwd);
		} catch {
			repo = undefined;
		}
	}
	for (const task of plan.tasks) {
		const roleName = task.role || "implement";
		if (!knownRoles(cfg).includes(roleName)) {
			errors.push(`Task ${task.id}: unknown role "${roleName}" (known roles: ${names})`);
		} else if (roleName !== "security" && resolveRole(cfg, roleName).readonly) {
			errors.push(
				`Task ${task.id}: role "${roleName}" is read-only; read-only roles other than "security" can only be used as pair: reviewers`,
			);
		}
		if (task.pair) {
			if (!knownRoles(cfg).includes(task.pair)) {
				errors.push(`Task ${task.id}: unknown pair role "${task.pair}" (known roles: ${names})`);
			} else if (resolveRole(cfg, roleName).readonly) {
				errors.push(`Task ${task.id}: role "${roleName}" is read-only, so it cannot be paired with "${task.pair}"`);
			} else if (!resolveRole(cfg, task.pair).readonly) {
				errors.push(`Task ${task.id}: pair role "${task.pair}" is not read-only; a pair reviewer must be a read-only role`);
			}
		}
		if (task.pairRounds !== undefined && !(task.pairRounds >= 1 && task.pairRounds <= 3)) {
			errors.push(`Task ${task.id}: pair_rounds must be 1 to 3, got ${task.pairRounds}`);
		}
		for (const entry of task.files) {
			const raw = entry.trim();
			const rel = raw.replace(/\\/g, "/").replace(/^\.\//, "");
			const segments = rel.split("/");
			// The filesystem here is case-insensitive, so .GIT is the real .git.
			const first = segments[0].toLowerCase();
			if (path.isAbsolute(raw)) {
				errors.push(`Task ${task.id}: files entry "${raw}" is absolute; use a path relative to the repo root`);
			} else if (raw.startsWith("~") || raw.startsWith("@")) {
				errors.push(`Task ${task.id}: files entry "${raw}" uses a ~ or @ prefix, which a worker tool would resolve elsewhere; use a path relative to the repo root`);
			} else if (raw.includes("://")) {
				errors.push(`Task ${task.id}: files entry "${raw}" is a URL; use a path relative to the repo root`);
			} else if (segments.includes("..")) {
				errors.push(`Task ${task.id}: files entry "${raw}" contains ".."; it must stay inside the repo`);
			} else if (first === ".git") {
				errors.push(`Task ${task.id}: files entry "${raw}" is inside .git/, which no worker may touch`);
			} else if (first === ".plans") {
				errors.push(`Task ${task.id}: files entry "${raw}" is inside .plans/, which the planner owns`);
			} else if (repo !== undefined && escapesRepo(repo, path.resolve(cwd!, rel))) {
				errors.push(`Task ${task.id}: files entry "${raw}" leaves the repo through a symlink`);
			}
		}
		if (task.files.length > cfg.maxFilesPerTask) {
			errors.push(`Task ${task.id}: ${task.files.length} files listed (max ${cfg.maxFilesPerTask}); split it into smaller tasks`);
		}
		if (task.body.length > cfg.maxTaskChars) {
			errors.push(`Task ${task.id}: body is ${task.body.length} chars (max ${cfg.maxTaskChars}); split it into smaller tasks`);
		}
	}
	return errors;
}

/**
 * Pick tasks that can start now:
 * - all dependencies done
 * - no file overlap with running tasks (or with each other)
 * - a task with no `files:` runs alone (we can't know what it touches)
 * Also marks tasks whose dependencies failed/skipped as skipped.
 */
export function pickRunnable(plan: Plan, limit: number): PlanTask[] {
	const byId = new Map(plan.tasks.map((t) => [t.id, t]));
	for (const t of plan.tasks) {
		if (t.state !== "pending") continue;
		if (t.dependsOn.some((d) => ["failed", "skipped"].includes(byId.get(d)!.state))) {
			t.state = "skipped";
			t.summary = "Skipped: a dependency failed.";
		}
	}

	const running = plan.tasks.filter((t) => t.state === "running");
	if (running.some((t) => t.files.length === 0)) return [];
	const slots = limit - running.length;
	if (slots <= 0) return [];

	const picked: PlanTask[] = [];
	for (const t of plan.tasks) {
		if (picked.length >= slots) break;
		if (t.state !== "pending") continue;
		if (!t.dependsOn.every((d) => byId.get(d)!.state === "done")) continue;
		const busy = [...running, ...picked];
		if (t.files.length === 0) {
			if (busy.length === 0) {
				picked.push(t);
				break;
			}
			continue;
		}
		if (busy.some((b) => filesOverlap(b.files, t.files))) continue;
		picked.push(t);
	}
	return picked;
}

export function isPlanFinished(plan: Plan): boolean {
	return plan.tasks.every((t) => ["done", "failed", "skipped"].includes(t.state));
}

// ---------- Worker ----------

/** One tool call a worker made, as seen in Pi's JSON event stream. */
export interface ToolRecord {
	name: string;
	/** file path argument, if the tool had one */
	path?: string;
	/** short command or detail, for the trace */
	detail?: string;
	isError?: boolean;
	/** first 300 chars of the tool result text */
	result?: string;
	/** true when the result carried the guard's BLOCKED_MARKER */
	blocked?: boolean;
}

export interface WorkerResult {
	ok: boolean;
	output: string;
	cost: number;
	error?: string;
	model?: string;
	thinking?: string;
	stopReason?: string;
	tokens?: { input: number; output: number; total: number };
	tools?: ToolRecord[];
	/** true when no model was called */
	dry?: boolean;
	/** The worker's saved Pi session, when persistSessions is on */
	session?: WorkerSession;
}

export interface WorkerSession {
	id: string;
	/** absolute directory holding the session file */
	dir: string;
	/** session file, found after the worker exits */
	file?: string;
}

/** Shell command that reopens a worker's session in Pi, run from the repo root. */
export function resumeCommand(cwd: string, s: WorkerSession): string {
	return `pi --session ${s.id} --session-dir ${path.relative(cwd, s.dir) || "."}`;
}

/**
 * Pi requires a session id of `^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$`.
 * safeId can leave a `-` or `.` at either end (and maps `!` to one), so trim
 * anything that is not a letter or digit off both ends. `x` if nothing is left.
 */
function sessionIdPart(v: string): string {
	const trimmed = safeId(v).replace(/^[^A-Za-z0-9]+/, "").replace(/[^A-Za-z0-9]+$/, "");
	return trimmed || "x";
}

/** Short stable hash, so two task ids that sanitise to the same part never collide. */
function shortHash(v: string): string {
	return createHash("sha256").update(v).digest("hex").slice(0, 8);
}

/** One session per task attempt, so a retry never appends to a failed attempt's history. */
export function sessionFor(cwd: string, cfg: DispatchConfig, plan: Plan, task: PlanTask): WorkerSession | undefined {
	if (!cfg.persistSessions || cfg.dryRun) return undefined;
	const planId = sessionIdPart(plan.id);
	const part = sessionIdPart(task.id);
	const taskId = part === task.id ? task.id : `${part}-${shortHash(task.id)}`;
	return { id: `${planId}.${taskId}.a${task.attempts}`, dir: path.join(cwd, ".plans", "sessions", planId) };
}

/**
 * Move old session files for this id out of the way before a worker starts.
 * `pi --session-id` would otherwise reopen the old conversation on a re-run of
 * the same plan, so keep the history under `.prev-<timestamp>` instead.
 */
function retireSession(s: WorkerSession) {
	let names: string[] = [];
	try {
		names = fs.readdirSync(s.dir).filter((n) => n.endsWith(`_${s.id}.jsonl`));
	} catch {
		// First run: the session directory does not exist yet.
		return;
	}
	const stamp = Date.now();
	for (const n of names) fs.renameSync(path.join(s.dir, n), path.join(s.dir, `${n}.prev-${stamp}`));
}

function findSessionFile(s: WorkerSession): string | undefined {
	try {
		return fs.readdirSync(s.dir).find((n) => n.endsWith(`_${s.id}.jsonl`));
	} catch {
		return undefined;
	}
}

/**
 * Pi prints `Warning: No project session found with id '<id>'; creating a new
 * session with that id.` on a first run. It is noise in a failure message, so
 * drop those lines and let the real error (or "no reply") show.
 */
function dropSessionWarning(text: string): string {
	return text
		.split("\n")
		.filter((line) => !line.trim().startsWith("Warning: No project session found"))
		.join("\n");
}

export function buildWorkerPrompt(plan: Plan, task: PlanTask, cfg: DispatchConfig = DEFAULT_CONFIG): string {
	const owned = task.files.length
		? `You own ONLY these paths: ${task.files.join(", ")}.\nDo not edit any other file. Other workers are editing other files at the same time. If you truly need a change elsewhere, don't make it: describe it under NEEDS.`
		: "No file list was given for this task; keep changes minimal and focused.";
	const retry = task.feedback ? retrySection(task.feedback, task.feedbackKind) : "";
	const rolePrompt = resolveRole(cfg, task.role || "implement").prompt;
	const role = rolePrompt ? `## Your role\n${rolePrompt}` : "";
	const grounding = [
		"## Grounding rules",
		"- Read every file before you edit it. Never edit from memory.",
		"- Never invent function names, APIs, file paths or package names. Verify them by reading the code or searching for them.",
		"- If something you need is missing or unclear, stop and put it under NEEDS instead of guessing.",
		"- Only report test results from commands you actually ran, and quote the real output line.",
		"- Do not claim a change you did not make.",
	].join("\n");
	return [
		`You are a worker executing one task from plan "${plan.id}".`,
		plan.context ? `## Plan context\n${plan.context}` : "",
		`## Your task: ${task.id}\n${task.body}`,
		retry,
		role,
		`## Rules\n${owned}\nDo not commit to git. Run the relevant tests or checks before finishing if the task names them.`,
		grounding,
		`## Final message format\nEnd with exactly these sections:\nSTATUS: done | failed\nCHANGED: <files you changed, one per line>\nTESTS: <commands run and result>\nNOTES: <anything the reviewer should know>\nNEEDS: <changes needed outside your files, or "none">`,
	]
		.filter(Boolean)
		.join("\n\n");
}

/**
 * The retry section: a verify failure or review findings. `verify` (or unset,
 * for plans written before the field existed) is a failed check, `review` is a
 * reviewer's finding list that the implementer either fixes or answers.
 */
function retrySection(feedback: string, kind: PlanTask["feedbackKind"]): string {
	if (kind === "review") {
		return `## A reviewer found problems with your change\n${feedback}\nFix the cause of each finding, or explain under NOTES why a finding is wrong. Do not re-run the same thing blindly.`;
	}
	return `## Your previous attempt failed verification\n${feedback}\nFix the cause of the failure. Do not re-run the same thing blindly.`;
}

/** Text of a tool result, whatever shape Pi handed us. */
function toolResultText(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(toolResultText).filter(Boolean).join("\n");
	if (!value || typeof value !== "object") return "";
	const obj = value as Record<string, unknown>;
	if (Array.isArray(obj.content)) return toolResultText(obj.content);
	if (typeof obj.text === "string") return obj.text;
	if (typeof obj.output === "string") return obj.output;
	if (typeof obj.message === "string") return obj.message;
	return "";
}

/** What runWorker and smokeTestModel read from Pi's JSON event stream. */
interface WorkerStreamState {
	finalText: string;
	cost: number;
	stopReason: string;
	errorMessage: string;
	tokens: { input: number; output: number; total: number };
	tools: ToolRecord[];
	/** stdout lines that were not JSON, e.g. "No API key found" */
	plain: string;
}

function createWorkerStream(
	onText?: (text: string) => void,
	onEvent?: (ev: any) => void,
): { state: WorkerStreamState; handle: (line: string) => void } {
	const state: WorkerStreamState = {
		finalText: "",
		cost: 0,
		stopReason: "",
		errorMessage: "",
		tokens: { input: 0, output: 0, total: 0 },
		tools: [],
		plain: "",
	};
	const toolById = new Map<string, ToolRecord>();

	const handle = (line: string) => {
		if (!line.trim()) return;
		let ev: any;
		try {
			ev = JSON.parse(line);
		} catch {
			// Pi prints some errors (e.g. "No API key found") as plain text.
			state.plain += `${line}\n`;
			if (state.plain.length > 20_000) state.plain = state.plain.slice(-20_000);
			return;
		}
		// Every parsed event is reported before it is interpreted, so a caller can
		// watch the stream (the stall watchdog uses it for the tool calls).
		onEvent?.(ev);
		if (ev.type === "tool_execution_start") {
			const a = ev.args || {};
			const rec: ToolRecord = {
				name: String(ev.toolName ?? "unknown"),
				path: a.path ?? a.file_path ?? a.filePath ?? a.file,
				detail: typeof a.command === "string" ? a.command.slice(0, 160) : undefined,
			};
			state.tools.push(rec);
			if (ev.toolCallId) toolById.set(ev.toolCallId, rec);
		} else if (ev.type === "tool_execution_end") {
			const rec = toolById.get(ev.toolCallId);
			if (!rec) return;
			if (ev.isError) rec.isError = true;
			const text = toolResultText(ev.result);
			if (!text) return;
			rec.result = text.slice(0, 300);
			// Only a real error that the guard wrote counts: a normal result (say, a
			// read of guard.ts) can quote the marker without being blocked.
			if (ev.isError === true && text.startsWith(BLOCKED_MARKER)) rec.blocked = true;
		} else if (ev.type === "message_end" && ev.message?.role === "assistant") {
			const msg = ev.message;
			const text = (msg.content || [])
				.filter((p: any) => p.type === "text")
				.map((p: any) => p.text)
				.join("\n")
				.trim();
			if (text) state.finalText = text;
			state.cost += msg.usage?.cost?.total || 0;
			state.tokens.input += msg.usage?.input || 0;
			state.tokens.output += msg.usage?.output || 0;
			state.tokens.total += msg.usage?.totalTokens || 0;
			if (msg.stopReason) state.stopReason = msg.stopReason;
			if (msg.errorMessage) state.errorMessage = msg.errorMessage;
			if (text && onText) onText(text);
		}
	};

	return { state, handle };
}

// ---------- Vault ----------

/** An existing directory, as its realpath, so the guard compares like with like. */
function existingDir(candidate: unknown): string | undefined {
	if (typeof candidate !== "string" || !candidate.trim()) return undefined;
	const resolved = path.resolve(candidate);
	try {
		return fs.statSync(resolved).isDirectory() ? fs.realpathSync(resolved) : undefined;
	} catch {
		return undefined;
	}
}

/** The vault config as an object; missing, unreadable or malformed counts as empty. */
function readVaultConfig(file: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/**
 * The vault folder: $AGENT_VAULT when it names an existing directory, else the
 * `path` of <home>/.config/agent-vault/config.json when that names one. No
 * vault is undefined, never an error.
 */
export function findVaultPath(env: NodeJS.ProcessEnv, home: string): string | undefined {
	const fromEnv = existingDir(env.AGENT_VAULT);
	if (fromEnv) return fromEnv;
	const config = readVaultConfig(path.join(home, ".config", "agent-vault", "config.json"));
	return existingDir(config.path);
}

/**
 * The vault variables of a worker-like child: no AGENT_VAULT (a worker never
 * inherits the parent's), the vault folder in VAULT_ENV, or no variable, and no
 * OPENROUTER_API_KEY.
 */
function withVaultEnv(env: NodeJS.ProcessEnv, parent: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
	delete env.AGENT_VAULT;
	// A worker never gets the decision-model key.
	delete env.OPENROUTER_API_KEY;
	const vault = findVaultPath(parent, home);
	if (vault === undefined) delete env[VAULT_ENV];
	else env[VAULT_ENV] = vault;
	return env;
}

/** Env for a worker process: no second watcher, the vault folder, no decision-model key, plus the guard policy when enabled. */
export function workerEnv(
	cfg: DispatchConfig,
	task: PlanTask,
	parent: NodeJS.ProcessEnv = process.env,
	home: string = os.homedir(),
): NodeJS.ProcessEnv {
	const env = withVaultEnv({ ...parent, PI_PLAN_DISPATCH_WORKER: "1" }, parent, home);
	if (cfg.workerGuards) {
		const readonly = resolveRole(cfg, task.role || "implement").readonly === true;
		env[GUARD_ENV] = JSON.stringify({ files: task.files, bash: true, readonly });
	} else {
		// Never inherit a parent worker's policy: a nested worker gets its own or none.
		delete env[GUARD_ENV];
	}
	return env;
}

export function runWorker(
	cwd: string,
	cfg: DispatchConfig,
	plan: Plan,
	task: PlanTask,
	signal: AbortSignal,
	onLine?: (line: string) => void,
	opts?: {
		prompt?: string;
		/** Reopen the task's session instead of starting a fresh one (resume of spec R2) */
		resume?: boolean;
		/** How often the stall tracker is checked; default min(10s, max(100ms, stallMs / 4)) */
		stallCheckMs?: number;
		/** Called once when the worker is killed as stalled, with the minutes waited */
		onStall?: (minutes: number) => void;
	},
): Promise<WorkerResult> {
	const prompt = opts?.prompt ?? buildWorkerPrompt(plan, task, cfg);

	if (cfg.dryRun) {
		return new Promise((resolve) => {
			const ms = 1500 + Math.floor(Math.random() * 1500);
			const timer = setTimeout(
				() =>
					resolve({
						ok: true,
						cost: 0,
						dry: true,
						output: `STATUS: done\nCHANGED: (dry run, nothing changed)\nTESTS: none\nNOTES: Dry run. Worker would have received:\n\n${prompt}\nNEEDS: none`,
					}),
				ms,
			);
			signal.addEventListener("abort", () => {
				clearTimeout(timer);
				resolve({ ok: false, cost: 0, output: "", error: "aborted" });
			});
		});
	}

	const { model, thinking } = resolveModel(cfg, plan, task);
	const args = ["--mode", "json", "-p"];
	const session = sessionFor(cwd, cfg, plan, task);
	if (session) {
		// A resume continues the conversation: the file stays and the same id is
		// reopened. Without a file there is nothing to reopen, so a fresh session
		// starts and the caller passes the original prompt.
		const reopening = opts?.resume === true && findSessionFile(session) !== undefined;
		if (!reopening) retireSession(session);
		args.push("--session-id", session.id, "--session-dir", session.dir, "--name", `${plan.id}/${task.id}`);
	} else args.push("--no-session");
	args.push("--model", model);
	if (thinking) args.push("--thinking", thinking);
	if (cfg.tools.length) args.push("--tools", cfg.tools.join(","));
	args.push(prompt);

	return new Promise((resolve) => {
		const stallMs = cfg.stallMinutes * 60_000;
		const tracker = new StallTracker({ stallMs });
		const stream = createWorkerStream(
			(text) => onLine?.(text.split("\n")[0].slice(0, 120)),
			(ev) => {
				tracker.touch();
				if (ev.type === "tool_execution_start" && ev.toolCallId) tracker.toolStart(String(ev.toolCallId));
				else if (ev.type === "tool_execution_end" && ev.toolCallId) tracker.toolEnd(String(ev.toolCallId));
			},
		);
		const state = stream.state;
		let stderr = "";
		let buffer = "";
		let settled = false;
		/** The first deliberate kill's reason; it wins over a later aborted turn. */
		let killReason = "";
		let stallTimer: NodeJS.Timeout | undefined;

		const proc = spawn(cfg.piCommand, args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			// Workers must not start their own plan watcher, and (unless disabled)
			// they register the tool_call guard from PI_PLAN_DISPATCH_GUARD.
			env: workerEnv(cfg, task),
		});

		const finish = (r: WorkerResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (stallTimer) clearInterval(stallTimer);
			resolve(r);
		};

		const kill = (why: string) => {
			// A later assistant `message_end` (Pi answering SIGTERM with an aborted
			// turn) overwrites state.errorMessage, so keep the first reason here too.
			if (!killReason) killReason = why;
			state.errorMessage = why;
			proc.kill("SIGTERM");
			setTimeout(() => {
				if (!proc.killed) proc.kill("SIGKILL");
			}, 5000);
		};
		const timeout = setTimeout(() => kill(`timed out after ${cfg.timeoutMinutes} min`), cfg.timeoutMinutes * 60_000);
		signal.addEventListener("abort", () => kill("aborted"), { once: true });
		if (stallMs > 0) {
			const every = opts?.stallCheckMs ?? Math.min(10_000, Math.max(100, stallMs / 4));
			// The child needs a moment to die, so the tick would see the same stall
			// again: report and kill once.
			let stallKilled = false;
			stallTimer = setInterval(() => {
				if (stallKilled || !tracker.stalled()) return;
				stallKilled = true;
				const minutes = cfg.stallMinutes;
				opts?.onStall?.(minutes);
				kill(`stalled: no output for ${minutes} min`);
			}, every);
		}

		const handle = stream.handle;

		proc.stdout.on("data", (d) => {
			buffer += d.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const l of lines) {
				tracker.touch();
				handle(l);
			}
		});
		proc.stderr.on("data", (d) => {
			stderr += d.toString();
			if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
		});
		proc.on("error", (e) =>
			finish({
				ok: false,
				cost: state.cost,
				output: state.finalText,
				model,
				thinking,
				tokens: state.tokens,
				tools: state.tools,
				session,
				error: `could not start '${cfg.piCommand}': ${e.message}`,
			}),
		);
		proc.on("close", (code) => {
			if (buffer.trim()) handle(buffer);
			const selfReportedFail = /^STATUS:\s*failed/im.test(state.finalText);
			const noOutput = !state.finalText;
			const failed =
				code !== 0 || state.stopReason === "error" || state.stopReason === "aborted" || !!state.errorMessage || selfReportedFail || noOutput;
				const why =
				killReason ||
				state.errorMessage ||
				(selfReportedFail ? "worker reported STATUS: failed" : "") ||
				dropSessionWarning(`${stderr}${state.plain}`).trim().slice(-2000) ||
				(noOutput ? "worker produced no reply" : `exit code ${code}`);
			if (session) session.file = findSessionFile(session);
			finish({
				ok: !failed,
				cost: state.cost,
				output: state.finalText,
				error: failed ? why : undefined,
				model,
				thinking,
				stopReason: state.stopReason,
				tokens: state.tokens,
				tools: state.tools,
				session,
			});
		});
	});
}

export interface SmokeResult {
	ok: boolean;
	error?: string;
	cost: number;
	seconds: number;
}

/** How long one smoke-test call may take. */
const SMOKE_TEST_TIMEOUT_MS = 90_000;
const SMOKE_TEST_PROMPT = "Reply with the single word OK";

/**
 * One tiny real call for a (model, thinking) pair, so a wrong model id or an
 * unsupported thinking level shows up before a plan runs. Empty thinking means
 * no --thinking flag. Any assistant reply counts as a pass: the call happened.
 */
export function smokeTestModel(cwd: string, cfg: DispatchConfig, model: string, thinking: string): Promise<SmokeResult> {
	const started = Date.now();
	const args = ["--mode", "json", "-p", "--no-session", "--model", model];
	if (thinking) args.push("--thinking", thinking);
	args.push(SMOKE_TEST_PROMPT);

	return new Promise((done) => {
		const stream = createWorkerStream();
		let stderr = "";
		let buffer = "";
		let settled = false;
		let timedOut = false;
		let timer: NodeJS.Timeout | undefined;
		let escalate: NodeJS.Timeout | undefined;

		const finish = (error?: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearTimeout(escalate);
			const seconds = Math.round((Date.now() - started) / 100) / 10;
			done({ ok: !error, error, cost: stream.state.cost, seconds });
		};

		const proc = spawn(cfg.piCommand, args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			// A smoke test is a worker too: no vault access, whatever the guard says.
			env: withVaultEnv({ ...process.env, PI_PLAN_DISPATCH_WORKER: "1" }, process.env, os.homedir()),
		});

		timer = setTimeout(() => {
			timedOut = true;
			proc.kill("SIGTERM");
			escalate = setTimeout(() => proc.kill("SIGKILL"), 5000);
		}, SMOKE_TEST_TIMEOUT_MS);

		proc.stdout.on("data", (d) => {
			buffer += d.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const l of lines) stream.handle(l);
		});
		proc.stderr.on("data", (d) => {
			stderr += d.toString();
			if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
		});
		proc.on("error", (e) => finish(`could not start '${cfg.piCommand}': ${e.message}`));
		proc.on("close", (code) => {
			if (buffer.trim()) stream.handle(buffer);
			const state = stream.state;
			if (timedOut) return finish(`no reply within ${SMOKE_TEST_TIMEOUT_MS / 1000}s`);
			const noise = `${stderr}${state.plain}`.trim().slice(-500);
			if (state.errorMessage) return finish(state.errorMessage);
			if (state.stopReason === "error" || state.stopReason === "aborted") return finish(`stop reason: ${state.stopReason}`);
			if (code !== 0) return finish(noise || `exit code ${code}`);
			if (!state.finalText) return finish(noise || "the model produced no reply");
			finish();
		});
	});
}

// ---------- Output ----------

export function writeTaskResult(outDir: string, task: PlanTask, r: WorkerResult) {
	fs.mkdirSync(outDir, { recursive: true });
	const secs = task.startedAt && task.endedAt ? Math.round((task.endedAt - task.startedAt) / 1000) : 0;
	const body = [
		`# ${task.id}: ${task.state}`,
		"",
		`- attempts: ${task.attempts}`,
		`- duration: ${secs}s`,
		`- cost: $${(task.cost || 0).toFixed(4)}`,
		task.files.length ? `- files: ${task.files.join(", ")}` : "- files: (none listed)",
		r.session ? `- session: \`${r.session.id}\`${r.session.file ? ` (${r.session.file})` : ""}` : "",
		r.error ? `- error: ${r.error}` : "",
		"",
		"## Worker report",
		"",
		r.output || "(no output)",
		"",
	]
		.filter((l) => l !== "")
		.join("\n");
	fs.writeFileSync(path.join(outDir, `${task.id}.md`), `${body}\n`);
}

export function writeSummary(outDir: string, plan: Plan, extra: string[] = []) {
	const total = plan.tasks.reduce((s, t) => s + (t.cost || 0), 0);
	const counts = (s: TaskState) => plan.tasks.filter((t) => t.state === s).length;
	const lines = [
		`# Plan ${plan.id}: results`,
		"",
		`done ${counts("done")} · failed ${counts("failed")} · skipped ${counts("skipped")} · cost $${total.toFixed(4)}`,
		"",
		...extra,
		"| task | state | attempts | report |",
		"|---|---|---|---|",
		...plan.tasks.map((t) => `| ${t.id} | ${t.state} | ${t.attempts} | [${t.id}.md](./${t.id}.md) |`),
		"",
		"## Short reports",
		"",
		...plan.tasks.map((t) => `### ${t.id} (${t.state})\n\n${(t.summary || "").slice(0, 1500)}\n`),
	];
	fs.writeFileSync(path.join(outDir, "_summary.md"), `${lines.join("\n")}\n`);
}
