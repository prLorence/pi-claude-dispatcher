/** Dispatch config: the same keys as .plans/config.json, never written. */
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_ROLES, mergeRoles } from "./roles.js";

/** The decider config is read and ignored: the decider is not ported. */
function deciderDefaults() {
	return {
		effort: "off",
		audit: "off",
		baseUrl: "https://openrouter.ai/api/v1",
		model: "google/gemini-3.1-pro",
		timeoutMs: 60000,
		escalate: false,
		thresholds: { approve: 0.7, hold: 0.5, dismiss: 0.35 },
	};
}

function loadDeciderConfig(raw) {
	const d = deciderDefaults();
	const o = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
	if (typeof o.effort === "string") d.effort = o.effort;
	if (typeof o.audit === "string") d.audit = o.audit;
	if (typeof o.baseUrl === "string") d.baseUrl = o.baseUrl;
	if (typeof o.model === "string") d.model = o.model;
	if (typeof o.escalate === "boolean") d.escalate = o.escalate;
	return d;
}

function cloneRoles(roles) {
	return Object.fromEntries(Object.entries(roles).map(([name, role]) => [name, { ...role }]));
}

export const DEFAULT_CONFIG = {
	model: "opencode-go/deepseek-v4.1-flash",
	thinking: "low",
	maxParallel: 3,
	timeoutMinutes: 20,
	// Bounds one `coding_subagent` call. A plan worker has stall detection and
	// timeoutMinutes; this ad-hoc tool had neither, so a wedged child held the
	// calling turn open until the provider's own default expired.
	codingTimeoutMinutes: 20,
	retries: 1,
	tools: [],
	piCommand: "pi",
	dshCommand: "dsh",
	dryRun: false,
	persistSessions: true,
	verifyTimeoutMinutes: 10,
	workerGuards: true,
	requirePlanAudit: false,
	claudeCommand: "claude",
	auditTimeoutMinutes: 20,
	// Which harness runs the plan-auditor: "claude" (default), "omp" or "dsh".
	// The agent definition is harness-neutral; this only picks the runtime.
	auditAgent: "claude",
	// Model for the omp/dsh auditors. Empty means the harness default.
	auditModel: "",
	ompCommand: "omp",
	projectRegistry: "",
	maxFilesPerTask: 10,
	maxTaskChars: 8000,
	roles: cloneRoles(DEFAULT_ROLES),
	pairDefault: "",
	maxRunsPerTask: 8,
	transientRetries: 6,
	backoffSeconds: [15, 30, 60, 120, 300, 300],
	stallMinutes: 3,
	outagePauseMinutes: 30,
	probeSeconds: 30,
	probeUrls: ["https://openrouter.ai", "https://opencode.ai"],
	decider: deciderDefaults(),
	/** Optional model price table in dollars per million tokens, keyed by model id. */
	prices: {},
};

function numberOr(value, fallback, ok = (n) => n >= 0) {
	return typeof value === "number" && Number.isFinite(value) && ok(value) ? value : fallback;
}
function numbersOr(value, fallback) {
	if (!Array.isArray(value)) return [...fallback];
	if (!value.every((v) => typeof v === "number" && Number.isFinite(v) && v > 0)) return [...fallback];
	return [...value];
}
function stringsOr(value, fallback) {
	if (!Array.isArray(value)) return [...fallback];
	if (!value.every((v) => typeof v === "string" && v.length > 0)) return [...fallback];
	return [...value];
}

export function getDirs(cwd) {
	const root = path.join(cwd, ".plans");
	return {
		root,
		inbox: path.join(root, "inbox"),
		running: path.join(root, "running"),
		done: path.join(root, "done"),
		failed: path.join(root, "failed"),
		specs: path.join(root, "specs"),
		decisions: path.join(root, "decisions"),
		traces: path.join(root, "traces"),
		sessions: path.join(root, "sessions"),
	};
}

export function ensureDirs(d) {
	for (const p of Object.values(d)) fs.mkdirSync(p, { recursive: true });
}

export function loadConfig(d) {
	const file = path.join(d.root, "config.json");
	let raw;
	try {
		raw = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return { ...DEFAULT_CONFIG, roles: cloneRoles(DEFAULT_ROLES), decider: deciderDefaults() };
	}
	const cfg = { ...DEFAULT_CONFIG, ...raw, roles: mergeRoles(raw?.roles) };
	cfg.decider = loadDeciderConfig(raw?.decider);
	cfg.transientRetries = numberOr(raw?.transientRetries, DEFAULT_CONFIG.transientRetries, (n) => Number.isInteger(n) && n >= 0);
	cfg.backoffSeconds = numbersOr(raw?.backoffSeconds, DEFAULT_CONFIG.backoffSeconds);
	cfg.stallMinutes = numberOr(raw?.stallMinutes, DEFAULT_CONFIG.stallMinutes, (n) => n >= 0);
	cfg.codingTimeoutMinutes = numberOr(raw?.codingTimeoutMinutes, DEFAULT_CONFIG.codingTimeoutMinutes, (n) => n > 0);
	cfg.outagePauseMinutes = numberOr(raw?.outagePauseMinutes, DEFAULT_CONFIG.outagePauseMinutes, (n) => n > 0);
	cfg.probeSeconds = numberOr(raw?.probeSeconds, DEFAULT_CONFIG.probeSeconds, (n) => n > 0);
	cfg.probeUrls = stringsOr(raw?.probeUrls, DEFAULT_CONFIG.probeUrls);
	cfg.pairDefault = typeof raw?.pairDefault === "string" ? raw.pairDefault.trim() : "";
	// dsh-only pair default; the Pi preflight ignores this key, so an omp role
	// can be selected without making the shared preflight reject it.
	if (typeof raw?.dshPairDefault === "string") cfg.pairDefault = raw.dshPairDefault.trim();
	cfg.prices = raw?.prices && typeof raw.prices === "object" && !Array.isArray(raw.prices) ? raw.prices : {};
	return cfg;
}

/** Price in USD for a token count, from a {in,out} per-million table; undefined when unknown. */
export function costOf(cfg, model, input, output) {
	const entry = cfg?.prices?.[model];
	if (!entry || typeof entry.in !== "number" || typeof entry.out !== "number") return undefined;
	return (input * entry.in + output * entry.out) / 1_000_000;
}
