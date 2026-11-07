import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	createUsagePoller,
	parseClaudeUsagePayload,
	parseClaudeUsageText,
	parseUsagePayload,
} from "../plugins/harness-usage/usage.js";
import { mergeProviders, DEFAULT_PROVIDERS } from "../plugins/harness-usage/provider-defaults.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLAUDE_FIXTURE = path.resolve(HERE, "..", "fixtures", "fake-claude-usage");

function fakeClaudeUsage() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-usage-"));
	const command = path.join(dir, "claude");
	fs.copyFileSync(CLAUDE_FIXTURE, command);
	fs.chmodSync(command, 0o755);
	return { dir, command, log: path.join(dir, "calls.jsonl") };
}


test("parses a direct 5h/week/month payload", () => {
	const windows = parseUsagePayload({
		five_hour: { used: 1, limit: 5 },
		week: { used: 10, limit: 50 },
		month: { used: 20, limit: 100 },
	});
	assert.deepEqual(windows.map((w) => w.key), ["5h", "week", "month"]);
	assert.equal(windows[0].percent, 20);
	assert.equal(windows[2].percent, 20);
	assert.equal(windows[0].unit, "USD");
});

test("parses nested aliases, remaining and reset dates", () => {
	const windows = parseUsagePayload({
		data: {
			usage: {
				weekly: { remaining: 30, total: 50, resetsAt: "2026-11-10T00:00:00Z" },
				monthly: { spent: 25, allowance: 100 },
			},
		},
	});
	assert.equal(windows.length, 2);
	const week = windows.find((w) => w.key === "week");
	assert.equal(week.used, 20);
	assert.equal(week.remaining, 30);
	assert.equal(week.limit, 50);
	assert.equal(week.resetsAt, Date.parse("2026-11-10T00:00:00Z"));
});

test("parses the live OpenCode Go rolling/weekly/monthly percent payload", () => {
	const payload = JSON.parse(
		'{"usage":{"rolling":{"status":"ok","percent":6,"resetsAt":"2026-11-04T20:38:18.000Z"},"weekly":{"status":"ok","percent":7,"resetsAt":"2026-11-09T00:00:00.000Z"},"monthly":{"status":"ok","percent":4,"resetsAt":"2026-12-01T10:11:53.000Z"}}}',
	);
	const windows = parseUsagePayload(payload);
	assert.deepEqual(windows.map((w) => w.key), ["5h", "week", "month"]);
	assert.deepEqual(windows.map((w) => w.label), ["5h", "Week", "Month"]);
	assert.deepEqual(windows.map((w) => w.percent), [6, 7, 4]);
	assert.deepEqual(windows.map((w) => w.unit), ["%", "%", "%"]);
	assert.deepEqual(windows.map((w) => w.resetsAt), [
		Date.parse("2026-11-04T20:38:18.000Z"),
		Date.parse("2026-11-09T00:00:00.000Z"),
		Date.parse("2026-12-01T10:11:53.000Z"),
	]);
	assert.equal(windows.every((w) => Number.isInteger(w.resetsAt)), true);
});

test("usage.rolling alone maps the rolling alias to the 5h window", () => {
	const windows = parseUsagePayload({
		usage: { rolling: { status: "ok", percent: 6, resetsAt: "2026-11-04T20:38:18.000Z" } },
	});
	assert.equal(windows.length, 1);
	assert.equal(windows[0].key, "5h");
	assert.equal(windows[0].label, "5h");
	assert.equal(windows[0].percent, 6);
	assert.equal(windows[0].unit, "%");
	assert.equal(windows[0].resetsAt, Date.parse("2026-11-04T20:38:18.000Z"));
});

test("an explicit percent wins over the used/limit percent", () => {
	const windows = parseUsagePayload({ five_hour: { used: 1, limit: 5, percent: 42 } });
	assert.equal(windows.length, 1);
	assert.equal(windows[0].percent, 42);
	assert.equal(windows[0].used, 1);
	assert.equal(windows[0].limit, 5);
	assert.equal(windows[0].remaining, 4);
	assert.equal(windows[0].unit, "USD");
});

test("the old used/limit payload still computes percents and remaining", () => {
	const windows = parseUsagePayload({
		five_hour: { used: 2, limit: 8 },
		weekly: { used: 5, limit: 20 },
		monthly: { used: 9, limit: 30 },
	});
	assert.deepEqual(windows.map((w) => w.key), ["5h", "week", "month"]);
	assert.deepEqual(windows.map((w) => w.percent), [25, 25, 30]);
	assert.deepEqual(windows.map((w) => w.remaining), [6, 15, 21]);
	assert.deepEqual(windows.map((w) => w.unit), ["USD", "USD", "USD"]);
});

