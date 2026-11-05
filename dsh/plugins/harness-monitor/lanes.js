/** Lanes and task rows, ported from monitor/src/server/lanes.ts. */
import { summarizeSession } from "./sessions.js";

export const STALL_MS = 30000;

function escapeRe(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const dataOf = (event) => event.data ?? {};
const eventData = (event) => (event === null ? {} : dataOf(event));
const numberOf = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const attemptNumberOf = (event) => numberOf(event.attempt);
function sessionIdOf(event) {
	const value = dataOf(event).session_id;
	return typeof value === "string" && value !== "" ? value : null;
}
const roundOf = (event) => numberOf(dataOf(event).round);
const textOf = (value) => (typeof value === "string" && value !== "" ? value : null);

function endStateOf(event) {
	const data = dataOf(event);
	if (data.state === "failed") return "failed";
	if (data.state === "retry" && data.ok === false) return "failed";
	return "done";
}

function freshness(summary, running, nowMs) {
	if (running && nowMs - summary.mtimeMs <= STALL_MS) return "live";
	return "stalled";
}

function elapsedSeconds(summary, state, nowMs) {
	if (summary.startedAt === null) return null;
	const start = Date.parse(summary.startedAt);
	if (!Number.isFinite(start)) return null;
	let end = summary.lastTs === null ? Number.NaN : Date.parse(summary.lastTs);
	if (!Number.isFinite(end)) {
		if (state !== "live") return null;
		end = nowMs;
	}
	return Math.max(0, Math.round((end - start) / 1000));
}

function implementerSlots(plan, task, taskEvents, sessionFiles, fileById) {
	const slots = new Map();
	const ensure = (num) => {
		const found = slots.get(num);
		if (found !== undefined) return found;
		const slot = { num, sessionId: `${plan.id}.${task.id}.a${num}`, file: null, startEvent: null, endEvent: null };
		slots.set(num, slot);
		return slot;
	};
	for (const event of taskEvents) {
		if (event.kind === "task.start") {
			const num = attemptNumberOf(event);
			if (num === null) continue;
			const slot = ensure(num);
			slot.startEvent = event;
			const sessionId = sessionIdOf(event);
			if (sessionId !== null) slot.sessionId = sessionId;
		} else if (event.kind === "task.end") {
			const num = attemptNumberOf(event);
			if (num === null) continue;
			ensure(num).endEvent = event;
		}
	}
	const pattern = new RegExp(`^${escapeRe(plan.id)}\\.${escapeRe(task.id)}\\.a(\\d+)$`);
	for (const item of sessionFiles) {
		const match = pattern.exec(item.id);
		if (match === null) continue;
		const num = Number.parseInt(match[1], 10);
		const existing = slots.get(num);
		if (existing !== undefined) {
			if (existing.file === null) {
				existing.file = item.file;
				existing.sessionId = item.id;
			}
			continue;
		}
		slots.set(num, { num, sessionId: item.id, file: item.file, startEvent: null, endEvent: null });
	}
	for (const slot of slots.values()) if (slot.file === null) slot.file = fileById.get(slot.sessionId) ?? null;
	return [...slots.values()].sort((a, b) => a.num - b.num);
}

function reviewerSlots(plan, task, taskEvents, sessionFiles, fileById) {
	const slots = [];
	for (const event of taskEvents) {
		if (event.kind !== "task.review") continue;
		const round = roundOf(event);
		if (round === null) continue;
		const sessionId = sessionIdOf(event);
		slots.push({
			round,
			attempt: attemptNumberOf(event) ?? 1,
			sessionId: sessionId ?? `${plan.id}.${task.id}.review${round}.a1`,
			file: sessionId === null ? null : fileById.get(sessionId) ?? null,
			event,
		});
	}
	const pattern = new RegExp(`^${escapeRe(plan.id)}\\.${escapeRe(task.id)}\\.review(\\d+)\\.a(\\d+)$`);
	for (const item of sessionFiles) {
		const match = pattern.exec(item.id);
		if (match === null) continue;
		const round = Number.parseInt(match[1], 10);
		const attempt = Number.parseInt(match[2], 10);
		if (slots.some((slot) => slot.sessionId === item.id)) continue;
		const open = slots.find((slot) => slot.round === round && slot.file === null);
		if (open !== undefined) {
			open.file = item.file;
			open.sessionId = item.id;
			open.attempt = attempt;
			continue;
		}
		slots.push({ round, attempt, sessionId: item.id, file: item.file, event: null });
	}
	return slots.sort((a, b) => a.round - b.round || a.attempt - b.attempt);
}

function implementerState(summary, slot, running, nowMs) {
	if (summary.exists) {
		if (!summary.ended) return freshness(summary, running, nowMs);
		if (summary.stopReason === "error" || summary.stopReason === "aborted") return "failed";
		return slot.endEvent === null ? "done" : endStateOf(slot.endEvent);
	}
	if (slot.endEvent !== null) return endStateOf(slot.endEvent);
	if (slot.startEvent !== null && running) return "live";
	return "waiting";
}

function verdictOf(value) {
	if (value === "approve") return "approve";
	if (value === "changes") return "changes";
	return "unknown";
}
function findingsOf(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (Array.isArray(value)) return value.length;
	return null;
}
function buildReview(event, summary) {
	const data = dataOf(event);
	const verdict = verdictOf(data.verdict);
	return { verdict, findings: findingsOf(data.findings), failed: data.ok === false || verdict === "unknown", text: summary.lastText };
}
function reviewerState(summary, review, running, nowMs) {
	if (summary.exists) {
		if (!summary.ended) return freshness(summary, running, nowMs);
		return review !== null && review.failed ? "failed" : "done";
	}
	if (review !== null) return review.failed ? "failed" : "done";
	return "waiting";
}

function implementerAttempt(slot, running, nowMs, summarize) {
	const summary = summarize(slot.file);
	const state = implementerState(summary, slot, running, nowMs);
	const startData = eventData(slot.startEvent);
	const endData = eventData(slot.endEvent);
	return {
		id: slot.sessionId,
		label: `a${slot.num}`,
		state,
		model: textOf(startData.model) ?? textOf(endData.model) ?? summary.model,
		thinking: textOf(startData.thinking) ?? textOf(endData.thinking) ?? summary.thinking,
		startedAt: summary.startedAt,
		elapsedS: elapsedSeconds(summary, state, nowMs),
		tokens: summary.tokens,
		cost: summary.cost,
		lastTool: summary.lastTool,
		error: summary.error,
		hasSession: summary.exists,
		review: null,
	};
}

function reviewerAttempt(slot, running, nowMs, summarize) {
	const summary = summarize(slot.file);
	const data = eventData(slot.event);
	const review = slot.event === null ? null : buildReview(slot.event, summary);
	const state = reviewerState(summary, review, running, nowMs);
	return {
		id: slot.sessionId,
		label: `r${slot.round}`,
		state,
		model: textOf(data.model) ?? summary.model,
		thinking: textOf(data.thinking) ?? summary.thinking,
		startedAt: summary.startedAt,
		elapsedS: elapsedSeconds(summary, state, nowMs),
		tokens: summary.tokens,
		cost: summary.cost,
		lastTool: summary.lastTool,
		error: summary.error,
		hasSession: summary.exists,
		review,
	};
}

const laneOf = (attempts) => ({ state: attempts.length === 0 ? "waiting" : attempts[attempts.length - 1].state, attempts });
const emptyLane = () => ({ state: "waiting", attempts: [] });

export function buildPlanView(plan, running, events, sessionFiles, nowMs, summarize = summarizeSession) {
	const fileById = new Map();
	for (const item of sessionFiles) if (!fileById.has(item.id)) fileById.set(item.id, item.file);

	const eventsByTask = new Map();
	for (const event of events) {
		if (typeof event.task !== "string" || event.task === "") continue;
		const list = eventsByTask.get(event.task);
		if (list === undefined) eventsByTask.set(event.task, [event]);
		else list.push(event);
	}
	const latestEndOf = (taskId) => {
		let found = null;
		for (const event of eventsByTask.get(taskId) ?? []) if (event.kind === "task.end") found = event;
		return found;
	};
	const isDoneTask = (taskId) => {
		const end = latestEndOf(taskId);
		return end !== null && dataOf(end).state === "done";
	};

	const tasks = plan.tasks.map((task) => {
		const taskEvents = eventsByTask.get(task.id) ?? [];
		const skipped = !running && taskEvents.length === 0;
		const waitsFor = skipped ? [] : task.dependsOn.filter((id) => !isDoneTask(id));
		const implementers = skipped ? [] : implementerSlots(plan, task, taskEvents, sessionFiles, fileById).map((slot) => implementerAttempt(slot, running, nowMs, summarize));
		const reviewers = skipped || task.pair === null ? [] : reviewerSlots(plan, task, taskEvents, sessionFiles, fileById).map((slot) => reviewerAttempt(slot, running, nowMs, summarize));
		return {
			id: task.id,
			role: task.role,
			pair: task.pair,
			dependsOn: task.dependsOn,
			waitsFor,
			skipped,
			implementer: skipped ? emptyLane() : laneOf(implementers),
			reviewer: task.pair === null ? null : skipped ? emptyLane() : laneOf(reviewers),
			decider: null,
		};
	});

	let planEnd = null;
	for (const event of events) if (event.kind === "plan.end") planEnd = event;
	const gatePass = planEnd === null ? null : dataOf(planEnd).gate_pass;
	const gate = gatePass === true ? "pass" : gatePass === false ? "fail" : null;
	return {
		id: plan.id,
		trace: plan.trace,
		round: plan.round,
		state: running ? "running" : gate === "fail" ? "failed" : "done",
		gate,
		done: plan.tasks.filter((task) => isDoneTask(task.id)).length,
		total: plan.tasks.length,
		tasks,
		audit: null,
	};
}
