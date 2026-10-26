/**
 * pi-plan-dispatch: watches .plans/inbox/ for plan files (written by an
 * orchestrator such as Opus in Claude Code) and fans the tasks out to
 * headless Pi workers (DeepSeek V4.1 Flash on OpenCode Go by default).
 *
 * Commands:
 *   /plans              show status
 *   /plans scan         re-scan the inbox now
 *   /plans dry on|off   toggle dry-run (simulated workers)
 *   /plans stop         abort the running plan
 *   /plans roles        list each role's model, thinking level and readonly flag
 *   /plans roles test   smoke-test every model the roles use
 * Flag:
 *   --plans-dry-run     start in dry-run mode
 *
 * Every plan is traced: events go to .plans/traces/<trace>.jsonl, and each
 * finished plan gets evidence.json (faults + gate) next to its results.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type DispatchConfig,
	type Dirs,
	type Plan,
	type PlanTask,
	type ToolRecord,
	type WorkerResult,
	DEFAULT_PAIR_ROUNDS,
	PlanParseError,
	buildWorkerPrompt,
	ensureDirs,
	getDirs,
	isPlanFinished,
	knownRoles,
	loadConfig,
	parsePlan,
	preflightPlan,
	resolveModel,
	resolveRole,
	resumeCommand,
	sessionFor,
	pickRunnable,
	readStatus,
	runWorker,
	smokeTestModel,
	writeSummary,
	writeTaskResult,
} from "./core.ts";
import {
	type NewEvent,
	type PairState,
	type ReviewEntry,
	type Snapshot,
	type WindowRecord,
	appendEvent,
	changedSince,
	detectFaults,
	evaluateGate,
	planSpan,
	shortHash,
	snapshotDirty,
	taskSpan,
	toolStats,
	trackedFiles,
} from "./trace.ts";
import { type ReviewFinding, type ReviewReport, buildReviewPrompt, feedbackFromFindings, parseReviewReport } from "./review.ts";
import { checkToolCall, policyFromEnv } from "./guard.ts";
import { type VerifyResult, commandExists, createVerifyLock, runVerify, verifyFeedback } from "./verify.ts";
import { CONTINUE_PROMPT, OutageGate, probeUrls, runWithResume } from "./resilience.ts";

const ICON: Record<string, string> = { pending: "·", running: "▶", done: "✓", failed: "✗", skipped: "−" };

/** Pair loop bookkeeping for one task: inputs for the faults and for evidence.json. */
interface PairRecord {
	task: string;
	/** Review rounds that actually ran */
	rounds: number;
	verdict: ReviewReport["verdict"];
	/** Findings still open when the loop stopped */
	unresolved: ReviewFinding[];
	/** The last review produced no readable verdict */
	unparsed: boolean;
}

/**
 * One read-only run in progress. Files that differ between `before` and the snapshot at the
 * close are what the run changed; `concurrent` collects the other tasks running beside it.
 */
interface OpenWindow {
	/** The window's own task: the reviewed task, or the read-only task itself. */
	taskId: string;
	kind: "reviewer" | "readonly";
	before: Snapshot | undefined;
	record: WindowRecord;
}

/** Why a pair loop stopped early: the run cap, kept with the still-open findings. */
const runCapFinding = (max: number): ReviewFinding => ({ text: `pair loop stopped at maxRunsPerTask (${max} worker runs) with findings still open` });

/** A role's effective settings, resolved the way a plan's `role:` line resolves it. */
function roleSummary(cfg: DispatchConfig, name: string): { model: string; thinking: string; readonly: boolean } {
	const rc = resolveRole(cfg, name);
	return { model: rc.model || cfg.model, thinking: rc.thinking ?? cfg.thinking ?? "", readonly: rc.readonly === true };
}

/** One line per role for `/plans roles`: name, model, thinking level, read-only flag. */
function roleLine(cfg: DispatchConfig, name: string): string {
	const s = roleSummary(cfg, name);
	return `${name}: ${s.model}, thinking ${s.thinking || "none"}, ${s.readonly ? "readonly" : "read-write"}`;
}

/** Every distinct (model, thinking) pair the roles use, in role order. */
function modelPairs(cfg: DispatchConfig): { model: string; thinking: string }[] {
	const seen = new Map<string, { model: string; thinking: string }>();
	for (const name of knownRoles(cfg)) {
		const { model, thinking } = roleSummary(cfg, name);
		seen.set(`${model}\u0000${thinking}`, { model, thinking });
	}
	return [...seen.values()];
}

const firstOutputLine = (r: VerifyResult): string | undefined =>
	r.output
		.split("\n")
		.map((l) => l.trim())
		.find(Boolean);

/** One-line gist of a verification outcome, for faults and evidence. */
function verifySummary(scope: string, command: string, r: VerifyResult, timeoutMinutes: number): string {
	const head = r.timedOut ? `timed out after ${timeoutMinutes} min` : `exit code ${r.code ?? "none"}`;
	const first = firstOutputLine(r);
	return `${scope === "plan" ? "plan verify" : "verify"} failed (${head}): ${command}${first ? `: ${first.slice(0, 200)}` : ""}`;
}

