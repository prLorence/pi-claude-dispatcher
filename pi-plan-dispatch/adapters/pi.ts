/**
 * The Pi coding agent behind the worker-adapter contract.
 *
 * Everything here is the behaviour the dispatcher had before the adapter
 * existed, moved without rewriting: the argument vectors, the session id and
 * file rules, the resume command and the JSON-event normalisation. Nothing in
 * this module imports `core.ts` or Pi, so it loads on its own.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { safeId } from "./ids.ts";
import type { AgentAdapter, AgentEvent, AgentSessionRef, SessionRequest, WorkerRunSpec } from "./types.ts";

/** The prompt of a no-session connectivity smoke test. */
const SMOKE_TEST_PROMPT = "Reply with the single word OK";

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

/** One session per task attempt, so a retry never appends to a failed attempt's history. */
function sessionFor(req: SessionRequest): AgentSessionRef {
	const planId = sessionIdPart(req.planId);
	const part = sessionIdPart(req.taskId);
	const taskId = part === req.taskId ? req.taskId : `${part}-${shortHash(req.taskId)}`;
	return { id: `${planId}.${taskId}.a${req.attempt}`, dir: path.join(req.cwd, ".plans", "sessions", planId) };
}

/**
 * Move old session files for this id out of the way before a worker starts.
 * `pi --session-id` would otherwise reopen the old conversation on a re-run of
 * the same plan, so keep the history under `.prev-<timestamp>` instead.
 */
function retireSession(s: AgentSessionRef): void {
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

function findSessionFile(s: AgentSessionRef): string | undefined {
	try {
		return fs.readdirSync(s.dir).find((n) => n.endsWith(`_${s.id}.jsonl`));
	} catch {
		return undefined;
	}
}

function resumeCommand(cwd: string, s: AgentSessionRef): string {
	return `pi --session ${s.id} --session-dir ${path.relative(cwd, s.dir) || "."}`;
}

/** The assistant text of a `message_end`, its text parts joined and trimmed. */
function assistantText(msg: { content?: Array<{ type?: string; text?: string }> }): string {
	return (msg.content || [])
		.filter((p) => p.type === "text")
		.map((p) => p.text)
		.join("\n")
		.trim();
}

function parseLine(line: string): AgentEvent[] {
	if (!line.trim()) return [];
	let ev: any;
	try {
		ev = JSON.parse(line);
	} catch {
		return [{ kind: "plain", text: line }];
	}
	if (ev.type === "tool_execution_start") {
		return [
			{
				kind: "tool_start",
				id: ev.toolCallId ? String(ev.toolCallId) : "",
				name: String(ev.toolName ?? "unknown"),
				args: ev.args || {},
			},
		];
	}
	if (ev.type === "tool_execution_end") {
		return [
			{
				kind: "tool_end",
				id: ev.toolCallId ? String(ev.toolCallId) : "",
				name: String(ev.toolName ?? "unknown"),
				isError: ev.isError === true,
				text: toolResultText(ev.result),
			},
		];
	}
	if (ev.type === "message_end" && ev.message?.role === "assistant") {
		const msg = ev.message;
		const usage = msg.usage || {};
		return [
			{
				kind: "assistant_end",
				text: assistantText(msg),
				usage: {
					input: usage.input || 0,
					output: usage.output || 0,
					total: usage.totalTokens || 0,
					cost: usage.cost?.total || 0,
				},
				stopReason: msg.stopReason ? String(msg.stopReason) : "",
				errorMessage: msg.errorMessage ? String(msg.errorMessage) : "",
			},
		];
	}
	return [{ kind: "progress" }];
}

function workerArgs(spec: WorkerRunSpec): string[] {
	const args = ["--mode", "json", "-p"];
	if (spec.session) args.push("--session-id", spec.session.id, "--session-dir", spec.session.dir, "--name", spec.name);
	else args.push("--no-session");
	args.push("--model", spec.model);
	if (spec.thinking) args.push("--thinking", spec.thinking);
	if (spec.tools.length) args.push("--tools", spec.tools.join(","));
	args.push(spec.prompt);
	return args;
}

function smokeArgs(spec: { model: string; thinking: string }): string[] {
	const args = ["--mode", "json", "-p", "--no-session", "--model", spec.model];
	if (spec.thinking) args.push("--thinking", spec.thinking);
	args.push(SMOKE_TEST_PROMPT);
	return args;
}

export const piAdapter: AgentAdapter = {
	name: "pi",
	command: (cfg) => cfg.piCommand,
	workerArgs,
	smokeArgs,
	parseLine,
	sessionFor,
	findSessionFile,
	retireSession,
	resumeCommand,
};
