/**
 * Provider usage polling and a tolerant response parser.
 *
 * HTTP routes are polled generically (OpenCode Go's `/inference/go/v1/usage`
 * is the only documented live one); its response shape is not documented, so
 * the parser accepts common limit/used window shapes and returns the raw
 * payload when it cannot recognise one. Nothing is invented: an unrecognised
 * response is shown as such in the widget.
 *
 * Claude Code plan limits do not use HTTP. The `claude-usage` provider runs
 * the user's own CLI (`claude -p /usage --output-format json`) and parses the
 * session/week lines out of its `result` text. The CLI authenticates itself;
 * this module never reads ~/.claude or stores a token.
 */
import { spawn } from "node:child_process";

const WINDOWS = [
	{ key: "5h", label: "5h", aliases: ["5h", "5hr", "5hour", "5hours", "fivehour", "fivehours", "fivehourwindow", "hourly", "hour", "h5", "rolling5h", "rolling"] },
	{ key: "week", label: "Week", aliases: ["week", "weekly", "7d", "sevenday", "sevendays", "weeklywindow", "rollingweek"] },
	{ key: "month", label: "Month", aliases: ["month", "monthly", "30d", "billingperiod", "billingcycle", "period", "monthlywindow", "rollingmonth"] },
];

const USED_KEYS = ["used", "spent", "consumed", "usage", "current", "cost", "amount", "usedusd", "usedamount"];
const LIMIT_KEYS = ["limit", "max", "total", "allowance", "budget", "cap", "included", "limitusd", "totalusd"];
const REMAINING_KEYS = ["remaining", "left", "available", "balance", "remainingusd"];
const RESET_KEYS = ["resetat", "resetsat", "reset", "renewsat", "periodend", "end", "expiresat", "resettime"];
const PERCENT_KEYS = ["percent", "percentage", "usedpercent", "usagepercent", "pct"];
/**
 * Claude (and similar) payloads express a limit as a 0..1 fraction in
 * `utilization` rather than a 0..100 percent. A value of exactly 1 or below
 * is read as a fraction; a larger value is assumed to already be a percent.
 */
const FRACTION_PERCENT_KEYS = ["utilization", "utilisation", "usedfraction", "fraction", "ratio"];


/**
 * OpenDesign-style wallet fields. The live endpoint is not confirmed yet, so
 * these lists stay deliberately broad: a balance/credits number, a credits
 * container (`{credits: {used, limit}}`), or the same data under a
 * `data`/`billing`/`account`/`wallet` wrapper all parse.
 */
const CREDIT_SIGNAL_KEYS = [
	"balance",
	"credits",
	"credit",
	"funds",
	"remaining",
	"available",
	"left",
	"availablecredits",
	"creditbalance",
	"remainingcredits",
	"walletbalance",
	"balanceusd",
];
const CREDIT_AMOUNT_KEYS = [...CREDIT_SIGNAL_KEYS, "amount"];
// "amount" is a balance on a wallet node, so it must not be read as "used".
const CREDIT_USED_KEYS = USED_KEYS.filter((key) => key !== "amount");
const CREDIT_CONTAINER_KEYS = [
	...CREDIT_SIGNAL_KEYS,
	"billing",
	"account",
	"wallet",
	"data",
	"result",
	"payload",
	"response",
	"body",
	"details",
	"usage",
];
const CURRENCY_KEYS = ["currency", "currencycode", "unit", "denomination"];

