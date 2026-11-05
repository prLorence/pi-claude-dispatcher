/**
 * Host half of the usage widget: poll provider usage endpoints and serve
 * `/plugins/harness-usage/state` to the Client half.
 *
 * Credentials come from the named environment variable or the dsh credential
 * store; the key is never logged, returned, or written anywhere.
 */
import * as os from "node:os";
import * as path from "node:path";
import { createUsagePoller } from "./usage.js";
import { mergeProviders } from "./provider-defaults.js";

export const name = "harness-usage";

async function credentialState(credentials, ref) {
	if (!ref) return { configured: false, source: "none" };
	if (process.env[ref]) return { configured: true, source: "environment" };
	if (credentials && typeof credentials.describe === "function") {
		try {
			const info = await credentials.describe(ref);
			return { configured: info?.configured === true, source: info?.source ?? (info?.configured ? "credential store" : "none") };
		} catch {
			// Fall through to the missing state below.
		}
	}
	return { configured: false, source: "none" };
}
export const inject = ["webServer", "credentials"];

function dshHome() {
	const fromEnv = process.env.DSH_HOME;
	if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv;
	return path.join(os.homedir(), ".dsh");
}

export async function apply(ctx, config = {}) {
	const providers = mergeProviders(config.providers);
	const poller = createUsagePoller({
		providers,
		env: process.env,
		credentials: ctx.credentials,
		timeoutMs: config.timeoutMs ?? 10_000,
	});
	let refreshing = null;
	const refresh = () => {
		if (refreshing === null) {
			refreshing = poller.poll().finally(() => {
				refreshing = null;
			});
		}
		return refreshing;
	};
	void refresh().catch((e) => ctx.logger?.warn?.(`harness-usage: first poll failed: ${e instanceof Error ? e.message : String(e)}`));
	const timer = setInterval(() => {
		void refresh().catch((e) => ctx.logger?.warn?.(`harness-usage: poll failed: ${e instanceof Error ? e.message : String(e)}`));
	}, config.pollMs ?? 60_000);
	if (timer.unref) timer.unref();

	const dispose = ctx.webServer.register({
		kind: "exact",
		path: "/plugins/harness-usage/state",
		handler: async (req, res) => {
			if (req.method !== "GET" && req.method !== "HEAD") {
				res.writeHead(405, { allow: "GET, HEAD" });
				res.end();
				return;
			}
			try {
				await refresh();
			} catch {
				// The cached state is still served.
			}
			const body = JSON.stringify(poller.state());
			res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
			res.end(req.method === "HEAD" ? undefined : body);
		},
	});

	const configRoute = ctx.webServer.register({
		kind: "exact",
		path: "/plugins/harness-usage/config",
		handler: async (req, res) => {
			if (req.method !== "GET" && req.method !== "HEAD") {
				res.writeHead(405, { allow: "GET, HEAD" });
				res.end();
				return;
			}
			const rows = await Promise.all(
				providers.map(async (provider) => ({
					id: provider.id,
					label: provider.label,
					kind: provider.kind,
					usageUrl: provider.usageUrl ?? "",
					apiKeyEnv: provider.apiKeyEnv ?? "",
					unit: provider.unit ?? "",
					claudeCommand: provider.claudeCommand ?? "",
					timeoutMs: provider.timeoutMs ?? config.timeoutMs ?? 10_000,
					...(await credentialState(ctx.credentials, provider.apiKeyEnv)),
				})),
			);
			const body = JSON.stringify({
				providers: rows,
				pollMs: config.pollMs ?? 60_000,
				timeoutMs: config.timeoutMs ?? 10_000,
				endpoints: { state: "/plugins/harness-usage/state", config: "/plugins/harness-usage/config" },
			});
			res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
			res.end(req.method === "HEAD" ? undefined : body);
		},
	});

	return () => {
		clearInterval(timer);
		dispose?.();
		configRoute?.();
	};
}

export default { name, inject, apply };
