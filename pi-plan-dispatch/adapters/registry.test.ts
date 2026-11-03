/** Run with: cd pi-plan-dispatch && node --test --test-force-exit adapters/registry.test.ts (Node 24+) */
import assert from "node:assert/strict";
import { test } from "node:test";
import { getAdapter, knownAgents } from "./index.ts";
import { piAdapter } from "./pi.ts";

test("knownAgents lists only Pi", () => {
	assert.deepEqual(knownAgents(), ["pi"]);
});

test("getAdapter returns the Pi adapter for the exact name pi", () => {
	const adapter = getAdapter("pi");
	assert.equal(adapter, piAdapter);
	assert.equal(adapter?.name, "pi");
});

test("getAdapter returns undefined for unknown, empty, differently cased or inherited names", () => {
	for (const name of ["omp", "", "Pi", " pi", "constructor"]) {
		assert.equal(getAdapter(name), undefined, `"${name}" is not a known agent`);
	}
});
