/**
 * Plan-auditor bridge: run the unchanged Claude Code `plan-auditor` agent
 * through headless `claude -p`, return its JSON report, and never log
 * `plan.audit` here — the auditor logs that event itself.
 *
 * The agent file stays at ~/.claude/agents/plan-auditor.md; this module only
 * supplies the task text and reads the JSON envelope.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { parsePlan } from "./plan.js";

export const AUDIT_COMMAND = "claude";

export function buildAuditPrompt({ planPath, specPath, trace, planId, round, auditRound, root }) {
	return [
		`You are the plan-auditor. Audit plan "${planId}" (round ${round}) against its spec before it is flipped to ready.`,
		`Plan file: ${planPath}`,
		`Spec file: ${specPath}`,
		`Trace id: ${trace}`,
		`Plan id: ${planId}`,
		`Plan round: ${round}`,
		`Audit round: ${auditRound}`,
		`Repository root: ${root}`,
		"",
		"Follow the plan-auditor procedure and checklist in your agent definition. Work read-only. Run the preflight CLI from the repo root and report every ERROR and WARN.",
		"",
		"Log exactly one plan.audit event yourself, as actor opus-plan-auditor, with the plan id, the plan round in --round, and this audit round in data.audit_round. Use the trace id above. Do not log any other event and do not edit files.",
		"",
		"Return the severity-tagged findings and a final verdict in your normal report format. The verdict is pass only with zero blockers and zero majors.",
	].join("\n");
}

/** Parse the JSON envelope `claude --output-format json` prints. */
export function parseAuditJson(stdout) {
	const text = String(stdout ?? "").trim();
	if (text === "") return null;
	const tryParse = (value) => {
		try {
			const parsed = JSON.parse(value);
			return parsed && typeof parsed === "object" ? parsed : null;
		} catch {
			return null;
		}
	};
	const whole = tryParse(text);
	if (whole) return whole;
	for (const line of text.split("\n").reverse()) {
		const parsed = tryParse(line.trim());
		if (parsed) return parsed;
	}
	return null;
}

/** The human-readable result and the fields the orchestrator needs. */
export function auditReport(envelope) {
	if (!envelope || typeof envelope !== "object") {
		return { ok: false, text: "", isError: true, verdict: "unknown", detail: "claude returned no JSON envelope" };
	}
	const text = typeof envelope.result === "string" ? envelope.result : "";
	const isError = envelope.is_error === true;
	const verdictMatch = /VERDICT\s*:\s*(pass|fail)/i.exec(text);
	return {
		ok: !isError,
		text,
		isError,
		verdict: verdictMatch ? verdictMatch[1].toLowerCase() : "unknown",
		stopReason: envelope.stop_reason ?? null,
		numTurns: typeof envelope.num_turns === "number" ? envelope.num_turns : null,
		durationMs: typeof envelope.duration_ms === "number" ? envelope.duration_ms : null,
		costUsd: typeof envelope.total_cost_usd === "number" ? envelope.total_cost_usd : null,
		usage: envelope.usage ?? null,
	};
}

export function auditArgs(prompt) {
	return ["--print", "--agent", "plan-auditor", "--output-format", "json", "--no-session-persistence", "--allowedTools=Read,Grep,Glob,Bash", prompt];
}

/** Run the bridge. No shell; a timeout and cancellation are supported. */
export function runClaudeAudit({ command = AUDIT_COMMAND, prompt, cwd, env = process.env, timeoutMinutes = 20, signal }) {
	return new Promise((resolve) => {
		const started = Date.now();
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;
		const args = auditArgs(prompt);
		const proc = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], env });
		const finish = (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			const envelope = parseAuditJson(stdout);
			const report = auditReport(envelope);
			resolve({ ...report, code, stderr: stderr.trim().slice(-4000), timedOut, durationMs: Date.now() - started, envelope });
		};
		const timer = timeoutMinutes > 0 ? setTimeout(() => { timedOut = true; proc.kill("SIGTERM"); setTimeout(() => proc.kill("SIGKILL"), 3000).unref?.(); }, timeoutMinutes * 60_000) : undefined;
		if (timer?.unref) timer.unref();
		const onAbort = () => {
			proc.kill("SIGTERM");
			setTimeout(() => proc.kill("SIGKILL"), 3000).unref?.();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
		proc.stdout.on("data", (d) => { stdout += d.toString(); if (stdout.length > 2_000_000) stdout = stdout.slice(-1_000_000); });
		proc.stderr.on("data", (d) => { stderr += d.toString(); if (stderr.length > 200_000) stderr = stderr.slice(-100_000); });
		proc.on("error", (e) => { stderr += e.message; finish(null); });
		proc.on("close", (code) => finish(code));
	});
}


