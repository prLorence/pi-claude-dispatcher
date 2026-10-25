/**
 * The pure logic of the decider: the config, the two request builders, the
 * effort rule, the noisy-OR aggregate and the audit proposal.
 *
 * No I/O, no network and no imports. `decide.mjs` owns the files and the CLI,
 * `decide-backend.mjs` owns the network. Everything here is a plain function
 * of its arguments, so it is tested alone and agrees with the CLI on the
 * question and event shapes.
 *
 * Run its tests with: node --test dispatch-plan/decide-core.test.mjs (Node 24+)
 */

/** Defaults of the `decider` key of .plans/config.json (R5). Both modes are off. */
const DEFAULTS = {
	effort: "off",
	audit: "off",
	model: "perplexity/pplx-decider-flash-v1.2",
	timeoutMs: 30000,
	thresholds: {
		effortMax: 0.4,
		effortLow: 0.6,
		complexityHigh: 3,
		approve: 0.5,
		dismiss: 0.1,
		minorWeight: 0.2,
	},
};

/** The request cap of one invocation (R9): above it the CLI exits 64 without a call. */
const MAX_REQUESTS = 40;

/** The task body sent with one finding, in characters (R7). */
const TASK_BODY_LIMIT = 8000;

/** The plan's shared context sent with one finding, in characters (R7). */
const PLAN_CONTEXT_LIMIT = 6000;

/**
 * The threshold keys of the config validated as numbers in [0, 1];
 * `complexityHigh` is on the score scale and is validated separately.
 */
const THRESHOLD_KEYS = ["effortMax", "effortLow", "approve", "dismiss", "minorWeight"];

function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A finite number in [0, 1], else the fallback. */
function unitNumber(value, fallback) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

/** A finite number in [0, 4] (the complexity score scale), else the fallback. */
function scoreNumber(value, fallback) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 4 ? value : fallback;
}

/** A probability, where a missing or non-numeric value counts as 0. */
function probabilityOrZero(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Text cut to a character limit; anything that is not a string gives "". */
function cut(text, limit) {
	return typeof text === "string" ? text.slice(0, limit) : "";
}

/** A copy of the defaults, so a caller can never mutate the shared object. */
function defaultsCopy() {
	return { ...DEFAULTS, thresholds: { ...DEFAULTS.thresholds } };
}

/**
 * The `decider` value of the parsed .plans/config.json as a full config (R5).
 * A missing or non-object value gives the defaults; an invalid mode becomes
 * "off" and any invalid number falls back to its default; unknown keys are
 * dropped.
 */
function loadDeciderConfig(raw) {
	const config = defaultsCopy();
	if (!isPlainObject(raw)) return config;
	if (raw.effort === "apply") config.effort = "apply";
	if (raw.audit === "shadow") config.audit = "shadow";
	if (typeof raw.model === "string" && raw.model.trim()) config.model = raw.model;
	if (Number.isInteger(raw.timeoutMs) && raw.timeoutMs > 0) config.timeoutMs = raw.timeoutMs;
	if (isPlainObject(raw.thresholds)) {
		for (const key of THRESHOLD_KEYS) {
			config.thresholds[key] = unitNumber(raw.thresholds[key], DEFAULTS.thresholds[key]);
		}
		config.thresholds.complexityHigh = scoreNumber(raw.thresholds.complexityHigh, DEFAULTS.thresholds.complexityHigh);
	}
	return config;
}

/** The backend request for one task's effort (R6): its body, files and role. */
function effortRequest(task) {
	return {
		state: {
			task: task.body,
			files: [...task.files],
			role: task.role ?? "implement",
		},
		questions: {
			effort: {
				type: "choice",
				instructions: "How much reasoning effort does a coding model need to implement this task correctly?",
				criteria: {
					low: "mechanical or single-step edit, little ambiguity",
					high: "multi-step logic, several interacting rules or edge cases",
					max: "intricate concurrency, security or algorithmic reasoning",
				},
			},
			complexity: {
				type: "score",
				instructions: "How complex is this task?",
				criteria: ["trivial", "simple", "moderate", "complex", "very complex"],
			},
		},
	};
}

/**
 * The effort rule (R2), in this order: `max` when P(max) is at least
 * `effortMax`; otherwise `high` when the complexity score (`complexity`, 0 to
 * 4) is at least `complexityHigh`; otherwise `low`. When the score is missing
 * or not a finite number, the P(low) fallback decides between `high` and
 * `low`: `high` when P(low) is below `effortLow`, else `low`. A missing option
 * counts as 0. The returned `probabilities` are the three options normalised,
 * so a missing answer is visible as 0, and `complexity` is the score when it
 * is a finite number, else null.
 */
function suggestEffort(answers, thresholds = DEFAULTS.thresholds) {
	const answer = answers?.effort;
	if (!isPlainObject(answer?.probabilities)) {
		throw new TypeError("suggestEffort needs answers.effort.probabilities");
	}
	const probabilities = {
		low: probabilityOrZero(answer.probabilities.low),
		high: probabilityOrZero(answer.probabilities.high),
		max: probabilityOrZero(answer.probabilities.max),
	};
	const effortMax = unitNumber(thresholds?.effortMax, DEFAULTS.thresholds.effortMax);
	const effortLow = unitNumber(thresholds?.effortLow, DEFAULTS.thresholds.effortLow);
	const complexityHigh = scoreNumber(thresholds?.complexityHigh, DEFAULTS.thresholds.complexityHigh);
	const rawScore = answers.complexity?.score;
	const complexity = typeof rawScore === "number" && Number.isFinite(rawScore) ? rawScore : null;
	let suggested = "low";
	if (probabilities.max >= effortMax) suggested = "max";
	else if (complexity !== null) {
		if (complexity >= complexityHigh) suggested = "high";
	} else if (probabilities.low < effortLow) suggested = "high";
	return {
		suggested,
		probabilities,
		confidence: answer.confidence ?? null,
		complexity,
	};
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
function aggregate(findings, thresholds = DEFAULTS.thresholds) {
	const list = Array.isArray(findings) ? findings : [];
	if (list.length === 0) return 0;
	const minorWeight = unitNumber(thresholds?.minorWeight, DEFAULTS.thresholds.minorWeight);
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
function proposal(verdict, findings, value, thresholds = DEFAULTS.thresholds) {
	if (verdict !== "pass" && verdict !== "fail") {
		throw new RangeError(`unknown audit verdict: ${verdict}`);
	}
	if (verdict === "pass") {
		const approve = unitNumber(thresholds?.approve, DEFAULTS.thresholds.approve);
		return value < approve ? "approve" : "hold";
	}
	const dismiss = unitNumber(thresholds?.dismiss, DEFAULTS.thresholds.dismiss);
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
	DEFAULTS,
	MAX_REQUESTS,
	aggregate,
	auditRequest,
	effortRequest,
	loadDeciderConfig,
	parseSpecRequirements,
	proposal,
	realDefectP,
	suggestEffort,
};
