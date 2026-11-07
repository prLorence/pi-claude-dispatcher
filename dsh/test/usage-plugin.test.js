import { test } from "node:test";
import assert from "node:assert/strict";
import { apply } from "../plugins/harness-usage/index.js";

test("the usage plugin registers the state route and disposes it", async () => {
	const routes = [];
	const ctx = {
		webServer: {
			register(route) {
				routes.push(route);
				return () => {};
			},
		},
		credentials: {
			describe: async (ref) => ({ configured: ref === "X_KEY", source: ref === "X_KEY" ? "credential store" : undefined }),
			describeRecord: async (ref) => ({
				configured: ref === "scope/record-key",
				kind: ref === "scope/record-key" ? "api-key" : undefined,
				writable: true,
			}),
		},
		get: () => undefined,
		logger: { warn: () => {} },
	};
	const dispose = await apply(ctx, {
		providers: [
			{ id: "x", label: "X", kind: "http", usageUrl: "http://usage.test", apiKeyEnv: "X_KEY", unit: "USD" },
			{ id: "rec", label: "Record", kind: "http", usageUrl: "http://record.test", credentialRecord: "scope/record-key", unit: "%" },
		],
		pollMs: 1_000_000,
	});
	assert.deepEqual(routes.map((r) => `${r.kind} ${r.path}`), [
		"exact /plugins/harness-usage/state",
		"exact /plugins/harness-usage/config",
	]);
	let body;
	const configRoute = routes.find((r) => r.path.endsWith("/config"));
	await configRoute.handler(
		{ method: "GET" },
		{ writeHead() {}, end(value) { body = JSON.parse(value); } },
	);
	const x = body.providers.find((p) => p.id === "x");
	assert.equal(x.usageUrl, "http://usage.test");
	assert.equal(x.apiKeyEnv, "X_KEY");
	assert.equal(x.configured, true);
	assert.equal(x.source, "credential store");
	const rec = body.providers.find((p) => p.id === "rec");
	assert.equal(rec.credentialRecord, "scope/record-key");
	assert.equal(rec.apiKeyEnv, "");
	assert.equal(rec.configured, true);
	assert.equal(rec.source, "credential record");
	assert.equal(body.providers.some((p) => p.id === "opencode-go"), true);
	assert.equal(body.pollMs, 1_000_000);
	assert.equal(body.timeoutMs, 10_000);
	assert.equal(typeof dispose, "function");
	dispose();
});