function inside(root, target) {
	const rel = path.relative(root, target);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** The model-facing `audit_plan` tool. It never logs `plan.audit` itself. */
export function createAuditTool({ ctx, root, rootFor, cfgOf }) {
	return {
		name: "audit_plan",
		description:
			"Run the read-only Claude Code plan-auditor agent on a drafted plan through headless `claude -p --agent plan-auditor`, and return its findings and verdict. The auditor logs the plan.audit event itself; this tool never logs it.",
		parameters: {
			type: "object",
			properties: {
				plan: { type: "string", description: "Plan file path, absolute or relative to the repo root" },
				spec: { type: "string", description: "Spec file path; defaults to .plans/specs/<trace>.md" },
				trace: { type: "string", description: "Trace id; defaults to the plan frontmatter" },
				plan_id: { type: "string", description: "Plan id; defaults to the plan frontmatter" },
				round: { type: "number", description: "Plan round; defaults to the plan frontmatter" },
				audit_round: { type: "number", description: "Audit round number, default 1" },
				root: { type: "string", description: "Repo root; defaults to the session root" },
				timeout_minutes: { type: "number", description: "Claude Code timeout in minutes" },
			},
			required: ["plan"],
			additionalProperties: false,
		},
		output: {
			schema: { type: "object", additionalProperties: true },
			render: (_args, value) => [
				{
					type: "text",
					text: value.text || value.detail || (value.isError ? `audit failed: ${value.stderr || "no report"}` : "(no audit report)"),
				},
			],
		},
		isConcurrencySafe: () => false,
		async execute(args, exec) {
			const repo = path.resolve(args.root || rootFor?.(exec?.agent) || root);
			const planFile = path.resolve(repo, args.plan);
			if (!inside(repo, planFile)) throw new Error("audit_plan: the plan path leaves the repo");
			let text;
			try {
				text = fs.readFileSync(planFile, "utf8");
			} catch {
				throw new Error(`audit_plan: cannot read ${planFile}`);
			}
			let parsed;
			try {
				parsed = parsePlan(text, path.basename(planFile, ".md"));
			} catch (e) {
				throw new Error(`audit_plan: cannot parse the plan: ${e instanceof Error ? e.message : String(e)}`);
			}
			const trace = args.trace || parsed.trace;
			const planId = args.plan_id || parsed.id;
			const round = Number.isFinite(args.round) ? args.round : parsed.round ?? 1;
			const auditRound = Number.isFinite(args.audit_round) ? args.audit_round : 1;
			const specFile = path.resolve(repo, args.spec || path.join(".plans", "specs", `${trace}.md`));
			if (!inside(repo, specFile)) throw new Error("audit_plan: the spec path leaves the repo");
			if (!fs.existsSync(specFile)) throw new Error(`audit_plan: spec not found: ${specFile}`);
			const cfg = cfgOf(repo);
			const result = await runClaudeAudit({
				command: cfg.claudeCommand || "claude",
				prompt: buildAuditPrompt({ planPath: planFile, specPath: specFile, trace, planId, round, auditRound, root: repo }),
				cwd: repo,
				timeoutMinutes: args.timeout_minutes ?? cfg.auditTimeoutMinutes ?? 20,
				signal: exec.signal,
			});
			return { ...result, plan: planId, trace, round, auditRound, loggedByAuditor: true };
		},
	};
}
