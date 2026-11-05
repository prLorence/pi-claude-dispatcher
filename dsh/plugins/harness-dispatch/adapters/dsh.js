/**
 * The dsh adapter: map dsh's newline-delimited `--json` events and its durable
 * session events into the AgentEvent shape the dispatcher already understands.
 *
 * dsh CLI events (measured 0.2.1-rc.5):
 *   {type:"tool_call", callId, tool, input}
 *   {type:"tool_result", callId, status, result}
 *   {type:"text", text}
 *   {type:"status", phase:"step_end", usage:{inputTokens,outputTokens,totalTokens}}
 *   {type:"status", phase:"turn_end", reason:{kind,error?}}
 *   {type:"final", text}
 *
 * In-process subagents do not expose that stream; they expose Session events:
 *   tool/call (callId,name,arguments), tool/result (message), assistant/message
 *   (message, usage), turn/end (reason). The same normalisation applies.
 */
import { createHash } from "node:crypto";
import * as path from "node:path";

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

function textParts(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const part of content) {
		if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") parts.push(part.text);
	}
	return parts.join("\n");
}

/** CLI event -> AgentEvent[]. */
export function parseDshLine(line) {
	if (!line.trim()) return [];
	let ev;
	try {
		ev = JSON.parse(line);
	} catch {
		return [{ kind: "plain", text: line }];
	}
	if (ev.type === "tool_call") {
		return [{ kind: "tool_start", id: String(ev.callId ?? ""), name: String(ev.tool ?? "unknown"), args: ev.input && typeof ev.input === "object" ? ev.input : {} }];
	}
	if (ev.type === "tool_result") {
		return [
			{
				kind: "tool_end",
				id: String(ev.callId ?? ""),
				// tool_result carries no name; the stream fills it from tool_call.
				name: "",
				isError: ev.status !== "completed",
				text: typeof ev.result === "string" ? ev.result : textParts(ev.result),
			},
		];
	}
	if (ev.type === "final") return [{ kind: "assistant_end", text: String(ev.text ?? ""), usage: { input: 0, output: 0, total: 0, cost: 0 }, stopReason: "", errorMessage: "" }];
	if (ev.type === "text") return [{ kind: "progress" }];
	return [{ kind: "progress" }];
}

/**
 * Stateful decoder for one dsh run. Feed CLI lines or session events; it keeps
 * the callId -> tool name map and sums usage.
 */
export function createDshStream() {
	const nameById = new Map();
	const usage = { input: 0, output: 0, total: 0, cost: 0 };
	let stopReason = "";
	let errorMessage = "";
	let finalText = "";

	const one = (ev) => {
		if (ev.type === "tool_call") {
			nameById.set(String(ev.callId ?? ""), String(ev.tool ?? "unknown"));
			return [{ kind: "tool_start", id: String(ev.callId ?? ""), name: String(ev.tool ?? "unknown"), args: ev.input && typeof ev.input === "object" ? ev.input : {} }];
		}
		if (ev.type === "tool_result") {
			const id = String(ev.callId ?? "");
			return [
				{
					kind: "tool_end",
					id,
					name: nameById.get(id) ?? "unknown",
					isError: ev.status !== "completed",
					text: typeof ev.result === "string" ? ev.result : textParts(ev.result),
				},
			];
		}
		if (ev.type === "assistant/message") {
			const text = textParts(ev.message?.content);
			if (text) finalText = text;
			if (ev.usage && typeof ev.usage === "object") {
				usage.input += Number(ev.usage.inputTokens ?? ev.usage.input ?? 0) || 0;
				usage.output += Number(ev.usage.outputTokens ?? ev.usage.output ?? 0) || 0;
				usage.total += Number(ev.usage.totalTokens ?? ev.usage.total ?? 0) || 0;
			}
			return [{ kind: "assistant_end", text, usage: { ...usage }, stopReason, errorMessage }];
		}
		if (ev.type === "tool/call") {
			nameById.set(String(ev.callId ?? ""), String(ev.name ?? "unknown"));
			return [{ kind: "tool_start", id: String(ev.callId ?? ""), name: String(ev.name ?? "unknown"), args: ev.arguments && typeof ev.arguments === "object" ? ev.arguments : {} }];
		}
		if (ev.type === "tool/result") {
			const msg = ev.message ?? {};
			const id = String(msg.callId ?? msg.toolCallId ?? "");
			return [
				{
					kind: "tool_end",
					id,
					name: nameById.get(id) ?? String(msg.toolName ?? "unknown"),
					isError: msg.isError === true,
					text: textParts(msg.content),
				},
			];
		}
		if (ev.type === "step_end" || (ev.type === "status" && ev.phase === "step_end")) {
			const u = ev.usage ?? {};
			usage.input += Number(u.inputTokens ?? u.input ?? 0) || 0;
			usage.output += Number(u.outputTokens ?? u.output ?? 0) || 0;
			usage.total += Number(u.totalTokens ?? u.total ?? 0) || 0;
			return [{ kind: "progress" }];
		}
		if (ev.type === "turn/end" || (ev.type === "status" && ev.phase === "turn_end")) {
			const reason = ev.reason ?? {};
			stopReason = String(reason.kind ?? stopReason);
			if (reason.error?.message) errorMessage = String(reason.error.message);
			return [{ kind: "progress" }];
		}
		if (ev.type === "final") {
			if (typeof ev.text === "string" && ev.text) finalText = ev.text;
			return [{ kind: "assistant_end", text: finalText, usage: { ...usage }, stopReason, errorMessage }];
		}
		return [{ kind: "progress" }];
	};

	return {
		one,
		handle(line) {
			if (!line.trim()) return [];
			let ev;
			try {
				ev = JSON.parse(line);
			} catch {
				return [{ kind: "plain", text: line }];
			}
			return one(ev);
		},
		final() {
			return { text: finalText, usage: { ...usage }, stopReason, errorMessage };
		},
	};
}

/** The dsh in-process session maps an attempt to the returned child session id. */
export function sessionFor(req) {
	const planId = sessionIdPart(req.planId);
	const part = sessionIdPart(req.taskId);
	const taskId = part === req.taskId ? req.taskId : `${part}-${shortHash(req.taskId)}`;
	return { id: `${planId}.${taskId}.a${req.attempt}`, dir: path.join(req.cwd, ".plans", "sessions", planId) };
}

export const dshAdapter = {
	name: "dsh",
	command: (cfg) => cfg.dshCommand || "dsh",
	parseLine: parseDshLine,
	sessionFor,
	// In-process subagents have no JSON session file in the Pi sense.
	findSessionFile: () => undefined,
	retireSession: () => {},
	resumeCommand: () => "",
	workerArgs(spec) {
		const args = ["--profile", "headless", "--json"];
		if (spec.session) args.push("--session-id", spec.session.id);
		args.push("--", spec.prompt);
		return args;
	},
	smokeArgs() {
		return ["--profile", "headless", "--json", "--", "Reply with the single word OK"];
	},
};