test("percent strings and out-of-order windows are normalised", () => {
	const windows = parseUsagePayload({
		usage: { monthly: { percent: "4%" }, weekly: { percent: " 7 " }, rolling: { percent: 6 } },
	});
	assert.deepEqual(windows.map((w) => w.key), ["5h", "week", "month"]);
	assert.deepEqual(windows.map((w) => w.percent), [6, 7, 4]);
	assert.deepEqual(windows.map((w) => w.unit), ["%", "%", "%"]);
});

test("an unrecognised payload returns no windows instead of inventing one", () => {
	assert.deepEqual(parseUsagePayload({ hello: "world" }), []);
	assert.deepEqual(parseUsagePayload({ data: { hello: "world" } }), []);
	assert.deepEqual(parseUsagePayload(null), []);
});

test("parses an OpenDesign direct balance payload without inventing a limit", () => {
	const windows = parseUsagePayload({ balance: 12.5, currency: "USD" });
	assert.equal(windows.length, 1);
	const credits = windows[0];
	assert.equal(credits.key, "credits");
	assert.equal(credits.label, "Credits");
	assert.equal(credits.remaining, 12.5);
	assert.equal(credits.used, null);
	assert.equal(credits.limit, null);
	assert.equal(credits.percent, null);
	assert.equal(credits.unit, "USD");

	const wrapped = parseUsagePayload({ balance: { amount: 12.5, currency: "USD" } });
	assert.equal(wrapped.length, 1);
	assert.equal(wrapped[0].used, null);
	assert.equal(wrapped[0].remaining, 12.5);
	assert.equal(wrapped[0].unit, "USD");
});

test("parses an OpenDesign credits container with used and limit", () => {
	const windows = parseUsagePayload({ credits: { used: 3, limit: 10 } });
	assert.equal(windows.length, 1);
	const credits = windows[0];
	assert.equal(credits.key, "credits");
	assert.equal(credits.label, "Credits");
	assert.equal(credits.used, 3);
	assert.equal(credits.limit, 10);
	assert.equal(credits.remaining, 7);
	assert.equal(credits.percent, 30);
});

test("parses nested credits under data and billing wrappers", () => {
	const windows = parseUsagePayload({
		data: { billing: { credits: { used: 3, limit: 10, currency: "EUR", resetAt: "2026-12-01T00:00:00Z" } } },
	});
	assert.equal(windows.length, 1);
	const credits = windows[0];
	assert.equal(credits.used, 3);
	assert.equal(credits.limit, 10);
	assert.equal(credits.remaining, 7);
	assert.equal(credits.percent, 30);
	assert.equal(credits.unit, "EUR");
	assert.equal(credits.resetsAt, Date.parse("2026-12-01T00:00:00Z"));
});

test("the OpenDesign Cloud default provider reports no-endpoint while blank", async () => {
	const provider = DEFAULT_PROVIDERS.find((p) => p.id === "opendesign-cloud");
	assert.equal(provider.usageUrl, "");
	const poller = createUsagePoller({
		providers: [provider],
		env: {},
		fetchImpl: async () => {
			throw new Error("the blank endpoint must not be fetched");
		},
	});
	const result = (await poller.poll()).providers[0];
	assert.equal(result.status, "no-endpoint");
	assert.deepEqual(result.windows, []);
	assert.match(result.message, /console-only|cannot read/);
});

test("the poller reports no-key, errors, unrecognised payloads and success", async () => {
	const providers = [{ id: "x", label: "X", kind: "http", usageUrl: "http://usage.test", apiKeyEnv: "X_KEY", unit: "USD" }];
	const env = {};
	const noKey = createUsagePoller({ providers, env, fetchImpl: async () => ({ ok: true, status: 200, text: async () => "{}" }) });
	assert.equal((await noKey.poll()).providers[0].status, "no-key");

	const withKey = { X_KEY: "secret-value" };
	const fetcher = async (url, opts) => {
		assert.equal(url, "http://usage.test");
		assert.equal(opts.headers.authorization, "Bearer secret-value");
		return { ok: true, status: 200, text: async () => JSON.stringify({ five_hour: { used: 1, limit: 5 } }) };
	};
	const good = createUsagePoller({ providers, env: withKey, fetchImpl: fetcher });
	const state = await good.poll();
	assert.equal(state.providers[0].status, "ok");
	assert.equal(state.providers[0].windows.length, 1);
	assert.equal(JSON.stringify(state).includes("secret-value"), false);

	const unauthorized = createUsagePoller({ providers, env: withKey, fetchImpl: async () => ({ ok: false, status: 401, text: async () => "{}" }) });
	assert.equal((await unauthorized.poll()).providers[0].status, "unauthorized");

	const unknown = createUsagePoller({ providers, env: withKey, fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ hello: 1 }) }) });
	assert.equal((await unknown.poll()).providers[0].status, "unrecognized");
});

