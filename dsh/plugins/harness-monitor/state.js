/** Board state, ported from monitor/src/server/state.ts. */
import { applyDecider } from "./decider.js";
import { buildPlanView } from "./lanes.js";
import { readTraceEvents, selectPlan } from "./plans.js";
import { listSessionFiles } from "./sessions.js";

function tsOf(event) {
	if (event === undefined || typeof event.ts !== "string") return null;
	return Number.isFinite(Date.parse(event.ts)) ? event.ts : null;
}
function emptyRepo(name, message) {
	return { name, active: false, plan: null, message, startedAt: null, lastActivity: null };
}

export function readRepo(repo, nowMs) {
	try {
		const selected = selectPlan(repo.dir);
		if (selected.plan === null) return emptyRepo(repo.name, selected.message);
		const events = readTraceEvents(repo.dir, selected.plan.trace, selected.plan.id);
		const sessionFiles = listSessionFiles(repo.dir, selected.plan.id);
		const view = buildPlanView(selected.plan, selected.running, events, sessionFiles, nowMs);
		const plan = applyDecider(view, events);
		return {
			name: repo.name,
			active: selected.running && plan !== null,
			plan,
			message: selected.message,
			startedAt: tsOf(events[0]),
			lastActivity: tsOf(events[events.length - 1]),
		};
	} catch {
		return emptyRepo(repo.name, "Could not read the plans folder");
	}
}

function byTimeDesc(a, b) {
	if (a === null && b === null) return 0;
	if (a === null) return 1;
	if (b === null) return -1;
	return Date.parse(b) - Date.parse(a);
}

export function readState(repos, nowMs = Date.now(), message = null) {
	const now = new Date(nowMs).toISOString();
	const views = repos.map((repo) => readRepo(repo, nowMs));
	const active = views.filter((repo) => repo.active);
	const idle = views.filter((repo) => !repo.active);
	active.sort((a, b) => byTimeDesc(a.startedAt, b.startedAt));
	idle.sort((a, b) => byTimeDesc(a.lastActivity, b.lastActivity));
	return { repos: [...active, ...idle], message, now };
}
