/** Session transcript and summary parsing, ported from monitor/src/server/sessions.ts. */
import * as fs from "node:fs";
import { basename } from "node:path";
import { resolveInside } from "./http.js";

export const TOOL_RESULT_CAP = 2000;
export const TOOL_ARGS_CAP = 8000;
const TRUNCATION_NOTE = "… [truncated]";
const PATH_KEYS = ["path", "file_path", "filePath", "file"];

function completeLines(text) {
	const parts = text.split("\n");
	const count = parts.length - 1;
	const lines = [];
	for (let i = 0; i < count; i += 1) lines.push({ line: i + 1, raw: parts[i] });
	return lines;
}

function parseObject(raw) {
	if (raw.trim() === "") return null;
	try {
		const value = JSON.parse(raw);
		if (value !== null && typeof value === "object" && !Array.isArray(value)) return value;
	} catch {
		// A malformed line is skipped; the monitor never crashes on bad data.
	}
	return null;
}

function textParts(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const part of content) {
		if (part === null || typeof part !== "object") continue;
		if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
	}
	return parts.join("");
}

function cap(text, limit) {
	if (text.length <= limit) return { text, truncated: false };
	return { text: text.slice(0, limit) + TRUNCATION_NOTE, truncated: true };
}

const timestampOf = (obj) => (typeof obj.timestamp === "string" ? obj.timestamp : null);

function entry(line, ts, kind, text) {
	return { line, ts, kind, text, collapsed: false, truncated: false, tool: null, isError: false };
}

function messageEntries(obj, line, ts) {
	const message = obj.message;
	if (message === null || typeof message !== "object") return [];
	const msg = message;
	const role = msg.role;
	if (role === "system") return [entry(line, ts, "note", "System prompt hidden")];
	if (role === "user") {
		const result = entry(line, ts, "user", textParts(msg.content));
		result.collapsed = true;
		return [result];
	}
	if (role === "assistant") {
		if (!Array.isArray(msg.content)) return [];
		const entries = [];
		for (const part of msg.content) {
			if (part === null || typeof part !== "object") continue;
			if (part.type === "text" && typeof part.text === "string") entries.push(entry(line, ts, "assistant", part.text));
			else if (part.type === "thinking" && typeof part.thinking === "string") {
				const thinking = entry(line, ts, "thinking", part.thinking);
				thinking.collapsed = true;
				entries.push(thinking);
			} else if (part.type === "toolCall") {
				const name = typeof part.name === "string" ? part.name : "unknown";
				const args = part.arguments === undefined ? "" : JSON.stringify(part.arguments);
				const toolCall = entry(line, ts, "tool_call", `${name} ${args ?? ""}`);
				toolCall.tool = { name, args: args ?? "" };
				const capped = cap(toolCall.text, TOOL_ARGS_CAP);
				toolCall.text = capped.text;
				toolCall.truncated = capped.truncated;
				entries.push(toolCall);
			}
		}
		return entries;
	}
	if (role === "toolResult") {
		const toolName = typeof msg.toolName === "string" ? msg.toolName : "";
		const result = entry(line, ts, "tool_result", textParts(msg.content));
		const capped = cap(result.text, TOOL_RESULT_CAP);
		result.text = capped.text;
		result.truncated = capped.truncated;
		result.tool = { name: toolName, args: "" };
		result.isError = msg.isError === true;
		return [result];
	}
	return [];
}

function lineEntries(obj, line) {
	const ts = timestampOf(obj);
	const type = obj.type;
	if (type === "session" || type === "session_info") return [];
	if (type === "model_change") return [entry(line, ts, "note", `model: ${typeof obj.modelId === "string" ? obj.modelId : ""}`)];
	if (type === "thinking_level_change") return [entry(line, ts, "note", `thinking: ${typeof obj.thinkingLevel === "string" ? obj.thinkingLevel : ""}`)];
	if (type === "message") return messageEntries(obj, line, ts);
	return [];
}

export function parseSessionLines(text, after) {
	const entries = [];
	let next = after;
	for (const { line, raw } of completeLines(text)) {
		if (line <= after) continue;
		next = line;
		const obj = parseObject(raw);
		if (obj === null) continue;
		entries.push(...lineEntries(obj, line));
	}
	return { entries, next };
}

function emptySummary() {
	return {
		exists: false,
		ended: false,
		stopReason: null,
		startedAt: null,
		lastTs: null,
		mtimeMs: 0,
		lastTool: null,
		tokens: null,
		cost: null,
		lastText: null,
		model: null,
		thinking: null,
		error: null,
	};
}

