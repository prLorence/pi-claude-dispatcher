import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OMP_ROLES, readRoles, validModelId, writeRole } from "../plugins/harness-dispatcher-ui/roles-config.js";
import { DEFAULT_ROLES } from "../plugins/harness-dispatch/roles.js";

function repo(initial) {
	const root = mkdtempSync(join(tmpdir(), "dispatch-roles-"));
	mkdirSync(join(root, ".plans"), { recursive: true });
	if (initial !== undefined) {
		writeFileSync(join(root, ".plans", "config.json"), `${JSON.stringify(initial, null, 2)}\n`);
	}
	return root;
}

function readFile(root) {
	return JSON.parse(readFileSync(join(root, ".plans", "config.json"), "utf8"));
}

test("a role with no override reports the built-in defaults", () => {
	const root = repo({});
	try {
		const roles = readRoles(root);
		assert.deepEqual(
			roles.map((r) => r.name),
			OMP_ROLES,
		);
		for (const role of roles) {
			assert.equal(role.overridden, false, `${role.name} is not overridden`);
			assert.equal(role.model, DEFAULT_ROLES[role.name].model);
			assert.equal(role.overridden, false);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a missing config file still resolves built-ins instead of throwing", () => {
	const root = repo();
	try {
		const roles = readRoles(root);
		assert.equal(roles.length, OMP_ROLES.length);
		assert.ok(roles.every((r) => r.overridden === false));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("writeRole overrides one key and leaves every other config key alone", () => {
	const root = repo({ maxParallel: 8, pairDefault: "review", dshPairDefault: "pair-omp", decider: { effort: "dispatch" } });
	try {
		writeRole(root, "implement-omp", { model: "opencode-go/deepseek-v4.1-flash" });
		const raw = readFile(root);
		assert.equal(raw.maxParallel, 8);
		assert.equal(raw.pairDefault, "review");
		assert.equal(raw.dshPairDefault, "pair-omp");
		assert.deepEqual(raw.decider, { effort: "dispatch" });
		assert.equal(raw.roles["implement-omp"].model, "opencode-go/deepseek-v4.1-flash");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("null removes the override so the role falls back to the built-in", () => {
	const root = repo({});
	try {
		writeRole(root, "pair-omp", { model: "opencode-go/some-other-model" });
		assert.equal(readRoles(root).find((r) => r.name === "pair-omp").overridden, true);
		const reset = writeRole(root, "pair-omp", { model: null });
		assert.equal(reset.overridden, false);
		assert.equal(reset.model, DEFAULT_ROLES["pair-omp"].model);
		// An emptied role is removed rather than left as an empty object.
		assert.equal(readFile(root).roles, undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("resetting one key keeps the role's other overrides", () => {
	const root = repo({});
	try {
		writeRole(root, "pair-omp", { model: "opencode-go/some-other-model", thinking: "high" });
		const after = writeRole(root, "pair-omp", { model: null });
		assert.equal(after.overridden, true, "thinking override survives");
		assert.equal(after.thinking, "high");
		assert.equal(after.model, DEFAULT_ROLES["pair-omp"].model);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("writeRole refuses a role the dispatcher does not know", () => {
	const root = repo({});
	try {
		assert.throws(() => writeRole(root, "not-a-role", { model: "x" }), /not an omp role/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a malformed config file does not brick the panel", () => {
	const root = repo();
	try {
		writeFileSync(join(root, ".plans", "config.json"), "{ this is not json");
		assert.equal(readRoles(root).length, OMP_ROLES.length);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("implement-omp and the reviewer roles target omp, and only reviewers are read-only", () => {
	const root = repo({});
	try {
		const roles = readRoles(root);
		for (const role of roles) assert.equal(role.agent, "omp", `${role.name} runs on omp`);
		assert.equal(roles.find((r) => r.name === "implement-omp").readonly, false);
		assert.equal(roles.find((r) => r.name === "pair-omp").readonly, true);
		assert.equal(roles.find((r) => r.name === "pair-omp-contributor").readonly, true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("implement-omp defaults to deepseek-v4.1-flash", () => {
	assert.equal(DEFAULT_ROLES["implement-omp"].model, "opencode-go/deepseek-v4.1-flash");
});

test("validModelId rejects whitespace, quotes and empty ids", () => {
	assert.equal(validModelId("opencode-go/deepseek-v4.1-flash"), true);
	assert.equal(validModelId("opencode-go/deepseek-v4.1-flash:high"), true);
	assert.equal(validModelId(""), false);
	assert.equal(validModelId("has space"), false);
	assert.equal(validModelId('quo"te'), false);
	assert.equal(validModelId(42), false);
});
