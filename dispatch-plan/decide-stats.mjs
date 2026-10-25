/**
 * The outcome joins behind `decide.mjs stats`: take the recorded `decision.*`
 * events and compare each one with what actually happened to the plan.
 *
 * Pure: no file access, no network. The caller reads every trace under
 * `.plans/traces/` and passes all their events in one array, in file order.
 *
 * Plain ESM with Node built-ins only (none are needed here).
 */

/** Effort levels in the order the dispatcher cares about; anything else sorts after. */
const LEVELS = { low: 0, high: 1, max: 2 };

function isObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finite(value) {
	return typeof value === "number" && Number.isFinite(value);
}

function text(value) {
	return value === undefined || value === null ? "" : String(value);
}

function kindOf(event) {
	return isObject(event) ? text(event.kind) : "";
}

/** Plans compare as text, so a plan that has no id still matches itself. */
function samePlan(a, b) {
	return text(a) === text(b);
}

/** The attempt number of a task event; the dispatcher always writes one. */
function attemptOf(event) {
	return finite(event?.attempt) ? event.attempt : 1;
}

/** The events of one kind for one task of one plan of one trace, in array order. */
function taskEvents(events, kind, trace, plan, task) {
	return events.filter(
		(e) =>
			kindOf(e) === kind &&
			e.trace === trace &&
			samePlan(e.plan, plan) &&
			text(e.task) === task,
	);
}

/** The earliest attempt, so a re-run never hides the level the task started with. */
function firstByAttempt(items) {
	let best;
	for (const e of items) if (!best || attemptOf(e) < attemptOf(best)) best = e;
	return best;
}

function lastByAttempt(items) {
	let best;
	for (const e of items) if (!best || attemptOf(e) >= attemptOf(best)) best = e;
	return best;
}

function levelRank(level) {
	return Object.hasOwn(LEVELS, level) ? LEVELS[level] : Object.keys(LEVELS).length;
}

/**
 * What happened to one suggested task: the level the first attempt really ran
 * with, whether the first attempt passed, the failed retries, the pair review
 * rounds that asked for changes, and how the task ended.
 */
function effortOutcome(events, decision) {
	const trace = decision.trace;
	const plan = decision.plan;
	const task = text(decision.data?.task ?? decision.task);
	const starts = taskEvents(events, "task.start", trace, plan, task);
	const ends = taskEvents(events, "task.end", trace, plan, task);
	const reviews = taskEvents(events, "task.review", trace, plan, task);
	// An empty thinking level means no level was passed, so it reads as none.
	const ran = text(firstByAttempt(starts)?.data?.thinking) || "none";
	const retries = ends.filter((e) => e.data?.state === "retry" && e.data?.ok === false).length;
	return {
		ran,
		first_try: firstByAttempt(ends)?.data?.state === "done" ? 1 : 0,
		retried: retries > 0 ? 1 : 0,
		changes: reviews.filter((e) => e.data?.verdict === "changes").length,
		failed: lastByAttempt(ends)?.data?.state === "failed" ? 1 : 0,
	};
}

/**
 * One row per (suggested level, level that ran), counting tasks. `first_try`
 * counts tasks whose first `task.end` was `done`, `retried` counts tasks with
 * at least one failed retry, `changes` sums the pair review rounds that asked
 * for changes, and `failed` counts tasks whose final `task.end` was `failed`.
 */
function effortRows(events) {
	const rows = new Map();
	for (const e of events) {
		if (kindOf(e) !== "decision.effort") continue;
		const suggested = text(e.data?.suggested) || "none";
		const o = effortOutcome(events, e);
		const key = `${suggested}\u0000${o.ran}`;
		const row =
			rows.get(key) ??
			{ suggested, ran: o.ran, n: 0, first_try: 0, retried: 0, changes: 0, failed: 0 };
		row.n += 1;
		row.first_try += o.first_try;
		row.retried += o.retried;
		row.changes += o.changes;
		row.failed += o.failed;
		rows.set(key, row);
	}
	return [...rows.values()].sort(
		(a, b) =>
			levelRank(a.suggested) - levelRank(b.suggested) ||
			a.suggested.localeCompare(b.suggested) ||
			a.ran.localeCompare(b.ran),
	);
}

/**
 * What the trace says after one audit proposal: the next plan audit's verdict,
 * else the plan's approval, else nothing. Both must belong to the same trace
 * and plan, because another plan's approval says nothing about this one.
 */