test("the poller resolves a key through the credential seam without returning it", async () => {
	const providers = [{ id: "x", label: "X", kind: "http", usageUrl: "http://usage.test", apiKeyEnv: "X_KEY", unit: "USD" }];
	const credentials = { resolve: async (ref) => (ref === "X_KEY" ? { value: "from-store" } : undefined) };
	const poller = createUsagePoller({
		providers,
		env: {},
		credentials,
		fetchImpl: async (_url, opts) => {
			assert.equal(opts.headers.authorization, "Bearer from-store");
			return { ok: true, status: 200, text: async () => JSON.stringify({ five_hour: { used: 1, limit: 5 } }) };
		},
	});
	const state = await poller.poll();
	assert.equal(state.providers[0].status, "ok");
	assert.equal(JSON.stringify(state).includes("from-store"), false);
});

test("the poller reports a provider with no usage URL", async () => {
	const providers = [{ id: "y", label: "Y", kind: "http", usageUrl: "", unit: "USD" }];
	const poller = createUsagePoller({ providers, fetchImpl: async () => ({ ok: true, status: 200, text: async () => "{}" }) });
	assert.equal((await poller.poll()).providers[0].status, "no-endpoint");
});

test("provider defaults merge by id", () => {
	const merged = mergeProviders([{ id: "opencode-go", label: "Go custom", usageUrl: "http://x" }]);
	assert.equal(merged.length, DEFAULT_PROVIDERS.length);
	assert.equal(merged.some((p) => p.id === "opencode-zen"), false);
	const go = merged.find((p) => p.id === "opencode-go");
	assert.equal(go.label, "Go custom");
	assert.equal(go.apiKeyEnv, "OPENCODE_GO_API_KEY");
});

test("the Claude Code default provider is a CLI provider with no endpoint or secret", () => {
	const provider = DEFAULT_PROVIDERS.find((p) => p.id === "claude-code");
	assert.equal(provider.label, "Claude Code");
	assert.equal(provider.kind, "claude-usage");
	assert.equal(provider.claudeCommand, "claude");
	assert.equal(provider.usageUrl, undefined);
	assert.equal(provider.apiKeyEnv, undefined);
});

test("the claude-usage provider parses the CLI session and week windows", async () => {
	const f = fakeClaudeUsage();
	try {
		const provider = DEFAULT_PROVIDERS.find((p) => p.id === "claude-code");
		const poller = createUsagePoller({
			providers: [{ ...provider, claudeCommand: f.command }],
			env: { ...process.env, FAKE_CLAUDE_USAGE_LOG: f.log },
			now: () => Date.parse("2026-11-05T12:00:00.000Z"),
		});
		const result = (await poller.poll()).providers[0];
		assert.equal(result.status, "ok");
		assert.deepEqual(result.windows.map((w) => w.key), ["5h", "week"]);
		assert.deepEqual(result.windows.map((w) => w.label), ["5h", "Week"]);
		assert.deepEqual(result.windows.map((w) => w.percent), [13, 50]);
		assert.deepEqual(result.windows.map((w) => w.unit), ["%", "%"]);
		assert.deepEqual(result.windows.map((w) => w.used), [null, null]);
		assert.deepEqual(result.windows.map((w) => w.limit), [null, null]);
		// The CLI prints a zone suffix and no year for the session reset, so it
		// is kept as text; the ISO week reset also yields an epoch.
		assert.equal(result.windows[0].resetText, "Nov 5 at 8:09pm (Asia/Manila)");
		assert.equal(result.windows[0].resetsAt, null);
		assert.equal(result.windows[1].resetsAt, Date.parse("2026-11-09T13:59:00.000Z"));
		const args = JSON.parse(fs.readFileSync(f.log, "utf8").trim());
		assert.deepEqual(args, ["-p", "/usage", "--output-format", "json", "--no-session-persistence"]);
	} finally {
		fs.rmSync(f.dir, { recursive: true, force: true });
	}
});