/** `<outDir>/<task>.verify.md` or `plan.verify.md`: what ran, how it ended, and the output tail. */
function writeVerifyReport(outDir: string, file: string, command: string, r: VerifyResult, timeoutMinutes: number) {
	const outcome = r.timedOut ? `timed out after ${timeoutMinutes} min` : `exit code: ${r.code ?? "none"}`;
	const body = [
		`# verification: ${r.ok ? "PASS" : "FAIL"}`,
		"",
		`- command: \`${command}\``,
		`- ${outcome}`,
		`- duration: ${(r.durationMs / 1000).toFixed(1)}s`,
		"",
		"## Output (tail)",
		"",
		r.output.trim() || "(no output)",
	];
	fs.mkdirSync(outDir, { recursive: true });
	fs.writeFileSync(path.join(outDir, file), `${body.join("\n")}\n`);
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("plans-dry-run", { description: "Simulate plan workers instead of calling a model", type: "boolean", default: false });

	let watcher: fs.FSWatcher | undefined;
	let debounce: NodeJS.Timeout | undefined;
	let abort: AbortController | undefined;
	let busy = false;
	let dryOverride: boolean | undefined;
	let current: Plan | undefined;
	let ctxRef: ExtensionContext | undefined;
	let dirs: Dirs | undefined;
	// The outage gate of the plan run in progress: closed by the drain loop, so a
	// plan that threw cannot leave a probe loop running.
	let planGate: OutageGate | undefined;
	const lastLine = new Map<string, string>();
	/** Tasks waiting for a resume right now: the widget shows their counter. */
	const resuming = new Map<string, { n: number; max: number }>();

	const isWorker = () => process.env.PI_PLAN_DISPATCH_WORKER === "1";

	const config = (): DispatchConfig => {
		const cfg = loadConfig(dirs!);
		if (pi.getFlag("plans-dry-run") === true) cfg.dryRun = true;
		if (dryOverride !== undefined) cfg.dryRun = dryOverride;
		return cfg;
	};

	const render = () => {
		const ctx = ctxRef;
		if (!ctx?.hasUI) return;
		if (!current) {
			ctx.ui.setStatus("plans", `plans: watching${config().dryRun ? " (dry run)" : ""}`);
			ctx.ui.setWidget("plans", undefined);
			return;
		}
		const done = current.tasks.filter((t) => t.state === "done").length;
		ctx.ui.setStatus("plans", `plans: ${current.id} ${done}/${current.tasks.length}`);
		const paused = planGate?.open === true;
		ctx.ui.setWidget(
			"plans",
			[
				`Plan ${current.id}${config().dryRun ? " (dry run)" : ""}`,
				...(paused ? ["network outage: paused"] : []),
				...current.tasks.map((t) => {
					const extra = t.state === "running" && lastLine.get(t.id) ? `  ${lastLine.get(t.id)}` : "";
					const waiting = resuming.get(t.id);
					const resume = waiting ? ` resume ${waiting.n}/${waiting.max}` : "";
					return `  ${ICON[t.state]} ${t.id}${t.attempts > 1 ? ` (try ${t.attempts})` : ""}${resume}${extra}`;
				}),
			],
			{ placement: "belowEditor" },
		);
	};

	const notify = (msg: string, type: "info" | "warning" | "error" = "info") => {
		if (ctxRef?.hasUI) ctxRef.ui.notify(msg, type);
	};

	/** Inbox files that are ready, oldest first. Ignores temp files and non-ready plans. */
	const readyFiles = (): string[] => {
		const d = dirs!;
		let names: string[] = [];
		try {
			names = fs.readdirSync(d.inbox);
		} catch {
			return [];
		}
		return names
			.filter((n) => n.endsWith(".md") && !n.startsWith("."))
			.map((n) => path.join(d.inbox, n))
			.filter((f) => {
				try {
					return readStatus(fs.readFileSync(f, "utf8")) === "ready";
				} catch {
					return false;
				}
			})
			.sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
	};

	const drain = async () => {
		if (busy || !dirs) return;
		busy = true;
		try {
			for (let f = readyFiles()[0]; f; f = readyFiles()[0]) await runPlanFile(f);
		} finally {
			busy = false;
			// The plan run is over, however it ended: stop probing for the network.
			planGate?.close();
			planGate = undefined;
			current = undefined;
			render();
		}
	};

	/** Park a rejected plan in .plans/failed/ with an error file and a trace event. */
	const rejectPlan = (file: string, id: string, text: string, body: string, reason: string) => {
		const d = dirs!;
		fs.renameSync(file, path.join(d.failed, `${id}.md`));
		fs.writeFileSync(path.join(d.failed, `${id}.error.md`), `# Plan rejected\n\n${body}\n`);
		try {
			appendEvent(d.root, { trace: /^trace\s*:\s*([\w.-]+)/m.exec(text)?.[1] ?? id, span: planSpan(id), actor: "pi-dispatch", kind: "plan.rejected", plan: id, data: { reason } });
		} catch {
			// Tracing must never break dispatch.
		}
		notify(`Plan ${id} rejected: ${reason}`, "error");
	};

	const runPlanFile = async (file: string) => {
		const d = dirs!;
		const cwd = ctxRef!.cwd;
		const base = path.basename(file, ".md");
		const text = fs.readFileSync(file, "utf8");

		let plan: Plan;
		try {
			plan = parsePlan(text, base);
		} catch (e) {
			const msg = e instanceof PlanParseError ? e.message : String(e);
			rejectPlan(file, base, text, msg, msg);
			return;
		}

		// Preflight (G4): refuse an unsafe or oversized plan before any worker starts.
		const cfg = config();
		const problems = preflightPlan(plan, cfg, cwd);
		for (const [label, command] of [["plan", plan.verify], ...plan.tasks.map((t) => [`task ${t.id}`, t.verify])] as [string, string | undefined][]) {
			if (!command) continue;
			if (!commandExists(cwd, command)) problems.push(`${label}: verify command not found: ${command.split(/\s+/)[0]}`);
		}
		if (problems.length) {
			rejectPlan(file, base, text, problems.map((p) => `- ${p}`).join("\n"), problems.join("; "));
			return;
		}

		const outDir = path.join(d.done, plan.id);
		const runningFile = path.join(d.running, `${plan.id}.md`);
		fs.renameSync(file, runningFile);
		// A fixed plan re-dropped under a rejected id must not look rejected.
		for (const n of new Set([base, plan.id]))
			for (const suffix of [".md", ".error.md"]) fs.rmSync(path.join(d.failed, `${n}${suffix}`), { force: true });
		current = plan;
		abort = new AbortController();
		const limit = plan.maxParallel || cfg.maxParallel;
		notify(`Plan ${plan.id}: ${plan.tasks.length} tasks, up to ${limit} in parallel${cfg.dryRun ? " (dry run)" : ""}`);
		render();

		/** Tracing must never break dispatch. */
		const emit = (e: Omit<NewEvent, "trace" | "plan" | "round">) => {
			try {
				appendEvent(d.root, { trace: plan.trace, plan: plan.id, round: plan.round ?? 1, ...e });
			} catch {
				// Tracing must never break dispatch.
			}
		};
		const pSpan = planSpan(plan.id);
		// R3: one outage gate per plan run. The first transient error opens it, a
		// probe closes it, and the scheduler starts no new task while it is open.
		const outageGate = new OutageGate({
			pauseMs: cfg.outagePauseMinutes * 60_000,
			probeMs: cfg.probeSeconds * 1000,
			probe: () => probeUrls(cfg.probeUrls),
			onStart: (reason) => {
				emit({ span: `${pSpan}:outage`, parent: pSpan, actor: "pi-dispatch", kind: "outage.start", data: { reason } });
				render();
			},
			onEnd: (durationMs, outcome) => {
				emit({
					span: `${pSpan}:outage`,
					parent: pSpan,
					actor: "pi-dispatch",
					kind: "outage.end",
					data: { outcome, duration_s: Math.round(durationMs / 1000) },
				});
				render();
			},
		});
		planGate = outageGate;
		// The stop handler cannot reach this plan's gate, so the abort closes it.
		abort.signal.addEventListener("abort", () => outageGate.close(), { once: true });
		const planStart = Date.now();
		const results = new Map<string, WorkerResult>();
		const sessions: { task: string; attempt: number; id: string; file?: string; resume: string }[] = [];
		// G1: one lock per plan, because every task verifies against the same checkout.
		const verifyLock = createVerifyLock();
		const verifyOutcomes = new Map<string, { ok: boolean; summary: string }>();
		const verifyRecords = new Map<string, { scope: string; ok: boolean; command: string }>();
		// Pair mode: per-task review bookkeeping, and the worker runs spent on reviews.
		const pairRecords = new Map<string, PairRecord>();
		const reviewerRuns = new Map<string, number>();
		// What each task's pair reviewers did and changed, all rounds (read-only backstop).
		const reviewerTools = new Map<string, ToolRecord[]>();
		// A read-only run is a window: one per pair reviewer run, one per read-only task attempt.
		// It records the files it changed and the other tasks running beside it, so a change is
		// blamed on the read-only worker unless a task running at the same time owns that file.
		const reviewerWindows = new Map<string, WindowRecord[]>();
		const readonlyWindows = new Map<string, WindowRecord[]>();
		const openWindows = new Set<OpenWindow>();
		// Tasks whose lifecycle has started and not finished.
		const activeTasks = new Set<string>();
		// Read-only reviewer roles (security): parsed report per task it judged.
		const reviewRecords = new Map<string, ReviewEntry>();
		// G3: what git tracked before the plan started; files that already existed.
		const tracked = cfg.dryRun ? undefined : trackedFiles(cwd);
		const before = cfg.dryRun ? undefined : snapshotDirty(cwd);
		emit({
			span: pSpan,
			parent: plan.parent ? planSpan(plan.parent) : undefined,
			actor: "pi-dispatch",
			kind: "plan.received",
			data: {
				sha: shortHash(text),
				dry: cfg.dryRun,
				git: before !== undefined,
				max_parallel: limit,
				tasks: plan.tasks.map((t) => ({ id: t.id, files: t.files, depends_on: t.dependsOn })),
			},
		});

		const inflight = new Map<string, Promise<void>>();

		/**
		 * One worker run inside the transient-failure resume loop of `resilience.ts`:
		 * the backoff, the same-session reopen and the outage gate live there. `owner`
		 * is the task the events and the widget belong to (for a pair reviewer, the
		 * reviewed task), `runTask` is the task handed to the worker.
		 */
		const runResumed = async (
			owner: PlanTask,
			runTask: PlanTask,
			prompt: string,
			onLine: (line: string) => void,
		): Promise<WorkerResult & { resumes: number }> => {
			const span = taskSpan(plan.id, owner.id, owner.attempts);
			const onStall = (minutes: number) =>
				emit({ span: `${span}:stall`, parent: span, actor: "pi-dispatch", kind: "task.stall", task: owner.id, attempt: owner.attempts, data: { minutes } });
			/** The first run gets the original prompt; a resume continues the session when it can. */
			const workerOpts = (info: { continueSession: boolean } | null) => {
				if (info === null) return { prompt, onStall };
				if (info.continueSession) return { prompt: CONTINUE_PROMPT, resume: true, onStall };
				return { prompt, onStall };
			};
			try {
				return await runWithResume<WorkerResult>({
					run: (info) => runWorker(cwd, cfg, plan, runTask, abort!.signal, onLine, workerOpts(info)),
					hasSession: (r) => !!r.session?.file,
					gate: outageGate,
					maxResumes: cfg.transientRetries,
					backoff: cfg.backoffSeconds,
					signal: abort!.signal,
					onResume: (i) => {
						resuming.set(owner.id, { n: i.resume, max: cfg.transientRetries });
						emit({
							span: `${span}:resume${i.resume}`,
							parent: span,
							actor: "pi-dispatch",
							kind: "task.resume",
							task: owner.id,
							attempt: owner.attempts,
							data: { resume: i.resume, wait_s: i.waitSec, error: i.error.slice(0, 200) },
						});
						render();
					},
				});
			} finally {
				resuming.delete(owner.id);
				render();
			}
		};

		/** Open a window before a read-only run: who else is running now, and the files as they are. */
		const openWindow = (kind: OpenWindow["kind"], taskId: string): OpenWindow => {
			const record: WindowRecord = { changed: [], concurrent: [...activeTasks].filter((id) => id !== taskId) };
			const w: OpenWindow = { taskId, kind, before: snapshotDirty(cwd), record };
			openWindows.add(w);
			return w;
		};

		/** Close a window: the diff around the run is what it changed, and the record is kept. */
		const closeWindow = (w: OpenWindow) => {
			openWindows.delete(w);
			const after = snapshotDirty(cwd);
			w.record.changed = w.before && after ? changedSince(w.before, after) : [];
			const map = w.kind === "reviewer" ? reviewerWindows : readonlyWindows;
			map.set(w.taskId, [...(map.get(w.taskId) ?? []), w.record]);
		};

		/** A task starting inside an open window may write its own files: record it as concurrent. */
		const noteTaskStart = (id: string) => {
			for (const w of openWindows) if (w.taskId !== id && !w.record.concurrent.includes(id)) w.record.concurrent.push(id);
		};

		/** Record a verification outcome once, so evidence keeps the last one per scope. */
		const recordVerify = (scope: string, command: string, r: VerifyResult) => {
			verifyOutcomes.set(scope === "plan" ? "*" : scope, { ok: r.ok, summary: verifySummary(scope, command, r, cfg.verifyTimeoutMinutes) });
			verifyRecords.set(scope, { scope, ok: r.ok, command });
			emit({
				span: `${pSpan}:verify:${scope}`,
				parent: pSpan,
				actor: "pi-dispatch",
				kind: "task.verify",
				task: scope === "plan" ? undefined : scope,
				data: {
					...(scope === "plan" ? { scope: "plan" } : {}),
					command,
					ok: r.ok,
					code: r.code,
					timed_out: r.timedOut,
					duration_ms: r.durationMs,
					output: r.output.slice(-2000),
				},
			});
		};

		const pairRecord = (id: string): PairRecord =>
			pairRecords.get(id) ?? { task: id, rounds: 0, verdict: "unknown", unresolved: [], unparsed: false };

		/** Worker runs spent on one task: implementer attempts plus reviewer runs. */
		const runsUsed = (t: PlanTask) => t.attempts + (reviewerRuns.get(t.id) ?? 0);
		const runsLeft = (t: PlanTask) => cfg.maxRunsPerTask - runsUsed(t);

		/** One pair review: a read-only reviewer worker on the task that just passed. */
		const runPairReview = async (t: PlanTask, round: number, implementer: WorkerResult): Promise<ReviewReport> => {
			const role = t.pair || "review";
			const reviewTask: PlanTask = {
				id: `${t.id}.review${round}`,
				files: t.files,
				dependsOn: [],
				role,
				body: t.body,
				state: "running",
				attempts: 1,
				pairRound: 0,
			};
			reviewerRuns.set(t.id, (reviewerRuns.get(t.id) ?? 0) + 1);
			const prompt = buildReviewPrompt({
				kind: "review",
				planId: plan.id,
				context: plan.context,
				taskId: t.id,
				taskBody: t.body,
				files: t.files,
				implementerReport: implementer.output,
				rolePrompt: resolveRole(cfg, role).prompt || "",
				round,
			});
			const promptFile = `${reviewTask.id}.prompt.md`;
			try {
				fs.mkdirSync(outDir, { recursive: true });
				fs.writeFileSync(path.join(outDir, promptFile), `${prompt}\n`);
			} catch {}
			const { model, thinking } = resolveModel(cfg, plan, reviewTask);
			// A reviewer can write through the shell, which the live guard cannot block:
			// the window around its run is the backstop.
			const window = openWindow("reviewer", t.id);
			const rr = await runResumed(t, reviewTask, prompt, (line) => {
				lastLine.set(t.id, `review: ${line}`);
				render();
			});
			t.resumes = (t.resumes ?? 0) + rr.resumes;
			closeWindow(window);
			lastLine.delete(t.id);
			// Every reviewer run's tool calls stay with the task they reviewed.
			reviewerTools.set(t.id, [...(reviewerTools.get(t.id) ?? []), ...(rr.tools ?? [])]);
			// Reviewer spend belongs to the task it reviewed.
			t.cost = (t.cost || 0) + rr.cost;
			if (rr.session) sessions.push({ task: reviewTask.id, attempt: 1, id: rr.session.id, file: rr.session.file, resume: resumeCommand(cwd, rr.session) });
			// A reviewer that crashed reports nothing: unknown, which never fails the task.
			const report: ReviewReport = rr.ok ? parseReviewReport(rr.output) : { verdict: "unknown", findings: [] };
			const rec = pairRecord(t.id);
			rec.rounds = round;
			rec.verdict = report.verdict;
			rec.unparsed = report.verdict === "unknown";
			// Anything short of an approve stays open, so an `issues` verdict or a
			// last-round `changes` still reaches the auditor.
			rec.unresolved = report.verdict === "approve" ? [] : report.findings;
			pairRecords.set(t.id, rec);
			emit({
				span: `${taskSpan(plan.id, t.id, t.attempts)}:review${round}`,
				parent: taskSpan(plan.id, t.id, t.attempts),
				actor: "worker",
				kind: "task.review",
				task: t.id,
				attempt: t.attempts,
				data: {
					round,
					reviewer_role: role,
					model,
					thinking,
					verdict: report.verdict,
					findings: report.findings.length,
					cost: rr.cost,
					tokens: rr.tokens,
					session_id: rr.session?.id,
					prompt_file: promptFile,
					ok: rr.ok,
					error: rr.error,
				},
			});
			render();
			return report;
		};

		/**
		 * Pair mode after a verified attempt: approve or an unreadable report ends the
		 * loop, open findings with rounds and runs left send the implementer back on its
		 * own `pairRound` counter, so a pair round never uses up `retries`. Returns true
		 * when the task is pending another attempt.
		 */
		const pairStep = async (t: PlanTask, implementer: WorkerResult): Promise<boolean> => {
			if (!t.pair || cfg.dryRun) return false;
			const maxRounds = t.pairRounds ?? DEFAULT_PAIR_ROUNDS;
			const round = pairRecord(t.id).rounds + 1;
			const stop = (rec: PairRecord) => {
				rec.unresolved = [...rec.unresolved, runCapFinding(cfg.maxRunsPerTask)];
				pairRecords.set(t.id, rec);
				return false;
			};
			if (runsLeft(t) <= 0) return stop(pairRecord(t.id));
			// Never start a reviewer on a stopped plan.
			if (abort!.signal.aborted) return false;
			const report = await runPairReview(t, round, implementer);
			if (report.verdict !== "changes") return false;
			// The last allowed round leaves its findings open for the auditor.
			if (round >= maxRounds) return false;
			if (runsLeft(t) <= 0) return stop(pairRecord(t.id));
			t.pairRound++;
			t.feedback = feedbackFromFindings(report.findings, t.pair);
			t.feedbackKind = "review";
			t.state = "pending";
			return true;
		};

		/** One worker run for a task: prompt, worker, verification and its pair review. */
		const attempt = async (t: PlanTask) => {
			t.state = "running";
			t.attempts++;
			t.startedAt = Date.now();
			const { model, thinking, role } = resolveModel(cfg, plan, t);
			const isSecurity = role === "security";
			// A read-only task can write through the shell, which the live guard cannot
			// block: the window around its own run is the backstop.
			const readonlyRun = resolveRole(cfg, role).readonly === true && !cfg.dryRun;
			const promptFile = `${t.id}.prompt.md`;
			// A security task reviews instead of implementing, so it gets the review
			// prompt: the implementer's final-report format would contradict it.
			const prompt = isSecurity
				? buildReviewPrompt({
						kind: "security",
						planId: plan.id,
						context: plan.context,
						taskId: t.id,
						taskBody: t.body,
						files: t.files,
						rolePrompt: resolveRole(cfg, role).prompt || "",
					})
				: buildWorkerPrompt(plan, t, cfg);
			try {
				fs.mkdirSync(outDir, { recursive: true });
				fs.writeFileSync(path.join(outDir, promptFile), `${prompt}\n`);
			} catch {}
			emit({
				span: taskSpan(plan.id, t.id, t.attempts),
				parent: pSpan,
				actor: "worker",
				kind: "task.start",
				task: t.id,
				attempt: t.attempts,
				data: {
					role,
					model,
					thinking,
					files: t.files,
					depends_on: t.dependsOn,
					prompt_sha: shortHash(prompt),
					session_id: sessionFor(cwd, cfg, plan, t)?.id,
					prompt_file: promptFile,
				},
			});
			render();
			const runWindow = readonlyRun ? openWindow("readonly", t.id) : undefined;
			const r = await runResumed(t, t, prompt, (line) => {
				lastLine.set(t.id, line);
				render();
			});
			// A resume is not an attempt: it grows this task-wide counter only.
			t.resumes = (t.resumes ?? 0) + r.resumes;
			if (runWindow) closeWindow(runWindow);
			t.endedAt = Date.now();
			t.cost = (t.cost || 0) + r.cost;
			lastLine.delete(t.id);
			// Keep every attempt's tool calls: a failed first try may have edited out of scope.
			if (r.session) sessions.push({ task: t.id, attempt: t.attempts, id: r.session.id, file: r.session.file, resume: resumeCommand(cwd, r.session) });
			// The dispatcher, not the worker, decides whether the attempt worked.
			const verifyCommand = t.verify;
			if (r.ok && verifyCommand && !cfg.dryRun) {
				const v = await verifyLock(() => runVerify(cwd, verifyCommand, cfg.verifyTimeoutMinutes, abort!.signal));
				writeVerifyReport(outDir, `${t.id}.verify.md`, verifyCommand, v, cfg.verifyTimeoutMinutes);
				recordVerify(t.id, verifyCommand, v);
				if (v.ok) {
					t.feedback = undefined;
					t.feedbackKind = undefined;
				} else {
					r.ok = false;
					r.error = `verification failed: ${firstOutputLine(v) ?? (v.timedOut ? "timed out" : `exit code ${v.code ?? "none"}`)}`;
					t.feedback = verifyFeedback(verifyCommand, v);
					t.feedbackKind = "verify";
				}
			}
			// The security report is the task's result: parse it for the faults and evidence.
			if (r.ok && isSecurity) {
				const report = parseReviewReport(r.output);
				reviewRecords.set(t.id, { role, report });
				emit({
					span: `${taskSpan(plan.id, t.id, t.attempts)}:review`,
					parent: taskSpan(plan.id, t.id, t.attempts),
					actor: "worker",
					kind: "task.review",
					task: t.id,
					attempt: t.attempts,
					data: {
						round: 1,
						reviewer_role: role,
						model,
						thinking,
						verdict: report.verdict,
						findings: report.findings.length,
						session_id: r.session?.id,
						prompt_file: promptFile,
						ok: r.ok,
					},
				});
			}
			results.set(t.id, { ...r, tools: [...(results.get(t.id)?.tools ?? []), ...(r.tools ?? [])] });
			const endEvent = (state: string, ok: boolean) =>
				emit({
					span: `${taskSpan(plan.id, t.id, t.attempts)}:end`,
					parent: taskSpan(plan.id, t.id, t.attempts),
					actor: "worker",
					kind: "task.end",
					task: t.id,
					attempt: t.attempts,
					data: {
						state,
						ok,
						duration_s: Math.round(((t.endedAt || 0) - (t.startedAt || 0)) / 1000),
						cost: r.cost,
						tokens: r.tokens,
						model,
						thinking,
						stop_reason: r.stopReason,
						tools: toolStats(r.tools, cwd),
						error: r.error,
						session_file: r.session?.file,
					},
				});
			const finish = (state: "done" | "failed") => {
				activeTasks.delete(t.id);
				t.state = state;
				endEvent(state, state === "done");
				t.summary = state === "done" ? r.output : `${r.error ?? "failed"}\n\n${r.output}`.trim();
				writeTaskResult(outDir, t, r);
			};
			try {
				if (!r.ok) {
					// Retry eligibility counts failed attempts only: a pair re-run grows
					// `attempts` too, but must not eat the task's configured retries.
					const canRetry = t.attempts - t.pairRound <= cfg.retries && !abort!.signal.aborted && runsLeft(t) > 0;
					if (!canRetry) return finish("failed");
					t.state = "pending"; // retry
					t.summary = `${r.error ?? "failed"}\n\n${r.output}`.trim();
					endEvent("retry", false);
					return;
				}
				// A read-only security task already is the review: it has no pair loop.
				if (!isSecurity && (await pairStep(t, r))) {
					t.state = "pending"; // pair re-run: the review asked for changes
					endEvent("retry", true);
					return;
				}
				finish("done");
			} finally {
				inflight.delete(t.id);
				render();
			}
		};

		/** Schedule one task; its whole lifecycle (attempts, verification, pairs) runs in `attempt`. */
		const start = (t: PlanTask) => {
			if (runsLeft(t) <= 0) {
				t.state = "failed";
				t.summary = `Worker run cap (maxRunsPerTask ${cfg.maxRunsPerTask}) reached before this attempt.`;
				writeTaskResult(outDir, t, { ok: false, cost: 0, output: t.summary });
				return;
			}
			activeTasks.add(t.id);
			noteTaskStart(t.id);
			inflight.set(t.id, attempt(t));
		};

		while (!isPlanFinished(plan)) {
			if (abort.signal.aborted) {
				for (const t of plan.tasks) if (t.state === "pending") {
					t.state = "skipped";
					t.summary = "Skipped: plan was stopped.";
				}
			} else if (!outageGate.open) {
				// During an outage no new task starts: the ones in flight resume first.
				for (const t of pickRunnable(plan, limit)) start(t);
			}
			if (inflight.size === 0) {
				if (isPlanFinished(plan)) break;
				if (outageGate.open) {
					// Nothing in flight and the network is down: wait for the probe
					// instead of skipping the tasks that are merely paused.
					await outageGate.changed();
					continue;
				}
				// Nothing running and nothing runnable: remaining tasks are blocked.
				for (const t of plan.tasks) if (t.state === "pending") {
					t.state = "skipped";
					t.summary = "Skipped: could not be scheduled.";
				}
				break;
			}
			// Wake on a task finishing and on the gate flipping, so the runnable tasks
			// start as soon as a probe is healthy.
			await Promise.race([...inflight.values(), ...(outageGate.open ? [outageGate.changed()] : [])]);
		}
		await Promise.all(inflight.values());

		fs.mkdirSync(outDir, { recursive: true });
		for (const t of plan.tasks) if (t.state === "skipped") writeTaskResult(outDir, t, { ok: false, cost: 0, output: t.summary || "" });
		const after = cfg.dryRun ? undefined : snapshotDirty(cwd);
		const changed = before && after ? changedSince(before, after) : undefined;
		// The plan-level check runs after the snapshot, so its own artifacts are not
		// mistaken for changes a worker made.
		if (!cfg.dryRun && plan.verify && plan.tasks.every((t) => t.state === "done")) {
			const command = plan.verify;
			const v = await verifyLock(() => runVerify(cwd, command, cfg.verifyTimeoutMinutes, abort!.signal));
			writeVerifyReport(outDir, "plan.verify.md", command, v, cfg.verifyTimeoutMinutes);
			recordVerify("plan", command, v);
		}
		const pairEvidence = [...pairRecords.values()].map((p) => ({
			task: p.task,
			rounds: p.rounds,
			verdict: p.verdict,
			finalVerdict: p.verdict,
			unresolved: p.unresolved,
			unparsed: p.unparsed,
		}));
		const pairStates = new Map<string, PairState>(
			pairEvidence.map((p) => [p.task, { rounds: p.rounds, unresolved: p.unresolved, unparsed: p.unparsed, finalVerdict: p.finalVerdict }]),
		);
		const reviewEvidence = [...reviewRecords].map(([task, r]) => ({ task, role: r.role, verdict: r.report.verdict, findings: r.report.findings }));
		// Read-only roles change nothing by design: no implementer checks, edits are the fault.
		const readonlyTasks = new Set(plan.tasks.filter((t) => resolveRole(cfg, t.role || "implement").readonly === true).map((t) => t.id));
		const faults = detectFaults({
			cwd,
			plan,
			results,
			changed,
			verify: verifyOutcomes,
			existed: (p) => tracked?.has(p) ?? false,
			readonlyTasks,
			pairs: pairStates,
			reviews: reviewRecords,
			reviewerTools,
			reviewerWindows,
			readonlyWindows,
			dry: cfg.dryRun,
		});
		const gate = evaluateGate(plan, faults, cfg.dryRun, changed !== undefined);
		for (const f of faults)
			emit({ span: `fault:${plan.id}:${f.code}:${f.task ?? "plan"}`, parent: f.task ? taskSpan(plan.id, f.task, plan.tasks.find((t) => t.id === f.task)?.attempts || 1) : pSpan, actor: "pi-dispatch", kind: "fault", task: f.task, data: { ...f } });
		emit({ span: `gate:${plan.id}`, parent: pSpan, actor: "pi-dispatch", kind: "gate", data: { ...gate, changed } });
		const totalCost = plan.tasks.reduce((n, t) => n + (t.cost || 0), 0);
		emit({
			span: `${pSpan}:end`,
			parent: pSpan,
			actor: "pi-dispatch",
			kind: "plan.end",
			data: {
				done: gate.tasks.done,
				failed: gate.tasks.failed,
				skipped: gate.tasks.skipped,
				cost: totalCost,
				duration_s: Math.round((Date.now() - planStart) / 1000),
				gate_pass: gate.pass,
			},
		});
		fs.writeFileSync(
			path.join(outDir, "evidence.json"),
			`${JSON.stringify({ plan: plan.id, trace: plan.trace, round: plan.round ?? 1, parent: plan.parent, changed, faults, gate, verify: [...verifyRecords.values()], pairs: pairEvidence, reviews: reviewEvidence, sessions }, null, 2)}\n`,
		);
		writeSummary(outDir, plan, [
			`gate: **${gate.pass ? "PASS" : "FAIL"}** · ${gate.counts.error} error(s) · ${gate.counts.warn} warning(s) · evidence ${gate.evidence} · trace \`${plan.trace}\``,
			...(verifyRecords.size ? ["verification:", ...[...verifyRecords.values()].map((v) => `- ${v.scope}: ${v.ok ? "PASS" : "FAIL"} \`${v.command}\``)] : []),
			...(pairEvidence.length
				? [
						"pairs:",
						...pairEvidence.map(
							(p) => `- ${p.task}: ${p.rounds} round(s), verdict ${p.verdict}${p.unresolved.length ? `, ${p.unresolved.length} unresolved` : ""}`,
						),
					]
				: []),
			...(reviewEvidence.length
				? [
						"reviews:",
						...reviewEvidence.map((v) => `- ${v.task} (${v.role}): verdict ${v.verdict}${v.findings.length ? `, ${v.findings.length} finding(s)` : ""}`),
					]
				: []),
			...(gate.reasons.length ? [`reasons: ${gate.reasons.join("; ")}`] : []),
			...(faults.length ? ["", "faults:", ...faults.map((f) => `- [${f.severity}] ${f.code}${f.task ? ` (${f.task})` : ""}: ${f.message}`)] : []),
			"",
			...(sessions.length ? ["", "sessions (reopen a worker from the repo root):", ...sessions.map((s) => `- ${s.task} (try ${s.attempt}): \`${s.resume}\``)] : []),
		]);
		fs.renameSync(runningFile, path.join(outDir, "plan.md"));

		const failed = plan.tasks.filter((t) => t.state !== "done").length;
		const cost = plan.tasks.reduce((s, t) => s + (t.cost || 0), 0);
		const line = `Plan ${plan.id} finished: ${plan.tasks.length - failed}/${plan.tasks.length} done, cost $${cost.toFixed(4)}, gate ${gate.pass ? "PASS" : "FAIL"}. Results: ${path.relative(cwd, outDir)}/_summary.md`;
		notify(line, failed || !gate.pass ? "warning" : "info");
		pi.sendMessage({ customType: "plan-dispatch", content: line, display: true });
		abort = undefined;
	};

	const schedule = () => {
		clearTimeout(debounce);
		// Debounce: editors and agents often write in several chunks.
		debounce = setTimeout(() => void drain(), 750);
	};

	// G2: a worker process gets the guard and nothing else. It must never start a
	// second watcher, so the handler is registered here, not in session_start.
	if (isWorker()) {
		const policy = policyFromEnv(process.env, process.cwd());
		if (policy) {
			pi.on("tool_call", async (event) => {
				const d = checkToolCall(policy, event.toolName, event.input);
				return d.block ? { block: true, reason: d.reason } : undefined;
			});
		}
	}

	pi.on("session_start", async (_e, ctx) => {
		if (isWorker()) return;
		ctxRef = ctx;
		dirs = getDirs(ctx.cwd);
		ensureDirs(dirs);
		const stale = fs.readdirSync(dirs.running).filter((n) => n.endsWith(".md"));
		if (stale.length) notify(`${stale.length} plan(s) left in .plans/running from an earlier session. Move them back to inbox to rerun.`, "warning");
		watcher?.close();
		watcher = fs.watch(dirs.inbox, () => schedule());
		render();
		schedule();
	});

	pi.on("session_shutdown", async () => {
		clearTimeout(debounce);
		watcher?.close();
		watcher = undefined;
		abort?.abort();
	});

	/** `/plans roles` lists the roles; `/plans roles test` smoke-tests every model in use. */
	const rolesCommand = async (ctx: ExtensionContext, what: string) => {
		const cfg = config();
		if (what !== "test") {
			for (const name of knownRoles(cfg)) ctx.ui.notify(roleLine(cfg, name), "info");
			return;
		}
		if (busy || abort) {
			ctx.ui.notify("A plan is running; wait for it to finish before testing models", "warning");
			return;
		}
		const pairs = modelPairs(cfg);
		ctx.ui.notify(`Testing ${pairs.length} model(s) with a tiny call`, "info");
		for (const { model, thinking } of pairs) {
			const r = await smokeTestModel(ctx.cwd, cfg, model, thinking);
			const line = [
				`${r.ok ? "PASS" : "FAIL"} ${model}${thinking ? ` (thinking ${thinking})` : ""}`,
				`$${r.cost.toFixed(4)}`,
				`${r.seconds}s`,
				...(r.error ? [r.error] : []),
			].join(", ");
			ctx.ui.notify(line, r.ok ? "info" : "warning");
		}
	};

	pi.registerCommand("plans", {
		description: "Plan dispatcher: status | scan | dry on|off | stop | roles [test]",
		getArgumentCompletions: (p) =>
			["scan", "dry on", "dry off", "stop", "roles", "roles test"].filter((s) => s.startsWith(p)).map((s) => ({ value: s, label: s })),
		handler: async (args, ctx) => {
			if (isWorker()) return;
			const [cmd, arg] = args.trim().split(/\s+/);
			if (cmd === "scan") {
				schedule();
				ctx.ui.notify("Scanning .plans/inbox", "info");
			} else if (cmd === "dry") {
				dryOverride = arg !== "off";
				ctx.ui.notify(`Dry run ${dryOverride ? "on" : "off"} (applies to the next plan)`, "info");
				render();
			} else if (cmd === "stop") {
				if (abort) {
					abort.abort();
					ctx.ui.notify("Stopping current plan", "warning");
				} else ctx.ui.notify("No plan running", "info");
			} else if (cmd === "roles") {
				await rolesCommand(ctx, arg);
			} else {
				const cfg = config();
				const queued = readyFiles().map((f) => path.basename(f));
				ctx.ui.notify(
					[
						current ? `Running: ${current.id}` : "Idle",
						`Queued: ${queued.length ? queued.join(", ") : "none"}`,
						`Worker: ${cfg.model} (thinking ${cfg.thinking}), parallel ${cfg.maxParallel}${cfg.dryRun ? ", DRY RUN" : ""}`,
					].join("\n"),
					"info",
				);
			}
		},
	});
}