function norm(key) {
	return String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function windowFor(key) {
	const n = norm(key);
	return WINDOWS.find((w) => w.aliases.includes(n));
}

function number(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
	return undefined;
}

/** Percent fields arrive as numbers, numeric strings, or "6%" strings. */
function percentNumber(value) {
	if (typeof value !== "string") return number(value);
	const text = value.trim().replace(/%$/, "").trim();
	if (text === "") return undefined;
	const n = Number(text);
	return Number.isFinite(n) ? n : undefined;
}

function pick(obj, keys) {
	if (!obj || typeof obj !== "object" || Array.isArray(obj)) return undefined;
	for (const [key, value] of Object.entries(obj)) {
		if (keys.includes(norm(key))) {
			const n = number(value);
			if (n !== undefined) return n;
		}
	}
	return undefined;
}

function pickPercent(obj) {
	if (!obj || typeof obj !== "object" || Array.isArray(obj)) return undefined;
	for (const [key, value] of Object.entries(obj)) {
		if (PERCENT_KEYS.includes(norm(key))) {
			const n = percentNumber(value);
			if (n !== undefined) return n;
		}
	}
	return undefined;
}

/**
 * A fractional `utilization` (0.42 -> 42). Values above 1 are assumed to be
 * percentages already, which keeps the parser tolerant of either spelling.
 */
function pickFractionPercent(obj) {
	if (!obj || typeof obj !== "object" || Array.isArray(obj)) return undefined;
	for (const [key, value] of Object.entries(obj)) {
		if (FRACTION_PERCENT_KEYS.includes(norm(key))) {
			const n = percentNumber(value);
			if (n === undefined) continue;
			return n <= 1 ? n * 100 : n;
		}
	}
	return undefined;
}

function pickDate(obj) {
	if (!obj || typeof obj !== "object" || Array.isArray(obj)) return undefined;
	for (const [key, value] of Object.entries(obj)) {
		if (!RESET_KEYS.includes(norm(key))) continue;
		if (typeof value === "string") {
			const ms = Date.parse(value);
			if (Number.isFinite(ms)) return ms;
		}
		const n = number(value);
		if (n !== undefined) return n < 1e12 ? n * 1000 : n;
	}
	return undefined;
}

function nested(obj, keys) {
	if (!obj || typeof obj !== "object" || Array.isArray(obj)) return undefined;
	for (const [key, value] of Object.entries(obj)) {
		if (keys.includes(norm(key)) && value && typeof value === "object") return value;
	}
	return undefined;
}

function stringField(obj, keys) {
	if (!obj || typeof obj !== "object" || Array.isArray(obj)) return undefined;
	for (const [key, value] of Object.entries(obj)) {
		if (!keys.includes(norm(key))) continue;
		if (typeof value === "string" && value.trim() !== "") return value.trim();
	}
	return undefined;
}

/** A payload currency wins over the provider's configured unit when present. */
function unitFrom(obj, fallback) {
	const raw = stringField(obj, CURRENCY_KEYS);
	if (!raw) return fallback;
	const n = norm(raw);
	if (n === "usd" || n === "dollar" || n === "dollars") return "USD";
	if (n === "credit" || n === "credits" || n === "cr") return "credits";
	return raw;
}

/**
 * Build a single credits window from one node. Numbers are only reported when
 * the payload supplies them; `used`/`remaining` are derived from each other
 * only when one side and `limit` are present.
 */
function creditsWindow(value, unit) {
	if (typeof value === "number" || (typeof value === "string" && number(value) !== undefined)) {
		const n = number(value);
		if (n === undefined) return null;
		return { key: "credits", label: "Credits", used: null, limit: null, remaining: n, percent: null, resetsAt: null, unit };
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const nodeUnit = unitFrom(value, unit);
	const explicitPercent = pickPercent(value) ?? pickFractionPercent(value);
	const nestedUsage = nested(value, ["usage", "spend", "cost"]);
	let used = pick(value, CREDIT_USED_KEYS);
	let limit = pick(value, LIMIT_KEYS);
	let remaining = pick(value, CREDIT_AMOUNT_KEYS);
	if (used === undefined && nestedUsage) used = pick(nestedUsage, CREDIT_USED_KEYS);
	if (limit === undefined) {
		const nestedLimit = nested(value, ["limit", "budget", "allowance"]);
		if (nestedLimit) limit = pick(nestedLimit, LIMIT_KEYS);
	}
	if (remaining === undefined && nestedUsage) remaining = pick(nestedUsage, REMAINING_KEYS);
	if (used === undefined && limit !== undefined && remaining !== undefined) used = limit - remaining;
	if (remaining === undefined && limit !== undefined && used !== undefined) remaining = limit - used;
	const givenPercent = explicitPercent ?? (nestedUsage ? (pickPercent(nestedUsage) ?? pickFractionPercent(nestedUsage)) : undefined);
	if (used === undefined && limit === undefined && remaining === undefined && givenPercent === undefined) return null;
	const computedPercent = limit !== undefined && limit > 0 && used !== undefined ? (used / limit) * 100 : null;
	const percent = givenPercent ?? computedPercent;
	const percentOnly = givenPercent !== undefined && used === undefined && limit === undefined && remaining === undefined;
	return {
		key: "credits",
		label: "Credits",
		used: used ?? null,
		limit: limit ?? null,
		remaining: remaining ?? null,
		percent,
		resetsAt: pickDate(value) ?? null,
		unit: percentOnly ? "%" : nodeUnit,
	};
}

/** Find one credits window in a direct, nested `{data}` or `{billing}` payload. */
function findCreditsWindow(payload, unit, depth = 0) {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
	if (depth > 4) return null;
	const nodeUnit = unitFrom(payload, unit);
	for (const [key, value] of Object.entries(payload)) {
		if (CREDIT_SIGNAL_KEYS.includes(norm(key)) && number(value) !== undefined) {
			return creditsWindow(payload, nodeUnit);
		}
	}
	for (const [key, value] of Object.entries(payload)) {
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;
		if (!CREDIT_CONTAINER_KEYS.includes(norm(key))) continue;
		const direct = creditsWindow(value, nodeUnit);
		if (direct) return direct;
		const deeper = findCreditsWindow(value, nodeUnit, depth + 1);
		if (deeper) return deeper;
	}
	return null;
}

/**
 * Parse a credits/balance payload into one window (or `null` when it carries
 * no credit field). Exported for the provider adapter and tests.
 */
export function parseCreditsPayload(payload, unit = "USD") {
	return findCreditsWindow(payload, unit);
}

function windowFrom(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	let used = pick(value, USED_KEYS);
	let limit = pick(value, LIMIT_KEYS);
	let remaining = pick(value, REMAINING_KEYS);
	const explicitPercent = pickPercent(value) ?? pickFractionPercent(value);
	const nestedUsage = nested(value, ["usage", "spend", "cost"]);
	const nestedLimit = nested(value, ["limit", "budget", "allowance"]);
	if (used === undefined && nestedUsage) used = pick(nestedUsage, USED_KEYS);
	if (limit === undefined && nestedLimit) limit = pick(nestedLimit, LIMIT_KEYS);
	if (remaining === undefined && nestedUsage) remaining = pick(nestedUsage, REMAINING_KEYS);
	if (used === undefined && limit !== undefined && remaining !== undefined) used = limit - remaining;
	const givenPercent = explicitPercent ?? (nestedUsage ? (pickPercent(nestedUsage) ?? pickFractionPercent(nestedUsage)) : undefined);
	if (used === undefined && limit === undefined && givenPercent === undefined) return null;
	const computedPercent = limit !== undefined && used !== undefined && limit > 0 ? (used / limit) * 100 : null;
	// An explicit percent from the endpoint always wins over used/limit maths.
	const percent = givenPercent ?? computedPercent;
	const percentOnly = givenPercent !== undefined && used === undefined && limit === undefined;
	return {
		used: used ?? null,
		limit: limit ?? null,
		remaining: remaining ?? (limit !== undefined && used !== undefined ? limit - used : null),
		percent,
		resetsAt: pickDate(value) ?? null,
		unit: percentOnly ? "%" : undefined,
	};
}

/**
 * A `rate_limits` entry may name its own window instead of being keyed by
 * one: `{ window: "five_hour", utilization: 0.42 }`.
 */
function namedWindow(item) {
	if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
	const KEYS = ["window", "windowtype", "name", "type", "period", "key", "id"];
	for (const [key, value] of Object.entries(item)) {
		if (!KEYS.includes(norm(key)) || typeof value !== "string") continue;
		const w = windowFor(value);
		if (w) return w;
	}
	return undefined;
}

function collect(node, out, depth = 0) {
	if (!node || typeof node !== "object" || depth > 5) return;
	if (Array.isArray(node)) {
		for (const item of node) {
			const named = namedWindow(item);
			if (named) {
				const parsed = windowFrom(item);
				if (parsed) {
					out.set(named.key, { ...named, ...parsed });
					continue;
				}
			}
			collect(item, out, depth + 1);
		}
		return;
	}
	for (const [key, value] of Object.entries(node)) {
		const w = windowFor(key);
		if (w && value && typeof value === "object") {
			const parsed = windowFrom(value);
			if (parsed) out.set(w.key, { ...w, ...parsed });
			else collect(value, out, depth + 1);
			continue;
		}
		if (value && typeof value === "object") collect(value, out, depth + 1);
	}
}

const WINDOW_ORDER = new Map(WINDOWS.map((w, index) => [w.key, index]));

function finalizeWindows(out, unit) {
	return [...out.values()]
		.sort((a, b) => (WINDOW_ORDER.get(a.key) ?? WINDOWS.length) - (WINDOW_ORDER.get(b.key) ?? WINDOWS.length))
		.map((w) => ({
			key: w.key,
			label: w.label,
			used: w.used,
			limit: w.limit,
			remaining: w.remaining,
			resetsAt: w.resetsAt,
			resetText: w.resetText ?? null,
			unit: w.unit ?? unit,
			percent: w.percent === null || w.percent === undefined ? null : Math.max(0, Math.min(100, w.percent)),
		}));
}

/** Parse one provider payload into window rows. Empty means unrecognised. */
export function parseUsagePayload(payload, unit = "USD") {
	const out = new Map();
	collect(payload, out);
	// A credits/balance payload has no period windows; keep both when a shape
	// happens to carry a billing period and a wallet balance together.
	const credits = parseCreditsPayload(payload, unit);
	if (credits) out.set(credits.key, credits);
	if (out.size === 0) {
		const flat = windowFrom(payload);
		if (flat) out.set("current", { key: "current", label: "Current", ...flat });
	}
	return finalizeWindows(out, unit);
}

const CLAUDE_WINDOW_KEYS = new Set(["5h", "week", "month"]);

/**
 * Claude Code plan windows from a JSON payload: `five_hour`/`seven_day`/
 * `weekly`, optionally under a `rate_limits` object or array, with a
 * fractional `utilization`, `resets_at`, `used`, `limit` or `remaining`.
 *
 * The live shape is still being researched; the shared walker already
 * normalises each of those spellings, so a confirmed payload fits without a
 * rewrite here. The CLI text path below is what the provider uses today.
 */
export function parseClaudeUsagePayload(payload, unit = "") {
	const out = new Map();
	collect(payload, out);
	for (const key of [...out.keys()]) {
		if (!CLAUDE_WINDOW_KEYS.has(key)) out.delete(key);
	}
	return finalizeWindows(out, unit);
}

function snippet(payload) {
	try {
		const text = JSON.stringify(payload);
		return text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
	} catch {
		return "";
	}
}

async function resolveKey(provider, env, credentials) {
	if (!provider.apiKeyEnv) return undefined;
	const direct = env[provider.apiKeyEnv];
	if (typeof direct === "string" && direct.trim() !== "") return direct;
	if (credentials && typeof credentials.resolve === "function") {
		try {
			const hit = await credentials.resolve(provider.apiKeyEnv);
			if (hit && typeof hit.value === "string" && hit.value !== "") return hit.value;
		} catch {
			// A missing credential store is reported by the caller as no-key.
		}
	}
	return undefined;
}


/** Parse the human `result` text of `claude -p /usage`. */
async function pollHttp(provider, { env, credentials, fetchImpl, timeoutMs, now }) {
	if (!provider.usageUrl) {
		return {
			id: provider.id,
			label: provider.label,
			status: "no-endpoint",
			message: provider.message || "No usage endpoint configured. Set usageUrl for this provider.",
			windows: [],
			polledAt: now(),
		};
	}
	const key = await resolveKey(provider, env, credentials);
	if (provider.apiKeyEnv && !key) {
		return { id: provider.id, label: provider.label, status: "no-key", message: `No credential in ${provider.apiKeyEnv}.`, windows: [], polledAt: now() };
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const headers = { accept: "application/json", "user-agent": "harness-usage/0.1" };
		if (key) headers.authorization = `Bearer ${key}`;
		const res = await fetchImpl(provider.usageUrl, { method: "GET", headers, signal: controller.signal });
		const text = await res.text();
		let payload;
		try {
			payload = text ? JSON.parse(text) : {};
		} catch {
			payload = { text: text.slice(0, 4000) };
		}
		if (res.status === 401 || res.status === 403) {
			return { id: provider.id, label: provider.label, status: "unauthorized", message: `HTTP ${res.status} from the usage endpoint.`, windows: [], polledAt: now() };
		}
		if (res.status === 429) {
			return { id: provider.id, label: provider.label, status: "rate-limited", message: "HTTP 429 from the usage endpoint.", windows: [], polledAt: now() };
		}
		if (!res.ok) {
			return { id: provider.id, label: provider.label, status: "error", message: `HTTP ${res.status} from the usage endpoint.`, windows: [], polledAt: now() };
		}
		const windows = parseUsagePayload(payload, provider.unit ?? "USD");
		return {
			id: provider.id,
			label: provider.label,
			status: windows.length ? "ok" : "unrecognized",
			message: windows.length ? undefined : "The usage endpoint answered, but no limit/used window was recognised.",
			windows,
			raw: snippet(payload),
			polledAt: now(),
		};
	} catch (e) {
		return {
			id: provider.id,
			label: provider.label,
			status: "unreachable",
			message: e instanceof Error ? e.message : String(e),
			windows: [],
			polledAt: now(),
		};
	} finally {
		clearTimeout(timer);
	}
}

/**
 * The Claude Code CLI's own local `/usage` command. It authenticates itself;
 * this plugin never reads the Claude Code credential files and no HTTP usage
 * endpoint is assumed.
 */
export const CLAUDE_USAGE_ARGS = ["-p", "/usage", "--output-format", "json", "--no-session-persistence"];

/** Parse a whole JSON envelope, or the last JSON line in mixed output. */
function parseJsonEnvelope(text) {
	const trimmed = String(text ?? "").trim();
	if (trimmed === "") return null;
	const tryParse = (value) => {
		try {
			const parsed = JSON.parse(value);
			return parsed && typeof parsed === "object" ? parsed : null;
		} catch {
			return null;
		}
	};
	const whole = tryParse(trimmed);
	if (whole) return whole;
	for (const line of trimmed.split("\n").reverse()) {
		const parsed = tryParse(line.trim());
		if (parsed) return parsed;
	}
	return null;
}

/** The envelope printed by `claude -p /usage --output-format json`. */
export function parseClaudeUsageEnvelope(stdout) {
	return parseJsonEnvelope(stdout);
}

/**
 * A reset date is shown as text; an epoch is added only when the text itself
 * parses. The CLI prints a zone suffix such as `(Asia/Manila)` and often no
 * year, so an unparsable suffix is kept as `resetText` and `resetsAt` stays
 * null rather than guessing a date.
 */
function parseResetEpoch(text) {
	const candidates = [text, text.replace(/\s+\([^)]*\)\s*$/, "").replace(/\s+at\s+/i, " ").trim()];
	for (const candidate of candidates) {
		const ms = Date.parse(candidate);
		if (Number.isFinite(ms)) return ms;
	}
	return null;
}

/** Read one "Current session: 13% used · resets ..." line into a window. */
function claudeWindowFromLine(line) {
	const text = line.trim();
	const match = /^current\s+(session|week|5[\s-]?h(?:our)?s?|7[\s-]?d(?:ay)?s?)\b[^:]*:\s*([\d.]+)\s*%/i.exec(text);
	if (!match) return null;
	const kind = match[1].toLowerCase().replace(/[\s-]/g, "");
	const isWeek = kind === "week" || kind === "7d" || kind === "7day" || kind === "7days";
	const percent = Number(match[2]);
	if (!Number.isFinite(percent)) return null;
	const reset = /resets?\b(.*)$/i.exec(text);
	const resetText = reset ? reset[1].replace(/^[\s\u00b7:]+/, "").trim() : "";
	return {
		key: isWeek ? "week" : "5h",
		label: isWeek ? "Week" : "5h",
		used: null,
		limit: null,
		remaining: null,
		resetsAt: resetText ? parseResetEpoch(resetText) : null,
		resetText: resetText || null,
		unit: "%",
		percent: Math.max(0, Math.min(100, percent)),
	};
}

/** Parse the CLI `result` text into 5h/week windows; empty means unrecognised. */
export function parseClaudeUsageText(text) {
	const out = new Map();
	for (const line of String(text ?? "").split(/\r?\n/)) {
		const window = claudeWindowFromLine(line);
		if (!window) continue;
		// The "(all models)" line wins over a model-specific duplicate.
		if (out.has(window.key) && !/all\s+models/i.test(line)) continue;
		out.set(window.key, window);
	}
	return finalizeWindows(out, "%");
}

function runClaudeCommand(command, { spawnImpl, timeoutMs, env }) {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		let timedOut = false;
		let timer;
		const finish = (code, error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ code, error, timedOut, stdout, stderr });
		};
		let proc;
		try {
			proc = spawnImpl(command, CLAUDE_USAGE_ARGS, { shell: false, stdio: ["ignore", "pipe", "pipe"], env });
		} catch (e) {
			finish(null, e);
			return;
		}
		if (timeoutMs > 0) {
			timer = setTimeout(() => {
				timedOut = true;
				proc.kill("SIGTERM");
				setTimeout(() => proc.kill("SIGKILL"), 2000).unref?.();
				finish(null, new Error(`claude /usage timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			if (timer.unref) timer.unref();
		}
		proc.on("error", (e) => finish(null, e));
		proc.on("close", (code) => finish(code));
		proc.stdout?.on("data", (d) => {
			stdout += d.toString();
			if (stdout.length > 1_000_000) stdout = stdout.slice(-500_000);
		});
		proc.stderr?.on("data", (d) => {
			stderr += d.toString();
			if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
		});
	});
}

/**
 * Poll Claude Code plan limits through the user's own CLI. A failure reports
 * `error` with the CLI message; output without a recognisable window reports
 * `unrecognized` and keeps a snippet of the text for the settings page.
 */
async function pollClaude(provider, { spawnImpl = spawn, timeoutMs, env, now }) {
	const base = { id: provider.id, label: provider.label, windows: [], polledAt: now() };
	const command = provider.claudeCommand || "claude";
	const result = await runClaudeCommand(command, { spawnImpl, timeoutMs, env });
	if (result.error) {
		return { ...base, status: "error", message: `claude /usage failed: ${result.error.message}` };
	}
	if (result.code !== 0) {
		const detail = result.stderr.trim().split("\n").filter(Boolean).slice(-1)[0];
		return { ...base, status: "error", message: `claude /usage exited ${result.code}${detail ? `: ${detail}` : ""}` };
	}
	const envelope = parseClaudeUsageEnvelope(result.stdout);
	if (envelope?.is_error === true) {
		const detail = typeof envelope.result === "string" ? envelope.result.slice(0, 400) : "claude reported an error";
		return { ...base, status: "error", message: `claude /usage: ${detail}` };
	}
	const text = typeof envelope?.result === "string" ? envelope.result : result.stdout;
	let windows = parseClaudeUsageText(text);
	// A future CLI may print structured windows instead of text; the tolerant
	// JSON parser covers that without a rewrite.
	if (!windows.length && envelope) windows = parseClaudeUsagePayload(envelope);
	if (!windows.length) {
		return {
			...base,
			status: "unrecognized",
			message: "claude /usage answered, but no session/week limit was recognised.",
			raw: snippet(text || result.stdout),
		};
	}
	return { ...base, status: "ok", windows };
}

function pollProvider(provider, deps) {
	if (provider.kind === "claude-usage") return pollClaude(provider, { ...deps, timeoutMs: provider.timeoutMs ?? 30_000 });
	return pollHttp(provider, deps);
}

/** One poller with a cached last result. */
export function createUsagePoller({ providers, env = process.env, credentials, fetchImpl = fetch, spawnImpl = spawn, timeoutMs = 10_000, now = Date.now } = {}) {
	let last = { generatedAt: null, providers: [] };
	const poll = async () => {
		const results = await Promise.all(
			providers.map((provider) => pollProvider(provider, { env, credentials, fetchImpl, spawnImpl, timeoutMs, now })),
		);
		last = { generatedAt: new Date(now()).toISOString(), providers: results };
		return last;
	};
	return {
		poll,
		state: () => last,
	};
}
