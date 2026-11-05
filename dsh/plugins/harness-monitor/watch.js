/** Change signature for the SSE change event, ported from watch.ts. */
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveInside } from "./http.js";
import { selectPlan } from "./plans.js";

function names(dir) {
	try {
		return fs.readdirSync(dir).sort((a, b) => a.localeCompare(b));
	} catch {
		return [];
	}
}
function filePart(file) {
	try {
		const stat = fs.statSync(file);
		return `${file}:${stat.size}:${Math.round(stat.mtimeMs)}`;
	} catch {
		return `${file}:missing`;
	}
}
function entries(dir, filter) {
	const parts = [];
	for (const name of names(dir)) {
		if (filter !== undefined && !filter(name)) continue;
		parts.push(filePart(path.join(dir, name)));
	}
	return parts;
}

export function repoSignature(plansDir, planId) {
	let isDirectory = false;
	try {
		isDirectory = fs.statSync(plansDir).isDirectory();
	} catch {
		isDirectory = false;
	}
	if (!isDirectory) return "";
	const parts = [];
	const traces = resolveInside(plansDir, "traces");
	if (traces !== null) parts.push(...entries(traces, (name) => name.endsWith(".jsonl")));
	const running = resolveInside(plansDir, "running");
	if (running !== null) parts.push(...entries(running));
	const done = resolveInside(plansDir, "done");
	if (done !== null) parts.push(`done:[${names(done).join(",")}]`);
	if (planId !== null) {
		const sessions = resolveInside(plansDir, "sessions", planId);
		if (sessions !== null) parts.push(...entries(sessions));
	}
	return parts.join("|");
}

export function signature(repos) {
	return repos
		.map((repo) => {
			const planId = selectPlan(repo.dir).plan?.id ?? null;
			return `${repo.name}=${repoSignature(repo.dir, planId)}`;
		})
		.join("\n");
}
