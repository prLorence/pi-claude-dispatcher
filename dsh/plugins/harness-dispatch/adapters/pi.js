/** The Pi adapter, ported from pi-plan-dispatch/adapters/pi.ts. */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const SMOKE_TEST_PROMPT = "Reply with the single word OK";

function safeId(v) {
	return String(v).replace(/[^\w.-]+/g, "-");
}

function sessionIdPart(v) {
	const trimmed = safeId(v).replace(/^[^A-Za-z0-9]+/, "").replace(/[^A-Za-z0-9]+$/, "");
	return trimmed || "x";
}

function shortHash(v) {
	return createHash("sha256").update(v).digest("hex").slice(0, 8);
}

function toolResultText(value) {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(toolResultText).filter(Boolean).join("\n");
	if (!value || typeof value !== "object") return "";
	const obj = value;
	if (Array.isArray(obj.content)) return toolResultText(obj.content);
	if (typeof obj.text === "string") return obj.text;
	if (typeof obj.output === "string") return obj.output;
	if (typeof obj.message === "string") return obj.message;
	return "";
}

function sessionFor(req) {
	const planId = sessionIdPart(req.planId);
	const part = sessionIdPart(req.taskId);
	const taskId = part === req.taskId ? req.taskId : `${part}-${shortHash(req.taskId)}`;
	return { id: `${planId}.${taskId}.a${req.attempt}`, dir: path.join(req.cwd, ".plans", "sessions", planId) };
}

function retireSession(s) {
	let names = [];
	try {
		names = fs.readdirSync(s.dir).filter((n) => n.endsWith(`_${s.id}.jsonl`));
	} catch {
		return;
	}
	const stamp = Date.now();
	for (const n of names) fs.renameSync(path.join(s.dir, n), path.join(s.dir, `${n}.prev-${stamp}`));
}

function findSessionFile(s) {
	try {
		return fs.readdirSync(s.dir).find((n) => n.endsWith(`_${s.id}.jsonl`));
	} catch {
		return undefined;
	}
}

function resumeCommand(cwd, s) {
	return `pi --session ${s.id} --session-dir ${path.relative(cwd, s.dir) || "."}`;
}

function assistantText(msg) {
	return (msg.content || [])
		.filter((p) => p.type === "text")
		.map((p) => p.text)
		.join("\n")
		.trim();
}

function parseLine(line) {
	if (!line.trim()) return [];
	let ev;
	try {
		ev = JSON.parse(line);
	} catch {
		return [{ kind: "plain", text: line }];
	}
	if (ev.type === "tool_execution_start") {
		return [{ kind: "tool_start", id: ev.toolCallId ? String(ev.toolCallId) : "", name: String(ev.toolName ?? "unknown"), args: ev.args || {} }];
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

function workerArgs(spec) {
	const args = ["--mode", "json", "-p"];
	if (spec.session) args.push("--session-id", spec.session.id, "--session-dir", spec.session.dir, "--name", spec.name);
	else args.push("--no-session");
	args.push("--model", spec.model);
	if (spec.thinking) args.push("--thinking", spec.thinking);
	if (spec.tools.length) args.push("--tools", spec.tools.join(","));
	args.push(spec.prompt);
	return args;
}

function smokeArgs(spec) {
	const args = ["--mode", "json", "-p", "--no-session", "--model", spec.model];
	if (spec.thinking) args.push("--thinking", spec.thinking);
	args.push(SMOKE_TEST_PROMPT);
	return args;
}

export const piAdapter = {
	name: "pi",
	command: (cfg) => cfg.piCommand || "pi",
	workerArgs,
	smokeArgs,
	parseLine,
	sessionFor,
	findSessionFile,
	retireSession,
	resumeCommand,
};

export { SMOKE_TEST_PROMPT };
