/** Decider views, ported from monitor/src/server/decider.ts. */
const dataOf = (event) => event.data ?? {};
function taskOf(event) {
	if (typeof event.task === "string" && event.task !== "") return event.task;
	const fromData = dataOf(event).task;
	return typeof fromData === "string" && fromData !== "" ? fromData : null;
}
function tsOf(event) {
	const value = Date.parse(event.ts);
	return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}
const numberOf = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const textOf = (value) => (typeof value === "string" && value !== "" ? value : null);

function probabilitiesOf(value) {
	const result = {};
	if (value === null || typeof value !== "object" || Array.isArray(value)) return result;
	for (const [key, entry] of Object.entries(value)) {
		const num = numberOf(entry);
		if (num !== null) result[key] = num;
	}
	return result;
}
const atLeastAsLate = (a, b) => tsOf(a) >= tsOf(b);
const attemptOf = (event) => numberOf(event.attempt) ?? Number.POSITIVE_INFINITY;
function startsBefore(a, b) {
	const attemptA = attemptOf(a);
	const attemptB = attemptOf(b);
	if (attemptA !== attemptB) return attemptA < attemptB;
	return tsOf(a) < tsOf(b);
}
function effortView(event, start) {
	const data = dataOf(event);
	const startData = start === null ? {} : dataOf(start);
	return {
		suggested: textOf(data.suggested) ?? "",
		probabilities: probabilitiesOf(data.probabilities),
		confidence: numberOf(data.confidence),
		complexity: numberOf(data.complexity),
		ran: textOf(startData.thinking),
	};
}
function findingsOf(value) {
	if (!Array.isArray(value)) return [];
	const findings = [];
	for (const entry of value) {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
		const id = textOf(entry.id);
		const severity = textOf(entry.severity);
		const p = numberOf(entry.p);
		if (id === null || severity === null || p === null) continue;
		findings.push({ id, severity, p });
	}
	return findings;
}
function auditView(event) {
	const data = dataOf(event);
	return {
		proposal: textOf(data.proposal) ?? "unknown",
		aggregate: numberOf(data.aggregate) ?? 0,
		verdict: textOf(data.verdict) ?? "unknown",
		auditRound: numberOf(data.audit_round) ?? 0,
		findings: findingsOf(data.findings),
	};
}

export function applyDecider(plan, events) {
	const latestEffort = new Map();
	const firstStart = new Map();
	let latestAudit = null;
	for (const event of events) {
		if (event.kind === "decision.effort") {
			const task = taskOf(event);
			if (task === null || textOf(dataOf(event).suggested) === null) continue;
			const previous = latestEffort.get(task);
			if (previous === undefined || atLeastAsLate(event, previous)) latestEffort.set(task, event);
		} else if (event.kind === "task.start") {
			const task = taskOf(event);
			if (task === null) continue;
			const previous = firstStart.get(task);
			if (previous === undefined || startsBefore(event, previous)) firstStart.set(task, event);
		} else if (event.kind === "decision.audit") {
			if (latestAudit === null || atLeastAsLate(event, latestAudit)) latestAudit = event;
		}
	}
	const tasks = plan.tasks.map((task) => {
		const effort = latestEffort.get(task.id);
		const start = firstStart.get(task.id) ?? null;
		return { ...task, decider: effort === undefined ? null : effortView(effort, start) };
	});
	return { ...plan, tasks, audit: latestAudit === null ? null : auditView(latestAudit) };
}
