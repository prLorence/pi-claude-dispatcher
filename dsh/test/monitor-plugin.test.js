import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { apply } from "../plugins/harness-monitor/index.js";

test("the monitor plugin registers only read routes on webServer", async () => {
	const routes = [];
	const ctx = {
		workingDirectory: { defaultDirectory: process.cwd() },
		webServer: {
			register(route) {
				routes.push(route);
				return () => {};
			},
		},
	};
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-monitor-plugin-"));
	try {
		const dispose = await apply(ctx, { root, plansDir: path.join(root, ".plans") });
		assert.deepEqual(
			routes.map((r) => `${r.kind} ${r.path}`),
			[
				"exact /api/state",
				"exact /api/events",
				"prefix /api/session/",
				"exact /api/agents",
				"prefix /plugins/harness-monitor/",
			],
		);
		assert.equal(typeof dispose, "function");
		dispose();
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
