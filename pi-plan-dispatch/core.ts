/**
 * pi-plan-dispatch core: plan parsing, scheduling, and worker execution.
 * No Pi imports here, so it can be tested on its own.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

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
};

export type TaskState = "pending" | "running" | "done" | "failed" | "skipped";

export interface PlanTask {
	id: string;
	files: string[];
	dependsOn: string[];
	model?: string;
	thinking?: string;
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

export function loadConfig(d: Dirs): DispatchConfig {
	const file = path.join(d.root, "config.json");
	try {
		const raw = JSON.parse(fs.readFileSync(file, "utf8"));
		return { ...DEFAULT_CONFIG, ...raw };
	} catch {
		return { ...DEFAULT_CONFIG };
	}
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

export function parsePlan(text: string, fallbackId: string): Plan {
	const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
	if (!fm) throw new PlanParseError("Missing frontmatter (--- ... ---) at top of plan");
	const meta: Record<string, string> = {};
	for (const line of fm[1].split(/\r?\n/)) {
		const m = /^([\w-]+)\s*:\s*(.*)$/.exec(line);
		if (m) meta[m[1].toLowerCase()] = stripComment(m[2]);
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

		const task: PlanTask = { id, files: [], dependsOn: [], body: "", state: "pending", attempts: 0 };
		let i = 1;
		// Leading "key: value" lines are task metadata; the rest is the body.
		for (; i < lines.length; i++) {
			const m = /^(files|depends_on|model|thinking)\s*:\s*(.*)$/i.exec(lines[i].trim());
			if (!m) {
				if (lines[i].trim() === "") continue;
				break;
			}
			const key = m[1].toLowerCase();
			const val = stripComment(m[2]);
			if (key === "files") task.files = parseList(val);
			else if (key === "depends_on") task.dependsOn = parseList(val);
			else if (key === "model") task.model = val;
			else if (key === "thinking") task.thinking = val;
		}
		task.body = lines.slice(i).join("\n").trim();
		if (!task.body) throw new PlanParseError(`Task ${id} has no instructions`);
		tasks.push(task);
	}

	if (tasks.length === 0) throw new PlanParseError("Plan has no '## task: <id>' sections");
	for (const t of tasks)
		for (const dep of t.dependsOn)
			if (!seen.has(dep)) throw new PlanParseError(`Task ${t.id} depends on unknown task ${dep}`);
	detectCycle(tasks);

	const mp = meta["max_parallel"] ? Number.parseInt(meta["max_parallel"], 10) : undefined;
	return {
		id: (meta["id"] || fallbackId).replace(/[^\w.-]+/g, "-"),
		status: (meta["status"] || "").toLowerCase(),
		maxParallel: mp && mp > 0 ? mp : undefined,
		model: meta["model"] || undefined,
		thinking: meta["thinking"] || undefined,
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

export interface WorkerResult {
	ok: boolean;
	output: string;
	cost: number;
	error?: string;
}

export function buildWorkerPrompt(plan: Plan, task: PlanTask): string {
	const owned = task.files.length
		? `You own ONLY these paths: ${task.files.join(", ")}.\nDo not edit any other file. Other workers are editing other files at the same time. If you truly need a change elsewhere, don't make it: describe it under NEEDS.`
		: "No file list was given for this task; keep changes minimal and focused.";
	return [
		`You are a worker executing one task from plan "${plan.id}".`,
		plan.context ? `## Plan context\n${plan.context}` : "",
		`## Your task: ${task.id}\n${task.body}`,
		`## Rules\n${owned}\nDo not commit to git. Run the relevant tests or checks before finishing if the task names them.`,
		`## Final message format\nEnd with exactly these sections:\nSTATUS: done | failed\nCHANGED: <files you changed, one per line>\nTESTS: <commands run and result>\nNOTES: <anything the reviewer should know>\nNEEDS: <changes needed outside your files, or "none">`,
	]
		.filter(Boolean)
		.join("\n\n");
}

export function runWorker(
	cwd: string,
	cfg: DispatchConfig,
	plan: Plan,
	task: PlanTask,
	signal: AbortSignal,
	onLine?: (line: string) => void,
): Promise<WorkerResult> {
	const prompt = buildWorkerPrompt(plan, task);

	if (cfg.dryRun) {
		return new Promise((resolve) => {
			const ms = 1500 + Math.floor(Math.random() * 1500);
			const timer = setTimeout(
				() =>
					resolve({
						ok: true,
						cost: 0,
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

	const model = task.model || plan.model || cfg.model;
	const thinking = task.thinking || plan.thinking || cfg.thinking;
	const args = ["--mode", "json", "-p", "--no-session", "--model", model];
	if (thinking) args.push("--thinking", thinking);
	if (cfg.tools.length) args.push("--tools", cfg.tools.join(","));
	args.push(prompt);

	return new Promise((resolve) => {
		let finalText = "";
		let cost = 0;
		let stopReason = "";
		let errorMessage = "";
		let stderr = "";
		let buffer = "";
		let settled = false;

		const proc = spawn(cfg.piCommand, args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			// Workers must not start their own plan watcher.
			env: { ...process.env, PI_PLAN_DISPATCH_WORKER: "1" },
		});

		const finish = (r: WorkerResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			resolve(r);
		};

		const kill = (why: string) => {
			errorMessage = why;
			proc.kill("SIGTERM");
			setTimeout(() => {
				if (!proc.killed) proc.kill("SIGKILL");
			}, 5000);
		};
		const timeout = setTimeout(() => kill(`timed out after ${cfg.timeoutMinutes} min`), cfg.timeoutMinutes * 60_000);
		signal.addEventListener("abort", () => kill("aborted"), { once: true });

		const handle = (line: string) => {
			if (!line.trim()) return;
			let ev: any;
			try {
				ev = JSON.parse(line);
			} catch {
				// Pi prints some errors (e.g. "No API key found") as plain text.
				stderr += `${line}\n`;
				return;
			}
			if (ev.type === "message_end" && ev.message?.role === "assistant") {
				const msg = ev.message;
				const text = (msg.content || [])
					.filter((p: any) => p.type === "text")
					.map((p: any) => p.text)
					.join("\n")
					.trim();
				if (text) finalText = text;
				cost += msg.usage?.cost?.total || 0;
				if (msg.stopReason) stopReason = msg.stopReason;
				if (msg.errorMessage) errorMessage = msg.errorMessage;
				if (text && onLine) onLine(text.split("\n")[0].slice(0, 120));
			}
		};

		proc.stdout.on("data", (d) => {
			buffer += d.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const l of lines) handle(l);
		});
		proc.stderr.on("data", (d) => {
			stderr += d.toString();
			if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
		});
		proc.on("error", (e) => finish({ ok: false, cost, output: finalText, error: `could not start '${cfg.piCommand}': ${e.message}` }));
		proc.on("close", (code) => {
			if (buffer.trim()) handle(buffer);
			const selfReportedFail = /^STATUS:\s*failed/im.test(finalText);
			const noOutput = !finalText;
			const failed =
				code !== 0 || stopReason === "error" || stopReason === "aborted" || !!errorMessage || selfReportedFail || noOutput;
			const why =
				errorMessage ||
				(selfReportedFail ? "worker reported STATUS: failed" : "") ||
				stderr.trim().slice(-2000) ||
				(noOutput ? "worker produced no reply" : `exit code ${code}`);
			finish({ ok: !failed, cost, output: finalText, error: failed ? why : undefined });
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

export function writeSummary(outDir: string, plan: Plan) {
	const total = plan.tasks.reduce((s, t) => s + (t.cost || 0), 0);
	const counts = (s: TaskState) => plan.tasks.filter((t) => t.state === s).length;
	const lines = [
		`# Plan ${plan.id}: results`,
		"",
		`done ${counts("done")} · failed ${counts("failed")} · skipped ${counts("skipped")} · cost $${total.toFixed(4)}`,
		"",
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