test("the claude-usage provider reports the CLI failure as an error", async () => {
	const f = fakeClaudeUsage();
	try {
		const provider = { id: "claude-code", label: "Claude Code", kind: "claude-usage", claudeCommand: f.command };
		const exited = createUsagePoller({
			providers: [provider],
			env: { ...process.env, FAKE_CLAUDE_USAGE_MODE: "error" },
		});
		const failed = (await exited.poll()).providers[0];
		assert.equal(failed.status, "error");
		assert.match(failed.message, /exited 1|not logged in/);
		assert.deepEqual(failed.windows, []);

		const envelope = createUsagePoller({
			providers: [provider],
			env: { ...process.env, FAKE_CLAUDE_USAGE_MODE: "is-error" },
		});
		const flagged = (await envelope.poll()).providers[0];
		assert.equal(flagged.status, "error");
		assert.match(flagged.message, /login/);
	} finally {
		fs.rmSync(f.dir, { recursive: true, force: true });
	}
});

test("the claude-usage provider reports unrecognised CLI text instead of inventing a window", async () => {
	const f = fakeClaudeUsage();
	try {
		const poller = createUsagePoller({
			providers: [{ id: "claude-code", label: "Claude Code", kind: "claude-usage", claudeCommand: f.command }],
			env: { ...process.env, FAKE_CLAUDE_USAGE_MODE: "garbage" },
		});
		const result = (await poller.poll()).providers[0];
		assert.equal(result.status, "unrecognized");
		assert.deepEqual(result.windows, []);
		assert.match(result.raw, /No usage data/);
	} finally {
		fs.rmSync(f.dir, { recursive: true, force: true });
	}
});

test("parses Claude /usage text into 5h and week windows", () => {
	const windows = parseClaudeUsageText(
		[
			"Current session: 13% used · resets 2026-11-05T12:09:00.000Z",
			"Current week (all models): 50% used · resets 2026-11-09T21:59:00.000Z",
		].join("\n"),
	);
	assert.deepEqual(windows.map((w) => w.key), ["5h", "week"]);
	assert.deepEqual(windows.map((w) => w.label), ["5h", "Week"]);
	assert.deepEqual(windows.map((w) => w.percent), [13, 50]);
	assert.equal(windows[0].resetsAt, Date.parse("2026-11-05T12:09:00.000Z"));
	assert.equal(windows[1].resetsAt, Date.parse("2026-11-09T21:59:00.000Z"));
	assert.deepEqual(parseClaudeUsageText("nothing to see"), []);
});

test("parses a Claude five_hour/seven_day payload with fractional utilization", () => {
	const windows = parseClaudeUsagePayload({
		five_hour: { utilization: 0.42, resets_at: "2026-11-05T12:09:00.000Z" },
		seven_day: { utilization: 0.1, resets_at: "2026-11-09T21:59:00.000Z" },
	});
	assert.deepEqual(windows.map((w) => w.key), ["5h", "week"]);
	assert.deepEqual(windows.map((w) => w.percent), [42, 10]);
	assert.deepEqual(windows.map((w) => w.unit), ["%", "%"]);
	assert.equal(windows[0].resetsAt, Date.parse("2026-11-05T12:09:00.000Z"));
	assert.equal(windows[1].percent, 10);
});

test("parses a Claude rate_limits array with named windows", () => {
	const windows = parseClaudeUsagePayload({
		rate_limits: [
			{ window: "five_hour", utilization: 0.42 },
			{ window: "seven_day", utilization: 0.1 },
		],
	});
	assert.deepEqual(windows.map((w) => w.key), ["5h", "week"]);
	assert.deepEqual(windows.map((w) => w.percent), [42, 10]);
	assert.deepEqual(windows.map((w) => w.unit), ["%", "%"]);
	assert.deepEqual(parseClaudeUsagePayload({ hello: "world" }), []);
});

test("the claude-usage provider fails cleanly when the claude command is missing", async () => {
	const poller = createUsagePoller({
		providers: [{ id: "claude-code", label: "Claude Code", kind: "claude-usage", claudeCommand: "/definitely/missing/claude" }],
		env: {},
	});
	const result = (await poller.poll()).providers[0];
	assert.equal(result.status, "error");
	assert.match(result.message, /failed/);
	assert.deepEqual(result.windows, []);
});

