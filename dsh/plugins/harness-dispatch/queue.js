/**
 * The plan queue: from session start, watch `.plans/inbox/` for ready `*.md`
 * plans (never `*.md.draft`), run one plan at a time through `running/` to
 * `done/` or `failed/`, with the same events, evidence, summary and gate as
 * pi-plan-dispatch.
 *
 * The worker and verifier are injected, so this module is testable without dsh.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { PlanParseError, parsePlan, readStatus, safeId } from "./plan.js";
import { applyPairDefault, DEFAULT_PAIR_ROUNDS, knownRoles, resolveAgent, resolveModel, resolveRole } from "./roles.js";
import { preflightPlan } from "./preflight.js";
import { isPlanFinished, pickRunnable } from "./schedule.js";
import { buildReviewPrompt, feedbackFromFindings, parseReviewReport } from "./review.js";
import { buildWorkerPrompt } from "./prompt.js";
import { commandExists, createVerifyLock, runVerify as defaultRunVerify, verifyFeedback } from "./verify.js";
import { CONTINUE_PROMPT, OutageGate, probeUrls, runWithResume } from "./resilience.js";
import {
	appendEvent as defaultAppendEvent,
	changedSince,
	detectFaults,
	evaluateGate,
	planSpan,
	readEvents,
	shortHash,
	snapshotDirty,
	taskSpan,
	toolStats,
	trackedFiles,
} from "./trace.js";
import { ensureDirs, getDirs, loadConfig } from "./config.js";
import { writeSummary, writeTaskResult, writeVerifyReport } from "./output.js";

const runCapFinding = (max) => ({ text: `pair loop stopped at maxRunsPerTask (${max} worker runs) with findings still open` });
const firstOutputLine = (r) =>
	r.output
		.split("\n")
		.map((l) => l.trim())
		.find(Boolean);

function verifySummary(scope, command, r, timeoutMinutes) {
	const head = r.timedOut ? `timed out after ${timeoutMinutes} min` : `exit code ${r.code ?? "none"}`;
	const first = firstOutputLine(r);
	return `${scope === "plan" ? "plan verify" : "verify"} failed (${head}): ${command}${first ? `: ${first.slice(0, 200)}` : ""}`;
}

function defaultPairs(plan) {
	const tasks = plan.tasks.filter((t) => t.pairSource === "default");
	return { count: tasks.length, role: tasks[0]?.pair };
}

/** A rejected plan is parked in `.plans/failed/` with an `.error.md` and a `plan.rejected`. */
function rejectPlan(d, file, id, text, body, reason, appendEvent, log) {
	fs.renameSync(file, path.join(d.failed, `${id}.md`));
	fs.writeFileSync(path.join(d.failed, `${id}.error.md`), `# Plan rejected\n\n${body}\n`);
	try {
		appendEvent(d.root, {
			trace: /^trace\s*:\s*([\w.-]+)/m.exec(text)?.[1] ?? id,
			span: planSpan(id),
			actor: "pi-dispatch",
			kind: "plan.rejected",
			plan: id,
			data: { reason },
		});
	} catch {
		// Tracing must never break dispatch.
	}
	log?.(`Plan ${id} rejected: ${reason}`);
}

/**
 * Run one ready plan file to completion.
 * `runtime` supplies the worker, verifier and tracing seams:
 *   runWorker({plan, task, prompt, thinking, signal, onLine}) -> Promise<WorkerResult>
 */
