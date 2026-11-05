import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PLAN_DIRS, ensurePlanDirs } from "../plugins/harness-projects/plans.js";

test("ensurePlanDirs creates the plan skeleton once and is idempotent", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-project-plans-"));
	try {
		const first = ensurePlanDirs(root);
		assert.equal(first.plans, path.join(root, ".plans"));
		assert.equal(first.created, true);
		for (const name of PLAN_DIRS) assert.equal(fs.existsSync(path.join(root, ".plans", name)), true);
		assert.equal(ensurePlanDirs(root).created, false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