// --- Mistral subscription ------------------------------------------------------

function responseHeaders(map = {}) {
	const lower = {};
	for (const [key, value] of Object.entries(map)) lower[key.toLowerCase()] = String(value);
	return { get: (name) => lower[String(name).toLowerCase()] ?? null };
}

function httpResponse(status, payload, headerMap = {}) {
	const body = typeof payload === "string" ? payload : JSON.stringify(payload);
	return {
		ok: status >= 200 && status < 300,
		status,
		headers: responseHeaders(headerMap),
		text: async () => body,
		json: async () => (typeof payload === "string" ? JSON.parse(payload) : payload),
	};
}

const RATE_HEADERS = {
	"x-ratelimit-limit-tokens-minute": "500000",
	"x-ratelimit-remaining-tokens-minute": "499980",
	"x-ratelimit-tokens-query-cost": "17",
	"x-ratelimit-limit-req-minute": "1000",
	"x-ratelimit-remaining-req-minute": "990",
};
const MISTRAL_CHAT_URL = "https://api.mistral.ai/v1/chat/completions";
const MISTRAL_WHOAMI_URL = "https://console.mistral.ai/api/vibe/whoami";

function subscriptionProvider() {
	return DEFAULT_PROVIDERS.find((p) => p.id === "mistral-subscription");
}

function subscriptionCredentials(key = "record-secret") {
	return { readRecord: async () => ({ kind: "api-key", key }) };
}

test("Mistral subscription is a record-backed provider with no usage URL default", () => {
	const provider = subscriptionProvider();
	assert.ok(provider, "mistral-subscription must be a default provider");
	assert.equal(provider.kind, "mistral-subscription");
	assert.equal(provider.usageUrl, undefined);
	assert.equal(provider.credentialRecord, "llm-pi-ai/mistral-subscription");
	assert.equal(provider.apiKeyEnv, undefined);
	assert.equal(DEFAULT_PROVIDERS.some((p) => p.kind === "mistral-usage"), false);
});

test("the subscription poller maps rate-limit headers to windows and keeps the key out of state", async () => {
	let seenRecord;
	let method;
	let authorization;
	let body;
	const poller = createUsagePoller({
		providers: [subscriptionProvider()],
		// A decoy in the environment must never be used for a record provider.
		env: { MISTRAL_ADMIN_API_KEY: "env-decoy", MISTRAL_API_KEY: "env-decoy" },
		credentials: {
			readRecord: async (ref) => {
				seenRecord = ref;
				return { kind: "api-key", key: "record-secret" };
			},
		},
		fetchImpl: async (url, opts) => {
			if (url === MISTRAL_CHAT_URL) {
				method = opts.method;
				authorization = opts.headers.authorization;
				body = JSON.parse(opts.body);
				return httpResponse(200, { choices: [] }, RATE_HEADERS);
			}
			assert.equal(url, MISTRAL_WHOAMI_URL);
			return httpResponse(200, { plan_name: "EDU" });
		},
	});
	const result = (await poller.poll()).providers[0];
	assert.equal(seenRecord, "llm-pi-ai/mistral-subscription");
	assert.equal(method, "POST");
	assert.equal(authorization, "Bearer record-secret");
	assert.equal(body.model, "mistral-small-latest");
	assert.equal(body.max_tokens, 1);
	assert.deepEqual(body.messages, [{ role: "user", content: "ping" }]);
	assert.equal(result.status, "ok");
	assert.equal(result.detail, "EDU plan");
	const tokens = result.windows.find((w) => w.key === "tokens-minute");
	const requests = result.windows.find((w) => w.key === "req-minute");
	assert.ok(tokens && requests, "both rate-limit windows must be built");
	assert.equal(tokens.label, "Tokens");
	assert.equal(tokens.limit, 500000);
	assert.equal(tokens.used, 20);
	assert.equal(tokens.unit, "tok/min");
	assert.ok(Math.abs(tokens.percent - 0.004) < 1e-9);
	assert.equal(requests.label, "Requests");
	assert.equal(requests.limit, 1000);
	assert.equal(requests.used, 10);
	assert.equal(requests.unit, "req/min");
	assert.ok(Math.abs(requests.percent - 1) < 1e-9);
	const state = JSON.stringify(poller.state());
	assert.equal(state.includes("record-secret"), false);
	assert.equal(state.includes("env-decoy"), false);
});