export async function runPlanFile(file, { cwd, runtime, signal: outerSignal, log } = {}) {
	const appendEvent = runtime.appendEvent ?? defaultAppendEvent;
	const runVerify = runtime.runVerify ?? defaultRunVerify;
	const d = runtime.dirs ?? getDirs(cwd);
	const cfg = runtime.cfg ?? loadConfig(d);
	const text = fs.readFileSync(file, "utf8");
	const base = path.basename(file, ".md");

	let plan;
	try {
		plan = parsePlan(text, base);
	} catch (e) {
		const msg = e instanceof PlanParseError ? e.message : String(e);
		rejectPlan(d, file, base, text, msg, msg, appendEvent, log);
		return { plan: null, rejected: msg };
	}

	applyPairDefault(plan, cfg);
	const problems = preflightPlan(plan, cfg, cwd);
	for (const [label, command] of [["plan", plan.verify], ...plan.tasks.map((t) => [`task ${t.id}`, t.verify])]) {
		if (!command) continue;
		if (!commandExists(cwd, command)) problems.push(`${label}: verify command not found: ${command.split(/\s+/)[0]}`);
	}
	if (problems.length) {
		rejectPlan(d, file, base, text, problems.map((p) => `- ${p}`).join("\n"), problems.join("; "), appendEvent, log);
		return { plan: null, rejected: problems.join("; ") };
	}

	if (cfg.requirePlanAudit) {
		const events = readEvents(d.root, plan.trace);
		const audits = events
			.filter((e) => e.kind === "plan.audit" && e.plan === plan.id && (e.round ?? 1) === (plan.round ?? 1))
			.sort((a, b) => (a.data?.audit_round ?? 0) - (b.data?.audit_round ?? 0));
		const latest = audits.at(-1);
		if (!latest || latest.data?.verdict !== "pass") {
			const reason = `plan audit has not passed${latest ? ` (latest verdict: ${latest.data?.verdict ?? "unknown"})` : " (no plan.audit event)"}; run audit_plan first`;
			rejectPlan(d, file, base, text, reason, reason, appendEvent, log);
			return { plan: null, rejected: reason };
		}
	}

	const outDir = path.join(d.done, plan.id);
	const runningFile = path.join(d.running, `${plan.id}.md`);
	fs.renameSync(file, runningFile);
	for (const n of new Set([base, plan.id]))
		for (const suffix of [".md", ".error.md"]) fs.rmSync(path.join(d.failed, `${n}${suffix}`), { force: true });
	runtime.onPlan?.(plan);
	const abort = new AbortController();
	if (outerSignal) {
		if (outerSignal.aborted) abort.abort();
		else outerSignal.addEventListener("abort", () => abort.abort(), { once: true });
	}
	const signal = abort.signal;
	const limit = plan.maxParallel || cfg.maxParallel;

	const emit = (e) => {
		try {
			appendEvent(d.root, { trace: plan.trace, plan: plan.id, round: plan.round ?? 1, ...e });
		} catch {
			// Tracing must never break dispatch.
		}
	};
	const pSpan = planSpan(plan.id);
	const outageGate = new OutageGate({
		pauseMs: cfg.outagePauseMinutes * 60_000,
		probeMs: cfg.probeSeconds * 1000,
		probe: () => (runtime.probe ? runtime.probe(cfg) : probeUrls(cfg.probeUrls)),
		onStart: (reason) => emit({ span: `${pSpan}:outage`, parent: pSpan, actor: "pi-dispatch", kind: "outage.start", data: { reason } }),
		onEnd: (durationMs, outcome) =>
			emit({
				span: `${pSpan}:outage`,
				parent: pSpan,
				actor: "pi-dispatch",
				kind: "outage.end",
				data: { outcome, duration_s: Math.round(durationMs / 1000) },
			}),
	});
	signal.addEventListener("abort", () => outageGate.close(), { once: true });
	const planStart = Date.now();
	const results = new Map();
	const sessions = [];
	const verifyLock = createVerifyLock();
	const verifyOutcomes = new Map();
	const verifyRecords = new Map();
	const pairRecords = new Map();
	const reviewerRuns = new Map();
	const reviewerTools = new Map();
	const reviewerWindows = new Map();
	const readonlyWindows = new Map();
	const openWindows = new Set();
	const activeTasks = new Set();
	const reviewRecords = new Map();
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

	const inflight = new Map();

	const runResumed = async (owner, runTask, prompt, onLine, thinking) => {
		const span = taskSpan(plan.id, owner.id, owner.attempts);
		const onStall = (minutes) => emit({ span: `${span}:stall`, parent: span, actor: "pi-dispatch", kind: "task.stall", task: owner.id, attempt: owner.attempts, data: { minutes } });
		const workerOpts = (info) => {
			if (info === null) return { prompt, onStall, thinking };
			if (info.continueSession) return { prompt: CONTINUE_PROMPT, resume: true, onStall, thinking };
			return { prompt, onStall, thinking };
		};
		return runWithResume({
			run: (info) =>
				runtime.runWorker({
					cwd,
					cfg,
					plan,
					task: runTask,
					owner,
					signal,
					onLine,
					...workerOpts(info),
				}),
			hasSession: (r) => !!r.session?.file,
			gate: outageGate,
			maxResumes: cfg.transientRetries,
			backoff: cfg.backoffSeconds,
			signal,
			onResume: (i) =>
				emit({
					span: `${span}:resume${i.resume}`,
					parent: span,
					actor: "pi-dispatch",
					kind: "task.resume",
					task: owner.id,
					attempt: owner.attempts,
					data: { resume: i.resume, wait_s: i.waitSec, error: i.error.slice(0, 200) },
				}),
		});
	};

	const openWindow = (kind, taskId) => {
		const record = { changed: [], concurrent: [...activeTasks].filter((id) => id !== taskId) };
		const w = { taskId, kind, before: snapshotDirty(cwd), record };
		openWindows.add(w);
		return w;
	};
	const closeWindow = (w) => {
		openWindows.delete(w);
		const after = snapshotDirty(cwd);
		w.record.changed = w.before && after ? changedSince(w.before, after) : [];
		const map = w.kind === "reviewer" ? reviewerWindows : readonlyWindows;
		map.set(w.taskId, [...(map.get(w.taskId) ?? []), w.record]);
	};
	const noteTaskStart = (id) => {
		for (const w of openWindows) if (w.taskId !== id && !w.record.concurrent.includes(id)) w.record.concurrent.push(id);
	};

	const recordVerify = (scope, command, r) => {
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

	const pairRecord = (id) => pairRecords.get(id) ?? { task: id, rounds: 0, verdict: "unknown", unresolved: [], unparsed: false };
	const runsUsed = (t) => t.attempts + (reviewerRuns.get(t.id) ?? 0);
	const runsLeft = (t) => cfg.maxRunsPerTask - runsUsed(t);

	const runPairReview = async (t, round, implementer) => {
		const role = t.pair || "review";
		const reviewTask = { id: `${t.id}.review${round}`, files: t.files, dependsOn: [], role, body: t.body, state: "running", attempts: 1, pairRound: 0 };
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
		const window = openWindow("reviewer", t.id);
		const rr = await runResumed(t, reviewTask, prompt, () => {});
		t.resumes = (t.resumes ?? 0) + rr.resumes;
		closeWindow(window);
		reviewerTools.set(t.id, [...(reviewerTools.get(t.id) ?? []), ...(rr.tools ?? [])]);
		t.cost = (t.cost || 0) + rr.cost;
		if (rr.session) sessions.push({ task: reviewTask.id, attempt: 1, id: rr.session.id, file: rr.session.file, resume: rr.session.resume ?? "" });
		const report = rr.ok ? parseReviewReport(rr.output) : { verdict: "unknown", findings: [] };
		const rec = pairRecord(t.id);
		rec.rounds = round;
		rec.verdict = report.verdict;
		rec.unparsed = report.verdict === "unknown";
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
		return report;
	};

	const pairStep = async (t, implementer) => {
		if (!t.pair || cfg.dryRun) return false;
		const maxRounds = t.pairRounds ?? DEFAULT_PAIR_ROUNDS;
		const round = pairRecord(t.id).rounds + 1;
		const stop = (rec) => {
			rec.unresolved = [...rec.unresolved, runCapFinding(cfg.maxRunsPerTask)];
			pairRecords.set(t.id, rec);
			return false;
		};
		if (runsLeft(t) <= 0) return stop(pairRecord(t.id));
		if (signal.aborted) return false;
		const report = await runPairReview(t, round, implementer);
		if (report.verdict !== "changes") return false;
		if (round >= maxRounds) return false;
		if (runsLeft(t) <= 0) return stop(pairRecord(t.id));
		t.pairRound++;
		t.feedback = feedbackFromFindings(report.findings, t.pair);
		t.feedbackKind = "review";
		t.state = "pending";
		return true;
	};

	const attempt = async (t) => {
		t.state = "running";
		t.attempts++;
		t.startedAt = Date.now();
		const { model, role, thinking } = resolveModel(cfg, plan, t);
		const isSecurity = role === "security";
		const readonlyRun = resolveRole(cfg, role).readonly === true && !cfg.dryRun;
		const promptFile = `${t.id}.prompt.md`;
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
				// `agent` is the runtime that actually runs this task (dsh, pi or
				// omp). It is recorded so an audit can tell which one executed a
				// task without having to map the role back through config.
				agent: resolveAgent(cfg, role),
				pair: t.pair ?? null,
				pair_source: t.pairSource ?? null,
				model,
				thinking,
				files: t.files,
				depends_on: t.dependsOn,
				prompt_sha: shortHash(prompt),
				prompt_file: promptFile,
			},
		});
		const runWindow = readonlyRun ? openWindow("readonly", t.id) : undefined;
		const r = await runResumed(t, t, prompt, () => {}, thinking);
		t.resumes = (t.resumes ?? 0) + r.resumes;
		if (runWindow) closeWindow(runWindow);
		t.endedAt = Date.now();
		t.cost = (t.cost || 0) + r.cost;
		if (r.session) sessions.push({ task: t.id, attempt: t.attempts, id: r.session.id, file: r.session.file, resume: r.session.resume ?? "" });
		const verifyCommand = t.verify;
		if (r.ok && verifyCommand && !cfg.dryRun) {
			const v = await verifyLock(() => runVerify(cwd, verifyCommand, cfg.verifyTimeoutMinutes, signal));
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
		const endEvent = (state, ok) =>
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
		const finish = (state) => {
			activeTasks.delete(t.id);
			t.state = state;
			endEvent(state, state === "done");
			t.summary = state === "done" ? r.output : `${r.error ?? "failed"}\n\n${r.output}`.trim();
			writeTaskResult(outDir, t, r);
		};
		try {
			if (!r.ok) {
				const canRetry = t.attempts - t.pairRound <= cfg.retries && !signal.aborted && runsLeft(t) > 0;
				if (!canRetry) return finish("failed");
				t.state = "pending";
				t.summary = `${r.error ?? "failed"}\n\n${r.output}`.trim();
				endEvent("retry", false);
				return;
			}
			if (!isSecurity && (await pairStep(t, r))) {
				t.state = "pending";
				endEvent("retry", true);
				return;
			}
			finish("done");
		} finally {
			inflight.delete(t.id);
		}
	};

	const start = (t) => {
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
		if (signal.aborted) {
			for (const t of plan.tasks)
				if (t.state === "pending") {
					t.state = "skipped";
					t.summary = "Skipped: plan was stopped.";
				}
		} else if (!outageGate.open) {
			for (const t of pickRunnable(plan, limit)) start(t);
		}
		if (inflight.size === 0) {
			if (isPlanFinished(plan)) break;
			if (outageGate.open) {
				await outageGate.changed();
				continue;
			}
			for (const t of plan.tasks)
				if (t.state === "pending") {
					t.state = "skipped";
					t.summary = "Skipped: could not be scheduled.";
				}
			break;
		}
		await Promise.race([...inflight.values(), ...(outageGate.open ? [outageGate.changed()] : [])]);
	}
	await Promise.all(inflight.values());

	fs.mkdirSync(outDir, { recursive: true });
	for (const t of plan.tasks) if (t.state === "skipped") writeTaskResult(outDir, t, { ok: false, cost: 0, output: t.summary || "" });
	const after = cfg.dryRun ? undefined : snapshotDirty(cwd);
	const changed = before && after ? changedSince(before, after) : undefined;
	if (!cfg.dryRun && plan.verify && plan.tasks.every((t) => t.state === "done")) {
		const command = plan.verify;
		const v = await verifyLock(() => runVerify(cwd, command, cfg.verifyTimeoutMinutes, signal));
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
	const pairStates = new Map(pairEvidence.map((p) => [p.task, { rounds: p.rounds, unresolved: p.unresolved, unparsed: p.unparsed, finalVerdict: p.finalVerdict }]));
	const reviewEvidence = [...reviewRecords].map(([task, r]) => ({ task, role: r.role, verdict: r.report.verdict, findings: r.report.findings }));
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
	const pairedByDefault = defaultPairs(plan);
	writeSummary(outDir, plan, [
		`gate: **${gate.pass ? "PASS" : "FAIL"}** · ${gate.counts.error} error(s) · ${gate.counts.warn} warning(s) · evidence ${gate.evidence} · trace \`${plan.trace}\``,
		...(pairedByDefault.count > 0 ? [`paired by default: ${pairedByDefault.count} task(s) with role "${pairedByDefault.role}"`] : []),
		...(verifyRecords.size ? ["verification:", ...[...verifyRecords.values()].map((v) => `- ${v.scope}: ${v.ok ? "PASS" : "FAIL"} \`${v.command}\``)] : []),
		...(pairEvidence.length ? ["pairs:", ...pairEvidence.map((p) => `- ${p.task}: ${p.rounds} round(s), verdict ${p.verdict}${p.unresolved.length ? `, ${p.unresolved.length} unresolved` : ""}`)] : []),
		...(reviewEvidence.length ? ["reviews:", ...reviewEvidence.map((v) => `- ${v.task} (${v.role}): verdict ${v.verdict}${v.findings.length ? `, ${v.findings.length} finding(s)` : ""}`)] : []),
		...(gate.reasons.length ? [`reasons: ${gate.reasons.join("; ")}`] : []),
		...(faults.length ? ["", "faults:", ...faults.map((f) => `- [${f.severity}] ${f.code}${f.task ? ` (${f.task})` : ""}: ${f.message}`)] : []),
		"",
		...(sessions.length ? ["", "sessions (reopen a worker from the repo root):", ...sessions.map((s) => `- ${s.task} (try ${s.attempt}): \`${s.resume || s.id}\``)] : []),
	]);
	fs.renameSync(runningFile, path.join(outDir, "plan.md"));
	const failed = plan.tasks.filter((t) => t.state !== "done").length;
	const cost = plan.tasks.reduce((s, t) => s + (t.cost || 0), 0);
	const line = `Plan ${plan.id} finished: ${plan.tasks.length - failed}/${plan.tasks.length} done, cost $${cost.toFixed(4)}, gate ${gate.pass ? "PASS" : "FAIL"}. Results: ${path.relative(cwd, outDir)}/_summary.md`;
	log?.(line);
	runtime.onPlan?.(null);
	return { plan, gate, faults, outDir };
}

