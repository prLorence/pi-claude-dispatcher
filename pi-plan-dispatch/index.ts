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
 * Flag:
 *   --plans-dry-run     start in dry-run mode
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type DispatchConfig,
	type Dirs,
	type Plan,
	type PlanTask,
	PlanParseError,
	ensureDirs,
	getDirs,
	isPlanFinished,
	loadConfig,
	parsePlan,
	pickRunnable,
	readStatus,
	runWorker,
	writeSummary,
	writeTaskResult,
} from "./core.ts";

const ICON: Record<string, string> = { pending: "·", running: "▶", done: "✓", failed: "✗", skipped: "−" };

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
	const lastLine = new Map<string, string>();

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
		ctx.ui.setWidget(
			"plans",
			[
				`Plan ${current.id}${config().dryRun ? " (dry run)" : ""}`,
				...current.tasks.map((t) => {
					const extra = t.state === "running" && lastLine.get(t.id) ? `  ${lastLine.get(t.id)}` : "";
					return `  ${ICON[t.state]} ${t.id}${t.attempts > 1 ? ` (try ${t.attempts})` : ""}${extra}`;
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
			current = undefined;
			render();
		}
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
			fs.renameSync(file, path.join(d.failed, `${base}.md`));
			fs.writeFileSync(path.join(d.failed, `${base}.error.md`), `# Plan rejected\n\n${msg}\n`);
			notify(`Plan ${base} rejected: ${msg}`, "error");
			return;
		}

		const outDir = path.join(d.done, plan.id);
		const runningFile = path.join(d.running, `${plan.id}.md`);
		fs.renameSync(file, runningFile);
		current = plan;
		abort = new AbortController();
		const cfg = config();
		const limit = plan.maxParallel || cfg.maxParallel;
		notify(`Plan ${plan.id}: ${plan.tasks.length} tasks, up to ${limit} in parallel${cfg.dryRun ? " (dry run)" : ""}`);
		render();

		const inflight = new Map<string, Promise<void>>();
		const start = (t: PlanTask) => {
			t.state = "running";
			t.attempts++;
			t.startedAt = Date.now();
			render();
			const p = runWorker(cwd, cfg, plan, t, abort!.signal, (line) => {
				lastLine.set(t.id, line);
				render();
			}).then((r) => {
				t.endedAt = Date.now();
				t.cost = (t.cost || 0) + r.cost;
				lastLine.delete(t.id);
				if (r.ok) {
					t.state = "done";
				} else if (t.attempts <= cfg.retries && !abort!.signal.aborted) {
					t.state = "pending"; // retry
				} else {
					t.state = "failed";
				}
				t.summary = r.ok ? r.output : `${r.error ?? "failed"}\n\n${r.output}`.trim();
				if (t.state !== "pending") writeTaskResult(outDir, t, r);
				inflight.delete(t.id);
				render();
			});
			inflight.set(t.id, p);
		};

		while (!isPlanFinished(plan)) {
			if (abort.signal.aborted) {
				for (const t of plan.tasks) if (t.state === "pending") {
					t.state = "skipped";
					t.summary = "Skipped: plan was stopped.";
				}
			} else {
				for (const t of pickRunnable(plan, limit)) start(t);
			}
			if (inflight.size === 0) {
				if (isPlanFinished(plan)) break;
				// Nothing running and nothing runnable: remaining tasks are blocked.
				for (const t of plan.tasks) if (t.state === "pending") {
					t.state = "skipped";
					t.summary = "Skipped: could not be scheduled.";
				}
				break;
			}
			await Promise.race(inflight.values());
		}
		await Promise.all(inflight.values());

		fs.mkdirSync(outDir, { recursive: true });
		for (const t of plan.tasks) if (t.state === "skipped") writeTaskResult(outDir, t, { ok: false, cost: 0, output: t.summary || "" });
		writeSummary(outDir, plan);
		fs.renameSync(runningFile, path.join(outDir, "plan.md"));

		const failed = plan.tasks.filter((t) => t.state !== "done").length;
		const cost = plan.tasks.reduce((s, t) => s + (t.cost || 0), 0);
		const line = `Plan ${plan.id} finished: ${plan.tasks.length - failed}/${plan.tasks.length} done, cost $${cost.toFixed(4)}. Results: ${path.relative(cwd, outDir)}/_summary.md`;
		notify(line, failed ? "warning" : "info");
		pi.sendMessage({ customType: "plan-dispatch", content: line, display: true });
		abort = undefined;
	};

	const schedule = () => {
		clearTimeout(debounce);
		// Debounce: editors and agents often write in several chunks.
		debounce = setTimeout(() => void drain(), 750);
	};

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

	pi.registerCommand("plans", {
		description: "Plan dispatcher: status | scan | dry on|off | stop",
		getArgumentCompletions: (p) =>
			["scan", "dry on", "dry off", "stop"].filter((s) => s.startsWith(p)).map((s) => ({ value: s, label: s })),
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