function auditOutcome(events, index) {
	const decision = events[index];
	const later = events
		.slice(index + 1)
		.filter((e) => e.trace === decision.trace && samePlan(e.plan, decision.plan));
	const audit = later.find((e) => kindOf(e) === "plan.audit");
	if (audit) return { next: text(audit.data?.verdict) || "none", from: "audit" };
	const approved = later.find((e) => kindOf(e) === "plan.approved");
	if (approved) return { next: `approved by ${text(approved.data?.approved_by) || "unknown"}`, from: "approved" };
	return { next: "none", from: "none" };
}

/**
 * A proposal agrees when it called the next step right: approve wanted the
 * plan approved, hold and fix wanted another audit round, and dismiss wanted
 * the plan approved without a further failed audit (a later audit would have
 * been the outcome, so an approval is the no-further-fail case).
 */
function agrees(proposal, from) {
	if (proposal === "approve") return from === "approved";
	if (proposal === "hold" || proposal === "fix") return from === "audit";
	if (proposal === "dismiss") return from === "approved";
	return false;
}

/** One row per (proposal, audit verdict, next outcome), counting commands. */
function auditRows(events) {
	const rows = new Map();
	for (const [index, e] of events.entries()) {
		if (kindOf(e) !== "decision.audit") continue;
		const proposal = text(e.data?.proposal) || "none";
		const verdict = text(e.data?.verdict) || "none";
		const outcome = auditOutcome(events, index);
		const key = `${proposal}\u0000${verdict}\u0000${outcome.next}`;
		const row =
			rows.get(key) ??
			{ proposal, verdict, next: outcome.next, n: 0, agree: true };
		row.n += 1;
		// Every event in a group shares its proposal and outcome, so the flag holds.
		row.agree = row.agree && agrees(proposal, outcome.from);
		rows.set(key, row);
	}
	return [...rows.values()].sort(
		(a, b) =>
			a.proposal.localeCompare(b.proposal) ||
			a.verdict.localeCompare(b.verdict) ||
			a.next.localeCompare(b.next),
	);
}

/**
 * The report: effort rows, audit rows, and the total cost of every `decision.*`
 * event. Each event carries only its own share of a command's cost, so the sum
 * is the real spend.
 */
export function statsReport(events) {
	const list = Array.isArray(events) ? events.filter(isObject) : [];
	const cost = list.reduce(
		(sum, e) => (kindOf(e).startsWith("decision.") && finite(e.data?.cost) ? sum + e.data.cost : sum),
		0,
	);
	return { effort: effortRows(list), audit: auditRows(list), cost };
}

/** Aligned columns: `align` is one "l" or "r" per column. */
function renderTable(headers, body, align) {
	const rows = [headers.map(text), ...body.map((row) => row.map(text))];
	const widths = headers.map((_, i) => Math.max(...rows.map((row) => row[i].length)));
	const line = (row) =>
		row.map((cell, i) => (align[i] === "r" ? cell.padStart(widths[i]) : cell.padEnd(widths[i]))).join("  ").trimEnd();
	return [line(rows[0]), line(widths.map((w) => "-".repeat(w))), ...rows.slice(1).map(line)];
}

const EFFORT_HEADERS = ["suggested", "ran", "tasks", "first try", "retried", "changes", "failed"];
const EFFORT_ALIGN = ["l", "l", "r", "r", "r", "r", "r"];
const AUDIT_HEADERS = ["proposal", "verdict", "next", "times", "agree"];
const AUDIT_ALIGN = ["l", "l", "l", "r", "l"];

/** The two tables and the total cost, or one line when nothing was recorded. */
export function renderStats(report) {
	const r = isObject(report) ? report : {};
	const effort = Array.isArray(r.effort) ? r.effort : [];
	const audit = Array.isArray(r.audit) ? r.audit : [];
	if (!effort.length && !audit.length) return "no decisions recorded";
	const out = ["decider stats", "", "effort: suggested level vs the level the task ran with"];
	out.push(
		...(effort.length
			? renderTable(
					EFFORT_HEADERS,
					effort.map((row) => [row.suggested, row.ran, row.n, row.first_try, row.retried, row.changes, row.failed]),
					EFFORT_ALIGN,
				)
			: ["(none)"]),
	);
	out.push("", "audit: proposal vs the next event of the trace");
	out.push(
		...(audit.length
			? renderTable(
					AUDIT_HEADERS,
					audit.map((row) => [row.proposal, row.verdict, row.next, row.n, row.agree ? "yes" : "no"]),
					AUDIT_ALIGN,
				)
			: ["(none)"]),
	);
	out.push("", `total cost $${(finite(r.cost) ? r.cost : 0).toFixed(6)}`);
	return out.join("\n");
}
