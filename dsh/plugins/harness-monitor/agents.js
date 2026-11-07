/**
 * The Agents view: list Pi, omp and dsh sessions read-only.
 *
 * A session outside a monitored repo is only summarised, never copied; the
 * reader follows no symlink out of a session root and writes nothing.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";

const MAX_PER_GROUP = 50;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const ID_RE = /^[\w.-]+$/;

function inside(root, target) {
	try {
		const real = fs.realpathSync(target);
		const base = fs.realpathSync(root);
		return real === base || real.startsWith(base + path.sep);
	} catch {
		return false;
	}
}

function listFiles(root) {
	const out = [];
	let folders;
	try {
		folders = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const folder of folders) {
		if (!folder.isDirectory()) continue;
		const dir = path.join(root, folder.name);
		if (!inside(root, dir)) continue;
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.isDirectory()) continue;
			if (!entry.name.endsWith(".jsonl")) continue;
			const file = path.join(dir, entry.name);
			if (!inside(root, file)) continue;
			try {
				const stat = fs.statSync(file);
				if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
				out.push({ file, size: stat.size, mtimeMs: stat.mtimeMs });
			} catch {}
		}
	}
	return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function lastJsonLine(text) {
	const lines = text.split("\n").filter(Boolean);
	for (let i = lines.length - 1; i >= 0; i--) {
		try {
			return JSON.parse(lines[i]);
		} catch {}
	}
	return null;
}

function summarisePiLike(file, mtimeMs, nowMs) {
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return null;
	}
	let ended = false;
	let model = null;
	let prompt = null;
	let tokens = 0;
	let cost = null;
	let sawAssistant = false;
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let obj;
		try {
			obj = JSON.parse(line);
		} catch {
			continue;
		}
		if (obj.type === "model_change") {
			const changed = typeof obj.modelId === "string" ? obj.modelId : typeof obj.model === "string" ? obj.model : null;
			if (changed !== null) model = changed;
		}
		if (obj.type === "message" && obj.message && typeof obj.message === "object") {
			const msg = obj.message;
			if (msg.role === "user" && prompt === null && Array.isArray(msg.content)) prompt = msg.content.find((p) => p?.type === "text")?.text ?? null;
			if (msg.role === "assistant") {
				sawAssistant = true;
				if (typeof msg.stopReason === "string" && msg.stopReason && msg.stopReason !== "toolUse") ended = true;
				if (msg.usage) {
					tokens += (msg.usage.input ?? 0) + (msg.usage.output ?? 0);
					if (typeof msg.usage.cost?.total === "number") cost = (cost ?? 0) + msg.usage.cost.total;
				}
			}
		}
	}
	return { id: path.basename(file, ".jsonl").split("_").pop(), file, mtimeMs, live: !ended && nowMs - mtimeMs <= 30000, ended, model, prompt, tokens, cost, agent: "" };
}

function summariseDsh(file, mtimeMs, nowMs) {
	let text;
	try {
		const buf = fs.readFileSync(file);
		text = file.endsWith(".zstd") ? zlib.zstdDecompressSync(buf).toString("utf8") : buf.toString("utf8");
	} catch {
		return null;
	}
	let model = null;
	let prompt = null;
	let ended = false;
	let tokens = 0;
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let obj;
		try {
			obj = JSON.parse(line);
		} catch {
			continue;
		}
		const type = obj.type ?? obj.kind;
		if (type === "session" && obj.cwd && prompt === null) prompt = `cwd ${obj.cwd}`;
		if (type === "model_change" && typeof obj.modelId === "string") model = obj.modelId;
		if (type === "turn/end") ended = true;
		if (type === "assistant/message" && obj.usage) tokens += (obj.usage.input ?? obj.usage.inputTokens ?? 0) + (obj.usage.output ?? obj.usage.outputTokens ?? 0);
	}
	const id = path.basename(path.dirname(file)).replace(/^session-/, "");
	return { id, file, mtimeMs, live: !ended && nowMs - mtimeMs <= 30000, ended, model, prompt, tokens, cost: null, agent: "dsh" };
}

function scan(agent, root, nowMs, summarise) {
	const out = [];
	for (const item of listFiles(root).slice(0, MAX_PER_GROUP * 4)) {
		const summary = summarise(item.file, item.mtimeMs, nowMs);
		if (summary === null) continue;
		if (!ID_RE.test(summary.id)) continue;
		summary.agent = agent;
		out.push(summary);
		if (out.length >= MAX_PER_GROUP) break;
	}
	return out;
}

/** List the sessions of the enabled agents. `scope: "all"` ignores the repo filter. */
export function listAgentSessions({ home = os.homedir(), repos = [], nowMs = Date.now(), scope = "added" } = {}) {
	const groups = [];
	groups.push({ agent: "pi", sessions: scan("pi", path.join(home, ".pi", "agent", "sessions"), nowMs, summarisePiLike) });
	groups.push({ agent: "omp", sessions: scan("omp", path.join(home, ".omp", "agent", "sessions"), nowMs, summarisePiLike) });
	const dshRoot = path.join(home, ".dsh", "sessions");
	const dsh = [];
	let dirs = [];
	try {
		dirs = fs.readdirSync(dshRoot, { withFileTypes: true });
	} catch {}
	for (const dir of dirs) {
		if (!dir.isDirectory()) continue;
		const folder = path.join(dshRoot, dir.name);
		let sessions = [];
		try {
			sessions = fs.readdirSync(folder, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const session of sessions) {
			if (!session.isDirectory() || !session.name.startsWith("session-")) continue;
			const inner = path.join(folder, session.name);
			let files = [];
			try {
				files = fs.readdirSync(inner).filter((n) => n.endsWith(".jsonl") || n.endsWith(".jsonl.zstd"));
			} catch {
				continue;
			}
			for (const file of files) {
				const full = path.join(inner, file);
				try {
					const stat = fs.statSync(full);
					const summary = summariseDsh(full, stat.mtimeMs, nowMs);
					if (summary) dsh.push(summary);
				} catch {}
			}
		}
	}
	dsh.sort((a, b) => b.mtimeMs - a.mtimeMs);
	groups.push({ agent: "dsh", sessions: dsh.slice(0, MAX_PER_GROUP) });
	const filtered = scope === "all" ? groups : groups.map((g) => ({ ...g, sessions: g.sessions.filter((s) => s.prompt !== null && repos.some((r) => (s.prompt ?? "").includes(r.dir.replace(/^.*\/\.plans$/, "")))) }));
	return { groups: filtered, scope, now: new Date(nowMs).toISOString() };
}