test("the subscription poller tolerates a failing whoami call", async () => {
	const poller = createUsagePoller({
		providers: [subscriptionProvider()],
		credentials: subscriptionCredentials(),
		fetchImpl: async (url) => {
			if (url === MISTRAL_CHAT_URL) return httpResponse(200, { choices: [] }, RATE_HEADERS);
			throw new Error("whoami is down");
		},
	});
	const result = (await poller.poll()).providers[0];
	assert.equal(result.status, "ok");
	assert.equal(result.windows.length, 2);
	assert.equal(result.detail, undefined);
});

test("missing rate-limit headers fall back to one unknown window", async () => {
	const poller = createUsagePoller({
		providers: [subscriptionProvider()],
		credentials: subscriptionCredentials(),
		fetchImpl: async (url) => {
			if (url === MISTRAL_CHAT_URL) return httpResponse(200, { choices: [] });
			return httpResponse(200, { plan_name: "EDU" });
		},
	});
	const result = (await poller.poll()).providers[0];
	assert.equal(result.status, "ok");
	assert.equal(result.windows.length, 1);
	assert.equal(result.windows[0].key, "unknown");
	assert.equal(result.windows[0].used, null);
	assert.equal(result.windows[0].percent, null);
	assert.match(result.message, /no rate-limit headers/);
});

test("a partially stripped header set keeps only the complete window", async () => {
	const poller = createUsagePoller({
		providers: [subscriptionProvider()],
		credentials: subscriptionCredentials(),
		fetchImpl: async (url) => {
			if (url === MISTRAL_CHAT_URL) {
				return httpResponse(200, {}, { "x-ratelimit-limit-tokens-minute": "500000", "x-ratelimit-remaining-tokens-minute": "499980" });
			}
			return httpResponse(200, { plan_name: "EDU" });
		},
	});
	const result = (await poller.poll()).providers[0];
	assert.equal(result.status, "ok");
	assert.equal(result.windows.length, 1);
	assert.equal(result.windows[0].key, "tokens-minute");
	assert.equal(result.windows[0].used, 20);
});

test("a rejected subscription key is reported as unauthorized", async () => {
	let calls = 0;
	const poller = createUsagePoller({
		providers: [subscriptionProvider()],
		credentials: subscriptionCredentials(),
		fetchImpl: async () => {
			calls += 1;
			return httpResponse(401, { detail: "Invalid API Key" });
		},
	});
	const result = (await poller.poll()).providers[0];
	assert.equal(result.status, "unauthorized");
	assert.match(result.message, /rejected/);
	assert.match(result.message, /Sign in flow/);
	assert.equal(calls, 1, "whoami must not run after a rejected key");
});

test("a rate-limited probe reports the Retry-After value", async () => {
	const poller = createUsagePoller({
		providers: [subscriptionProvider()],
		credentials: subscriptionCredentials(),
		fetchImpl: async () => httpResponse(429, {}, { "retry-after": "7" }),
	});
	const result = (await poller.poll()).providers[0];
	assert.equal(result.status, "rate-limited");
	assert.match(result.message, /retry after 7/);
});

test("a 5xx inference probe is reported as unreachable", async () => {
	const poller = createUsagePoller({
		providers: [subscriptionProvider()],
		credentials: subscriptionCredentials(),
		fetchImpl: async () => httpResponse(503, {}),
	});
	const result = (await poller.poll()).providers[0];
	assert.equal(result.status, "unreachable");
	assert.match(result.message, /503/);
});

test("a subscription key in the environment alone is ignored", async () => {
	const poller = createUsagePoller({
		providers: [subscriptionProvider()],
		env: { MISTRAL_ADMIN_API_KEY: "env-only", MISTRAL_API_KEY: "env-only" },
		credentials: { readRecord: async () => undefined },
		fetchImpl: async () => {
			throw new Error("must not fetch without a record key");
		},
	});
	const result = (await poller.poll()).providers[0];
	assert.equal(result.status, "no-key");
	assert.match(result.message, /llm-pi-ai\/mistral-subscription/);
	assert.match(result.message, /Sign in/);
});

test("the subscription poller reports no-key when the credential store is unavailable", async () => {
	const poller = createUsagePoller({ providers: [subscriptionProvider()], env: {}, fetchImpl: async () => { throw new Error("must not fetch"); } });
	const result = (await poller.poll()).providers[0];
	assert.equal(result.status, "no-key");
	assert.match(result.message, /credential store is unavailable/);
});
