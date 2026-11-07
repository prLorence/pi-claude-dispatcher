/** Default provider routes and their usage surfaces. */

export const DEFAULT_PROVIDERS = [
	{
		id: "opencode-go",
		label: "OpenCode Go",
		kind: "http",
		usageUrl: "https://opencode.ai/inference/go/v1/usage",
		apiKeyEnv: "OPENCODE_GO_API_KEY",
		unit: "USD",
	},
	{
		id: "opendesign-cloud",
		label: "OpenDesign Cloud",
		kind: "http",
		// Intentionally blank: OpenDesign exposes credits only to the web
		// console's cookie session, not to an API key. A configured usageUrl
		// (or a poller test) still exercises the same http path.
		usageUrl: "",
		message: "OpenDesign credits are console-only; an API key cannot read the balance.",
		apiKeyEnv: "OPENDESIGN_CLOUD_API_KEY",
		// Fallback only: a `currency` field in the response overrides this.
		unit: "USD",
	},
	{
		id: "claude-code",
		label: "Claude Code",
		// The Claude Code CLI reports its own plan limits headlessly:
		// `claude -p /usage --output-format json` prints the session and week
		// lines as text. No HTTP endpoint is known, the CLI authenticates
		// itself, and this plugin never reads ~/.claude or any token.
		kind: "claude-usage",
		claudeCommand: "claude",
		timeoutMs: 30_000,
	},
	{
		id: "mistral-subscription",
		label: "Mistral Subscription",
		// The Vibe sign-in (dsh-mistral-subscription) stores its API key as the
		// credential record `llm-pi-ai/mistral-subscription`, kind api-key. That
		// record is the subscription identity, so this source reads it directly
		// and never falls back to an environment variable.
		//
		// Mistral exposes no plan-usage route for this key (`/v1/usage` and
		// `/v1/usage_limits` are 404, `/v1/admin/usage` is admin-scoped, and the
		// console usage route does not exist). Its subscription limits are the
		// per-minute rate-limit headers on a minimal chat completion, so the
		// poller sends a one-token "ping" each interval; `whoami` supplies the
		// plan name. No usageUrl default is shipped; an explicit usageUrl
		// overrides the probe endpoint if one is ever needed.
		kind: "mistral-subscription",
		credentialRecord: "llm-pi-ai/mistral-subscription",
		unit: "",
	},
];

/** Merge user config over the defaults, keyed by provider id. */
export function mergeProviders(configured) {
	const list = Array.isArray(configured) ? configured : [];
	const byId = new Map(DEFAULT_PROVIDERS.map((p) => [p.id, { ...p }]));
	for (const item of list) {
		if (!item || typeof item !== "object" || typeof item.id !== "string") continue;
		byId.set(item.id, { ...(byId.get(item.id) ?? { id: item.id, label: item.id, kind: "http" }), ...item });
	}
	return [...byId.values()];
}