/** One queue runner: scan, run one plan at a time, expose status. */
export function createQueue({ cwd, runtime, log, pollMs = 500 } = {}) {
	let dirs;
	let timer;
	let running = false;
	let stopped = false;
	let current = null;
	let lastGate = null;
	let lastResult = null;

	const readyFiles = () => {
		let names = [];
		try {
			names = fs.readdirSync(dirs.inbox);
		} catch {
			return [];
		}
		return names
			.filter((n) => n.endsWith(".md") && !n.startsWith("."))
			.map((n) => path.join(dirs.inbox, n))
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
		if (running || stopped || !dirs) return;
		running = true;
		try {
			for (let f = readyFiles()[0]; f; f = readyFiles()[0]) {
				current = path.basename(f);
				lastResult = await runPlanFile(f, { cwd, runtime, log });
				if (lastResult?.gate) lastGate = lastResult.gate;
				current = null;
			}
		} catch (e) {
			log?.(`dispatch queue error: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			running = false;
		}
	};

	const tick = () => {
		if (stopped) return;
		void drain();
	};

	return {
		start() {
			if (process.env.PI_PLAN_DISPATCH_WORKER === "1") return;
			dirs = runtime.dirs ?? getDirs(cwd);
			ensureDirs(dirs);
			const stale = fs.readdirSync(dirs.running).filter((n) => n.endsWith(".md"));
			if (stale.length) log?.(`${stale.length} plan(s) left in .plans/running from an earlier session. Move them back to inbox to rerun.`);
			timer = setInterval(tick, pollMs);
			if (timer.unref) timer.unref();
			tick();
		},
		stop() {
			stopped = true;
			if (timer) clearInterval(timer);
			timer = undefined;
		},
		scan: drain,
		status() {
			return {
				queue: readyFiles().map((f) => path.basename(f, ".md")),
				running: running ? current : null,
				current,
				running_plan: runtime.currentPlan?.() ?? null,
				last_gate: lastGate,
				last_result: lastResult ? { plan: lastResult.plan?.id ?? null, gate: lastResult.gate ?? null, faults: lastResult.faults ?? [] } : null,
			};
		},
	};
}
