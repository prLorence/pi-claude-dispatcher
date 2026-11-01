/**
 * The `decider` key of .plans/config.json: its types, its defaults and its
 * validation. A port of `loadDeciderConfig` and `DEFAULTS` from
 * `dispatch-plan/decide-core.mjs`, with the `dispatch` effort mode and the
 * `escalate` flag added.
 *
 * Pure: no I/O and no imports.
 */

export type EffortMode = "off" | "apply" | "dispatch";

export type AuditMode = "off" | "shadow";

export interface Thresholds {
	effortMax: number;
	effortLow: number;
	complexityHigh: number;
	approve: number;
	dismiss: number;
	minorWeight: number;
}

export interface DeciderConfig {
	effort: EffortMode;
	audit: AuditMode;
	escalate: boolean;
	model: string;
	timeoutMs: number;
	thresholds: Thresholds;
}

/** Defaults of the `decider` key (R5). Both modes are off and escalation is off. */
export const DECIDER_DEFAULTS: DeciderConfig = {
	effort: "off",
	audit: "off",
	escalate: false,
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

/**
 * The threshold keys validated as numbers in [0, 1]; `complexityHigh` is on
 * the score scale and is validated separately.
 */
const THRESHOLD_KEYS = ["effortMax", "effortLow", "approve", "dismiss", "minorWeight"] as const;

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

/** A copy of the defaults, so a caller can never mutate the shared object. */
function defaultsCopy(): DeciderConfig {
	return { ...DECIDER_DEFAULTS, thresholds: { ...DECIDER_DEFAULTS.thresholds } };
}

/**
 * The `decider` value of the parsed .plans/config.json as a full config (R5).
 * A missing or non-object value gives the defaults; an invalid mode becomes
 * "off" and any invalid number falls back to its default; unknown keys are
 * dropped. `escalate` is true only for the boolean true.
 */
export function loadDeciderConfig(raw: unknown): DeciderConfig {
	const config = defaultsCopy();
	if (!isPlainObject(raw)) return config;
	if (raw.effort === "apply" || raw.effort === "dispatch") config.effort = raw.effort;
	if (raw.audit === "shadow") config.audit = "shadow";
	if (raw.escalate === true) config.escalate = true;
	if (typeof raw.model === "string" && raw.model.trim()) config.model = raw.model;
	if (Number.isInteger(raw.timeoutMs) && (raw.timeoutMs as number) > 0) config.timeoutMs = raw.timeoutMs as number;
	if (isPlainObject(raw.thresholds)) {
		const thresholds = raw.thresholds;
		for (const key of THRESHOLD_KEYS) {
			config.thresholds[key] = unitNumber(thresholds[key], DECIDER_DEFAULTS.thresholds[key]);
		}
		config.thresholds.complexityHigh = scoreNumber(
			thresholds.complexityHigh,
			DECIDER_DEFAULTS.thresholds.complexityHigh,
		);
	}
	return config;
}
