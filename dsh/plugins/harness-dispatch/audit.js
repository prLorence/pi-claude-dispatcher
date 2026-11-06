/**
 * Plan-auditor bridge. The `plan-auditor` agent definition is harness-neutral
 * (see dispatch-plan/agents/plan-auditor.md); this module runs it on whichever
 * harness `auditAgent` names and returns its report. It never logs `plan.audit`
 * here: the auditor logs that event itself, under its own actor name.
 *
 * Backends:
 *   claude  `claude -p --agent plan-auditor --output-format json`  (default)
 *   omp     `omp -p --mode json --tools read,grep,glob,bash`
 *   dsh     `dsh --profile headless --json`
 *
 * Only the claude backend reads the agent file from ~/.claude/agents/. The omp
 * and dsh backends get the same checklist as a prompt, because neither reads a
 * Claude agent definition. All three are read-only by tool grant.
 */
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parsePlan } from "./plan.js";
import { getAdapter } from "./adapters/index.js";

export const AUDIT_COMMAND = "claude";

/** The actor each harness logs its plan.audit event under. */
export const AUDIT_ACTORS = {
	claude: "opus-plan-auditor",
	omp: "omp-plan-auditor",
	dsh: "dsh-plan-auditor",
};

export function auditActor(agent) {
	return AUDIT_ACTORS[agent] || AUDIT_ACTORS.claude;
}

/** Where the harness-neutral agent definition lives. */
export const AUDITOR_AGENT_FILE = path.join(os.homedir(), ".claude", "agents", "plan-auditor.md");

/**
 * The task text handed to every backend. On Claude Code the agent file supplies
 * the checklist, so the prompt only supplies the parameters. On omp and dsh the
 * agent file is not read by the runtime, so the checklist is inlined here.
 */
export function buildAuditPrompt({ planPath, specPath, trace, planId, round, auditRound, root, agent = "claude", model = "", inlineChecklist = false }) {
	const harness = agent === "claude" ? "Claude Code" : agent;
	const lines = [
		`You are the plan-auditor. Audit plan "${planId}" (round ${round}) against its spec before it is flipped to ready.`,
		`Plan file: ${planPath}`,
		`Spec file: ${specPath}`,
		`Trace id: ${trace}`,
		`Plan id: ${planId}`,
		`Plan round: ${round}`,
		`Audit round: ${auditRound}`,
		`Repository root: ${root}`,
		"",
		"## Runtime",
		`Harness: ${harness} (${agent})`,
		`Model: ${model || "the harness default"}`,
		`Log your plan.audit event as actor: ${auditActor(agent)}`,
		"",
	];
	if (inlineChecklist) {
		lines.push(
			"You are running on a harness that does not load Claude agent definitions, so the full checklist follows. It is binding on you.",
			"",
			readAuditorAgentFile() ?? "(The agent definition could not be read; apply the standard plan-audit checklist: traceability, file ownership, contracts, verification, preflight limits, task clarity, security, staleness.)",
			"",
		);
	} else {
		lines.push("Follow the plan-auditor procedure and checklist in your agent definition.");
	}
	lines.push(
		"Work read-only: never edit a file, never run a write command. Run the preflight CLI from the repo root and report every ERROR and WARN.",
		"",
		`Log exactly one plan.audit event yourself, as actor ${auditActor(agent)}, with the plan id, the plan round in --round, this audit round in data.audit_round, and "harness":"${agent}" in the data. Use the trace id above. Do not log any other event and do not edit files.`,
		"",
		"Return the severity-tagged findings and a final verdict in your normal report format. The verdict is pass only with zero blockers and zero majors.",
	);
	return lines.join("\n");
}