function firstPath(args) {
	for (const key of PATH_KEYS) {
		const value = args[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return null;
}

function formatTool(name, args) {
	if (args === null || typeof args !== "object") return name;
	if (name === "read" || name === "edit" || name === "write") {
		const target = firstPath(args);
		if (target !== null) return `${name} ${basename(target)}`;
		return name;
	}
	if (name === "bash") {
		const command = typeof args.command === "string" ? args.command : "";
		if (command === "") return name;
		return `bash ${command.slice(0, 60)}`;
	}
	return name;
}

function usageNumbers(message) {
	const usage = message.usage;
	if (usage === null || typeof usage !== "object") return { tokens: null, cost: null };
	const input = typeof usage.input === "number" ? usage.input : 0;
	const output = typeof usage.output === "number" ? usage.output : 0;
	let cost = null;
	if (usage.cost !== null && typeof usage.cost === "object" && typeof usage.cost.total === "number") cost = usage.cost.total;
	return { tokens: input + output, cost };
}

export function summarizeSession(file) {
	const summary = emptySummary();
	if (file === null) return summary;
	let mtimeMs;
	try {
		mtimeMs = fs.statSync(file).mtimeMs;
	} catch {
		return summary;
	}
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return { ...summary, exists: true, error: "unreadable session" };
	}
	summary.exists = true;
	summary.mtimeMs = mtimeMs;
	let lastAssistant = null;
	let lastMessageRole = null;
	let tokens = null;
	let cost = null;
	for (const { raw } of completeLines(text)) {
		const obj = parseObject(raw);
		if (obj === null) continue;
		const ts = timestampOf(obj);
		if (ts !== null) {
			if (summary.startedAt === null) summary.startedAt = ts;
			summary.lastTs = ts;
		}
		if (obj.type === "model_change" && typeof obj.modelId === "string") {
			summary.model = obj.modelId;
			continue;
		}
		if (obj.type === "thinking_level_change" && typeof obj.thinkingLevel === "string") {
			summary.thinking = obj.thinkingLevel;
			continue;
		}
		if (obj.type !== "message") continue;
		const message = obj.message;
		if (message === null || typeof message !== "object") continue;
		const role = typeof message.role === "string" ? message.role : null;
		lastMessageRole = role;
		if (role !== "assistant") continue;
		lastAssistant = message;
		const usage = usageNumbers(message);
		if (usage.tokens !== null) tokens = (tokens ?? 0) + usage.tokens;
		if (usage.cost !== null) cost = (cost ?? 0) + usage.cost;
		if (Array.isArray(message.content)) {
			for (const part of message.content) {
				if (part && typeof part === "object" && part.type === "toolCall" && typeof part.name === "string") summary.lastTool = formatTool(part.name, part.arguments);
			}
			const textOfMessage = textParts(message.content);
			if (textOfMessage !== "") summary.lastText = textOfMessage;
		}
	}
	const stopReason = lastAssistant === null ? null : lastAssistant.stopReason;
	summary.stopReason = typeof stopReason === "string" ? stopReason : null;
	summary.ended = lastMessageRole === "assistant" && typeof stopReason === "string" && stopReason !== "" && stopReason !== "toolUse";
	summary.tokens = tokens;
	summary.cost = cost;
	if (summary.stopReason === "error" && lastAssistant !== null && typeof lastAssistant.errorMessage === "string") summary.error = lastAssistant.errorMessage;
	return summary;
}

function sessionIdFromName(name) {
	if (!name.endsWith(".jsonl")) return null;
	const base = name.slice(0, -".jsonl".length);
	const underscore = base.indexOf("_");
	if (underscore === -1) return null;
	const id = base.slice(underscore + 1);
	return id === "" ? null : id;
}

export function listSessionFiles(plansDir, planId) {
	const folder = resolveInside(plansDir, "sessions", planId);
	if (folder === null) return [];
	let names;
	try {
		names = fs.readdirSync(folder);
	} catch {
		return [];
	}
	names.sort();
	const files = [];
	for (const name of names) {
		const id = sessionIdFromName(name);
		if (id === null) continue;
		const file = resolveInside(folder, name);
		if (file === null) continue;
		try {
			if (!fs.statSync(file).isFile()) continue;
		} catch {
			continue;
		}
		files.push({ id, file });
	}
	return files;
}

export function findSessionFile(plansDir, planId, sessionId) {
	let found = null;
	for (const item of listSessionFiles(plansDir, planId)) if (item.id === sessionId) found = item.file;
	return found;
}
