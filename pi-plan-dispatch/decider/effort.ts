/**
 * The effort part of the decider (R2, R3, R7): the backend request for a
 * task, the effort rule that turns the answers into a thinking level, and the
 * escalation steps used when a real retry happens.
 *
 * A port of `effortRequest` and `suggestEffort` from
 * `dispatch-plan/decide-core.mjs`, unchanged in behavior, plus `LADDER` and
 * `escalateLevel`.
 *
 * Pure: no I/O and no imports beyond types.
 */

import type { BackendRequest } from "./backend.ts";
import type { Thresholds } from "./config.ts";

/** The thinking levels in the order a retry escalates through them (R7). */
export const LADDER: readonly string[] = ["low", "high", "max"];

const DEFAULT_THRESHOLDS: Thresholds = {
	effortMax: 0.4,
	effortLow: 0.6,
	complexityHigh: 3,
	approve: 0.5,
	dismiss: 0.1,
	minorWeight: 0.2,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A finite number in [0, 1], else the fallback. */
function unitNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

/** A finite number in [0, 4] (the complexity score scale), else the fallback. */
function scoreNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 4 ? value : fallback;
}

/** A probability, where a missing or non-numeric value counts as 0. */
function probabilityOrZero(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** The backend request for one task's effort (R6): its body, files and role. */
export function effortRequest(task: { body: string; files: string[]; role?: string }): BackendRequest {
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
export function suggestEffort(
	answers: any,
	thresholds: Partial<Thresholds> = DEFAULT_THRESHOLDS,
): {
	suggested: string;
	probabilities: { low: number; high: number; max: number };
	confidence: number | null;
	complexity: number | null;
} {
	const answer = answers?.effort;
	if (!isPlainObject(answer?.probabilities)) {
		throw new TypeError("suggestEffort needs answers.effort.probabilities");
	}
	const probabilities = {
		low: probabilityOrZero(answer.probabilities.low),
		high: probabilityOrZero(answer.probabilities.high),
		max: probabilityOrZero(answer.probabilities.max),
	};
	const effortMax = unitNumber(thresholds?.effortMax, DEFAULT_THRESHOLDS.effortMax);
	const effortLow = unitNumber(thresholds?.effortLow, DEFAULT_THRESHOLDS.effortLow);
	const complexityHigh = scoreNumber(thresholds?.complexityHigh, DEFAULT_THRESHOLDS.complexityHigh);
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
 * Moves `level` `steps` places up LADDER, capped at "max". A level that is
 * not on the ladder (including ""), or a non-positive step count, comes back
 * unchanged.
 */
export function escalateLevel(level: string, steps: number): string {
	const index = LADDER.indexOf(level);
	if (index === -1 || !(steps > 0)) return level;
	const next = Math.min(index + Math.floor(steps), LADDER.length - 1);
	return LADDER[next];
}