/** Read the agent definition, stripping its YAML frontmatter. */
function readAuditorAgentFile() {
	try {
		const raw = fs.readFileSync(AUDITOR_AGENT_FILE, "utf8");
		const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
		return body.trim() || null;
	} catch {
		return null;
	}
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

/**
 * Resolve an API key the way a GUI-launched app cannot: read it from the user's
 * interactive login shell. Apps started from the Dock get launchd's PATH and
 * none of ~/.zshrc, so a key exported there is invisible to the harness child.
 * This asks zsh once, for one named variable, and never logs the value.
 */
export function resolveKeyFromLoginShell(name, { env = process.env, timeoutMs = 5000 } = {}) {
	if (env[name]) return env[name];
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return "";
	const shell = env.SHELL || "/bin/zsh";
	try {
		// A sentinel on its own line survives prompt noise and escape sequences,
		// including the shell's own title and colour codes, which share the line.
		const out = execFileSync(shell, ["-ic", `printf '\\n%s\\n' "$${name}"`], {
			encoding: "utf8",
			timeout: timeoutMs,
			stdio: ["ignore", "pipe", "ignore"],
			env,
		});
		const lines = String(out).split("\n").map((l) => l.trim());
		const value = lines.filter((l) => /^[A-Za-z0-9_\-]{8,}$/.test(l)).at(-1) || "";
		return value;
	} catch {
		return "";
	}
}

/** The env var each backend's provider reads for its key, keyed by model prefix. */
export const PROVIDER_KEY_VARS = {
	mistral: "MISTRAL_API_KEY",
	openrouter: "OPENROUTER_API_KEY",
	anthropic: "ANTHROPIC_API_KEY",
	openai: "OPENAI_API_KEY",
	deepseek: "DEEPSEEK_API_KEY",
	google: "GEMINI_API_KEY",
};

/** Pick the key var for a model like "mistral/codestral-latest". */
export function providerKeyVar(model) {
	const prefix = String(model || "").split("/")[0].toLowerCase();
	return PROVIDER_KEY_VARS[prefix] || "";
}

/** The read-only tool grant every non-Claude backend gets. */
export const AUDIT_READONLY_TOOLS = "read,grep,glob,bash";

/**
 * Args for the omp backend. omp is a Pi fork and speaks the same JSON stream,
 * so `parsePiLine` normalises its output. Read-only by tool grant.
 */
export function ompAuditArgs(prompt, model = "") {
	const args = ["-p", "--mode", "json", "--no-session", "--tools", AUDIT_READONLY_TOOLS];
	if (model) args.push("--model", model);
	args.push(prompt);
	return args;
}

/** Args for the dsh backend. Same JSON stream shape, same read-only grant. */
export function dshAuditArgs(prompt, model = "", profile = "headless") {
	const args = ["--profile", profile, "--json"];
	if (model) args.push("--model", model);
	args.push("--", prompt);
	return args;
}

/** Which argv a backend builds. */
export function auditArgsFor(agent, prompt, { model = "", profile = "headless" } = {}) {
	if (agent === "omp") return ompAuditArgs(prompt, model);
	if (agent === "dsh") return dshAuditArgs(prompt, model, profile);
	return auditArgs(prompt);
}

/**
 * Turn a JSON event stream (omp/pi/dsh) into the same report shape the claude
 * backend returns. The final assistant text is the auditor's report.
 */
export function auditReportFromStream(stdout, parseLine) {
	let text = "";
	let usage = null;
	let errorMessage = "";
	let sawEvent = false;
	for (const line of String(stdout ?? "").split("\n")) {
		if (!line.trim()) continue;
		let events;
		try {
			events = parseLine(line) || [];
		} catch {
			continue;
		}
		for (const ev of events) {
			if (!ev || ev.kind === "plain" || ev.kind === "progress") continue;
			sawEvent = true;
			if (ev.kind === "assistant_end") {
				if (ev.text) text = ev.text;
				if (ev.usage) usage = ev.usage;
				if (ev.errorMessage) errorMessage = ev.errorMessage;
			}
		}
	}
	if (!sawEvent && !text) {
		return { ok: false, text: "", isError: true, verdict: "unknown", detail: "the harness returned no JSON events", usage: null };
	}
	const verdictMatch = /VERDICT\s*:\s*(pass|fail)/i.exec(text);
	return {
		ok: !errorMessage,
		text,
		isError: Boolean(errorMessage),
		verdict: verdictMatch ? verdictMatch[1].toLowerCase() : "unknown",
		stopReason: errorMessage || null,
		numTurns: null,
		durationMs: null,
		costUsd: usage && typeof usage.cost === "number" ? usage.cost : null,
		usage,
		detail: errorMessage || undefined,
	};
}

/**
 * Run the bridge on any backend. No shell; a timeout and cancellation are
 * supported. `agent` picks claude, omp or dsh; `parseLine` is required for the
 * stream backends and is ignored by the claude one.
 */
export function runClaudeAudit({ command = AUDIT_COMMAND, prompt, cwd, env = process.env, timeoutMinutes = 20, signal, agent = "claude", model = "", profile = "headless", parseLine = null }) {
	return new Promise((resolve) => {
		const started = Date.now();
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;
		const args = auditArgsFor(agent, prompt, { model, profile });
		const proc = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], env });
		const finish = (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			const report = agent === "claude"
				? auditReport(parseAuditJson(stdout))
				: auditReportFromStream(stdout, parseLine || (() => []));
			// The tool output validator requires lossless JSON: drop undefined fields.
			const clean = Object.fromEntries(Object.entries(report).filter(([, v]) => v !== undefined));
			if (code !== 0 && clean.ok) {
				clean.ok = false;
				clean.isError = true;
				clean.detail = clean.detail || `the harness exited ${code}`;
			}
			resolve({ ...clean, code, agent, model, stderr: stderr.trim().slice(-4000), timedOut, durationMs: Date.now() - started, envelope: agent === "claude" ? parseAuditJson(stdout) : null });
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
			"Run the read-only plan-auditor agent on a drafted plan and return its findings and verdict. The auditor runs on the harness named by `auditAgent` in .plans/config.json: `claude` (default, headless `claude -p --agent plan-auditor`), `omp` or `dsh`. The auditor logs the plan.audit event itself under its own actor; this tool never logs it.",
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
				timeout_minutes: { type: "number", description: "Auditor timeout in minutes" },
				agent: { type: "string", enum: ["claude", "omp", "dsh"], description: "Harness to run the auditor on; defaults to auditAgent in .plans/config.json" },
				model: { type: "string", description: "Model override for the omp/dsh auditor; defaults to auditModel" },
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
			const agent = args.agent || cfg.auditAgent || "claude";
			const model = args.model ?? cfg.auditModel ?? "";
			if (!["claude", "omp", "dsh"].includes(agent)) {
				throw new Error(`audit_plan: unknown audit agent "${agent}" (known: claude, omp, dsh)`);
			}
			const adapter = agent === "claude" ? null : getAdapter(agent);
			const command = agent === "claude"
				? cfg.claudeCommand || "claude"
				: adapter.command(cfg);
			// A GUI-launched app has none of ~/.zshrc, so the provider key a model
			// needs may be missing from this process env. Resolve it once from the
			// login shell and hand it to the child only.
			const childEnv = { ...process.env };
			const keyVar = providerKeyVar(model);
			if (keyVar && !childEnv[keyVar]) {
				const value = resolveKeyFromLoginShell(keyVar, { env: childEnv });
				if (value) childEnv[keyVar] = value;
			}
			const result = await runClaudeAudit({
				command,
				agent,
				model,
				env: childEnv,
				parseLine: adapter ? adapter.parseLine : null,
				prompt: buildAuditPrompt({
					planPath: planFile,
					specPath: specFile,
					trace,
					planId,
					round,
					auditRound,
					root: repo,
					agent,
					model,
					inlineChecklist: agent !== "claude",
				}),
				cwd: repo,
				timeoutMinutes: args.timeout_minutes ?? cfg.auditTimeoutMinutes ?? 20,
				signal: exec.signal,
			});
			return { ...result, plan: planId, trace, round, auditRound, auditActor: auditActor(agent), loggedByAuditor: true };
		},
	};
}
