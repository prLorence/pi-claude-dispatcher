import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const SESSION_FILE_TS = "2026-10-22T18-02-28-549Z";

export function makePlansDir() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-monitor-fixture-"));
	for (const name of ["traces", "running", "done", "sessions", "inbox"]) fs.mkdirSync(path.join(dir, name), { recursive: true });
	return dir;
}

export function cleanup(dir) {
	try {
		fs.chmodSync(dir, 0o755);
	} catch {}
	fs.rmSync(dir, { recursive: true, force: true });
}

function planText(id, trace, tasks) {
	const lines = ["---", `id: ${id}`, `trace: ${trace}`, "round: 1", "status: ready", "---", "## Context", "", "Fixture plan for the monitor tests."];
	for (const task of tasks) {
		lines.push("", `## task: ${task.id}`, "files: x.ts", `depends_on: [${(task.dependsOn ?? []).join(", ")}]`);
		if (task.role !== undefined) lines.push(`role: ${task.role}`);
		if (task.pair !== undefined) lines.push(`pair: ${task.pair}`);
		lines.push("", `Body line for ${task.id}.`);
	}
	lines.push("");
	return lines.join("\n");
}

export function writePlan(dir, where, id, tasks, trace = id) {
	const text = planText(id, trace, tasks);
	if (where === "running") {
		fs.writeFileSync(path.join(dir, "running", `${id}.md`), text);
		return;
	}
	const folder = path.join(dir, "done", id);
	fs.mkdirSync(folder, { recursive: true });
	fs.writeFileSync(path.join(folder, "plan.md"), text);
}

export function oneLine(value) {
	return `${JSON.stringify(value)}\n`;
}

export function writeEvents(dir, trace, events) {
	fs.mkdirSync(path.join(dir, "traces"), { recursive: true });
	const text = events.map((event) => oneLine({ ...event, v: 1, trace })).join("");
	fs.appendFileSync(path.join(dir, "traces", `${trace}.jsonl`), text);
}

export function ev(kind, plan, ts, extra = {}) {
	const event = { ts, plan, kind, actor: "worker", round: 1 };
	if (extra.task !== undefined) event.task = extra.task;
	if (extra.attempt !== undefined) event.attempt = extra.attempt;
	if (extra.data !== undefined) event.data = extra.data;
	return event;
}

export function writeSession(dir, planId, sessionId, lines, opts = {}) {
	const folder = path.join(dir, "sessions", planId);
	fs.mkdirSync(folder, { recursive: true });
	const file = path.join(folder, `${SESSION_FILE_TS}_${sessionId}.jsonl`);
	let text = lines.map(oneLine).join("");
	if (opts.raw !== undefined) text += opts.raw;
	fs.writeFileSync(file, text);
	if (opts.mtimeMs !== undefined) {
		const seconds = opts.mtimeMs / 1000;
		fs.utimesSync(file, seconds, seconds);
	}
	return file;
}

export function sessionHeader() {
	return { type: "session_info", timestamp: "2026-10-22T18:00:00.000Z" };
}
export function modelChange(modelId) {
	return { type: "model_change", timestamp: "2026-10-22T18:00:01.000Z", modelId };
}
export function userMsg(text) {
	return { type: "message", timestamp: "2026-10-22T18:00:02.000Z", message: { role: "user", content: [{ type: "text", text }] } };
}
export function assistantMsg(text, opts = {}) {
	return {
		type: "message",
		timestamp: opts.ts ?? "2026-10-22T18:00:03.000Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			stopReason: opts.stopReason ?? "stop",
			...(opts.usage ? { usage: opts.usage } : {}),
		},
	};
}
export function textPart(text) {
	return { type: "text", text };
}
