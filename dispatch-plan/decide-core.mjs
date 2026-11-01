/**
 * The pure logic of the decider that stays with the CLI: the audit request
 * builder, the noisy-OR aggregate and the audit proposal.
 *
 * The config parse, the effort question builder, the effort rule and the
 * network live in `pi-plan-dispatch/decider/`, which `decide.mjs` loads from
 * the dispatcher folder. No I/O, no network and no imports here. Everything is
 * a plain function of its arguments, so it is tested alone and agrees with the
 * CLI on the question and event shapes.
 *
 * Run its tests with: node --test dispatch-plan/decide-core.test.mjs (Node 24+)
 */

/** The thresholds `aggregate` and `proposal` fall back to (R8). */
const AUDIT_THRESHOLD_DEFAULTS = {
	approve: 0.5,
	dismiss: 0.1,
	minorWeight: 0.2,
};

/** The request cap of one invocation (R9): above it the CLI exits 64 without a call. */
const MAX_REQUESTS = 40;

/** The task body sent with one finding, in characters (R7). */
const TASK_BODY_LIMIT = 8000;

/** The plan's shared context sent with one finding, in characters (R7). */
const PLAN_CONTEXT_LIMIT = 6000;

function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A finite number in [0, 1], else the fallback. */
function unitNumber(value, fallback) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

/** A probability, where a missing or non-numeric value counts as 0. */
function probabilityOrZero(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Text cut to a character limit; anything that is not a string gives "". */
function cut(text, limit) {
	return typeof text === "string" ? text.slice(0, limit) : "";
}

/**
 * The backend request for one plan-audit finding (R7): the finding text and
 * severity, the bodies of the tasks it names and the spec lines of the
 * requirements it names (both limited to what the ctx actually has), and the
 * plan's shared context.
 */
function auditRequest(finding, ctx) {
	const tasks = {};
	for (const id of Array.isArray(finding.tasks) ? finding.tasks : []) {
		if (isPlainObject(ctx?.tasks) && Object.hasOwn(ctx.tasks, id)) {
			tasks[id] = cut(ctx.tasks[id], TASK_BODY_LIMIT);
		}
	}
	const requirements = {};
	for (const req of Array.isArray(finding.reqs) ? finding.reqs : []) {
		if (isPlainObject(ctx?.reqs) && Object.hasOwn(ctx.reqs, req)) {
			requirements[req] = ctx.reqs[req];
		}
	}
	return {
		state: {
			finding: finding.text,
			severity: finding.severity,
			tasks,
			requirements,
			plan_context: cut(ctx?.planContext, PLAN_CONTEXT_LIMIT),
		},
		questions: {
			real_defect: {
				type: "noul",
				instructions:
					"Is this finding a real defect in the current plan text that would make the plan fail, produce wrong results or break a rule?",
				criteria: {
					false: "wording, style or already handled",
					true: "a real defect that must be fixed",
				},
			},
		},
	};
}

/** P(the finding is a real defect), the only answer the audit request asks for (R7). */
function realDefectP(answers) {
	const p = answers?.real_defect?.noul;
	if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) {
		throw new TypeError("realDefectP needs answers.real_defect.noul in [0, 1]");
	}
	return p;
}

/**
 * The noisy-OR aggregate (R8): A = 1 - product(1 - w_i * p_i), with w = 1 for
 * blocker and major and `minorWeight` for minor, and 0 with no findings. A
 * missing p counts as 0, so it can never make a plan look worse than it is.
 */
function aggregate(findings, thresholds = AUDIT_THRESHOLD_DEFAULTS) {
	const list = Array.isArray(findings) ? findings : [];
	if (list.length === 0) return 0;
	const minorWeight = unitNumber(thresholds?.minorWeight, AUDIT_THRESHOLD_DEFAULTS.minorWeight);
	let noDefect = 1;
	for (const finding of list) {
		const weight = finding.severity === "minor" ? minorWeight : 1;
		noDefect *= 1 - weight * probabilityOrZero(finding.p);
	}
	return 1 - noDefect;
}

/**
 * The proposal of one audit round (R8). Advice only: the CLI never flips a
 * plan and never writes plan.approved. A `pass` approves when A is below
 * `approve`, else holds. A `fail` dismisses only when there is at least one
 * blocker or major and every one of them is below `dismiss`, else fixes.
 */
function proposal(verdict, findings, value, thresholds = AUDIT_THRESHOLD_DEFAULTS) {
	if (verdict !== "pass" && verdict !== "fail") {
		throw new RangeError(`unknown audit verdict: ${verdict}`);
	}
	if (verdict === "pass") {
		const approve = unitNumber(thresholds?.approve, AUDIT_THRESHOLD_DEFAULTS.approve);
		return value < approve ? "approve" : "hold";
	}
	const dismiss = unitNumber(thresholds?.dismiss, AUDIT_THRESHOLD_DEFAULTS.dismiss);
	const serious = (Array.isArray(findings) ? findings : []).filter((finding) => finding.severity !== "minor");
	if (serious.length > 0 && serious.every((finding) => probabilityOrZero(finding.p) < dismiss)) {
		return "dismiss";
	}
	return "fix";
}

/**
 * The requirements of a spec (R7): every line that starts with "- R<digits>."
 * as key `R<digits>` and the trimmed line as its value.
 */
function parseSpecRequirements(specText) {
	const out = {};
	for (const line of String(specText ?? "").split("\n")) {
		const match = /^- (R\d+)\./.exec(line);
		if (match) out[match[1]] = line.trim();
	}
	return out;
}

export {
	MAX_REQUESTS,
	aggregate,
	auditRequest,
	parseSpecRequirements,
	proposal,
	realDefectP,
};
