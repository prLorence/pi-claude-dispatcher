/** Run with: cd pi-plan-dispatch && node --test decider/config.test.ts (Node 24+) */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DECIDER_DEFAULTS, loadDeciderConfig } from "./config.ts";

const CONFIG = {
	effort: "apply",
	audit: "shadow",
	model: "other/decider-1",
	timeoutMs: 1000,
	thresholds: { effortMax: 0.5, effortLow: 0.7, complexityHigh: 3.5, approve: 0.6, dismiss: 0.05, minorWeight: 0.3 },
};

test("the defaults are the documented ones", () => {
	assert.deepEqual(DECIDER_DEFAULTS, {
		effort: "off",
		audit: "off",
		escalate: false,
		model: "perplexity/pplx-decider-flash-v1.2",
		timeoutMs: 30000,
		thresholds: { effortMax: 0.4, effortLow: 0.6, complexityHigh: 3, approve: 0.5, dismiss: 0.1, minorWeight: 0.2 },
	});
});

test("a full config is kept as it is", () => {
	assert.deepEqual(loadDeciderConfig(CONFIG), { ...CONFIG, escalate: false });
});

test("a missing or non-object value gives a fresh copy of the defaults", () => {
	for (const raw of [undefined, null, "apply", 42, [], true]) {
		assert.deepEqual(loadDeciderConfig(raw), DECIDER_DEFAULTS);
	}
	const first = loadDeciderConfig();
	const second = loadDeciderConfig();
	assert.notEqual(first, second);
	assert.notEqual(first, DECIDER_DEFAULTS);
	assert.notEqual(first.thresholds, second.thresholds);
	first.effort = "apply";
	first.thresholds.effortMax = 0.99;
	assert.equal(second.effort, "off");
	assert.equal(second.thresholds.effortMax, 0.4);
	assert.equal(DECIDER_DEFAULTS.thresholds.effortMax, 0.4);
});

test("an unknown mode becomes off", () => {
	assert.equal(loadDeciderConfig({ effort: "on", audit: "auto" }).effort, "off");
	assert.equal(loadDeciderConfig({ effort: "on", audit: "auto" }).audit, "off");
	assert.equal(loadDeciderConfig({ effort: "off", audit: "off" }).effort, "off");
	assert.equal(loadDeciderConfig({ effort: "APPLY" }).effort, "off");
});

test("apply and shadow are kept", () => {
	const config = loadDeciderConfig({ effort: "apply", audit: "shadow" });
	assert.equal(config.effort, "apply");
	assert.equal(config.audit, "shadow");
});

test("dispatch is kept as an effort mode", () => {
	assert.equal(loadDeciderConfig({ effort: "dispatch" }).effort, "dispatch");
	assert.equal(loadDeciderConfig({ effort: "apply" }).effort, "apply");
});

test("escalate is true only for the boolean true", () => {
	assert.equal(loadDeciderConfig({ escalate: true }).escalate, true);
	assert.equal(loadDeciderConfig({ escalate: "true" }).escalate, false);
	assert.equal(loadDeciderConfig({ escalate: 1 }).escalate, false);
	assert.equal(loadDeciderConfig({ escalate: false }).escalate, false);
	assert.equal(loadDeciderConfig({}).escalate, false);
});

test("a call does not mutate the defaults object", () => {
	loadDeciderConfig({
		effort: "dispatch",
		audit: "shadow",
		escalate: true,
		model: "other/model",
		timeoutMs: 5000,
		thresholds: { effortMax: 0.9, effortLow: 0.1, complexityHigh: 4, approve: 0.9, dismiss: 0.9, minorWeight: 0.9 },
	});
	assert.deepEqual(DECIDER_DEFAULTS, {
		effort: "off",
		audit: "off",
		escalate: false,
		model: "perplexity/pplx-decider-flash-v1.2",
		timeoutMs: 30000,
		thresholds: { effortMax: 0.4, effortLow: 0.6, complexityHigh: 3, approve: 0.5, dismiss: 0.1, minorWeight: 0.2 },
	});
});

test("an invalid model falls back", () => {
	assert.equal(loadDeciderConfig({ model: "" }).model, DECIDER_DEFAULTS.model);
	assert.equal(loadDeciderConfig({ model: "   " }).model, DECIDER_DEFAULTS.model);
	assert.equal(loadDeciderConfig({ model: 7 }).model, DECIDER_DEFAULTS.model);
	assert.equal(loadDeciderConfig({ model: null }).model, DECIDER_DEFAULTS.model);
});

test("an invalid timeout falls back", () => {
	for (const timeoutMs of [0, -1, 1.5, "30000", null, Number.NaN, Number.POSITIVE_INFINITY]) {
		assert.equal(loadDeciderConfig({ timeoutMs }).timeoutMs, DECIDER_DEFAULTS.timeoutMs, `timeoutMs ${String(timeoutMs)}`);
	}
	assert.equal(loadDeciderConfig({ timeoutMs: 5000 }).timeoutMs, 5000);
});

test("an invalid threshold falls back to its own default", () => {
	const cases = [
		["effortMax", 1.01],
		["effortLow", -0.1],
		["approve", "0.5"],
		["dismiss", Number.NaN],
		["minorWeight", null],
	];
	for (const [key, value] of cases) {
		const config = loadDeciderConfig({ thresholds: { [key]: value } });
		assert.equal(
			config.thresholds[key as keyof typeof DECIDER_DEFAULTS.thresholds],
			DECIDER_DEFAULTS.thresholds[key as keyof typeof DECIDER_DEFAULTS.thresholds],
			`${key} ${String(value)}`,
		);
	}
});

test("a threshold at the edges of the range is kept", () => {
	const config = loadDeciderConfig({ thresholds: { effortMax: 0, effortLow: 1, approve: 1, dismiss: 0, minorWeight: 1 } });
	assert.deepEqual(config.thresholds, {
		effortMax: 0,
		effortLow: 1,
		complexityHigh: 3,
		approve: 1,
		dismiss: 0,
		minorWeight: 1,
	});
});

test("complexityHigh is a number in 0 to 4 and falls back to 3", () => {
	assert.equal(loadDeciderConfig({ thresholds: { complexityHigh: 4 } }).thresholds.complexityHigh, 4);
	assert.equal(loadDeciderConfig({ thresholds: { complexityHigh: 0 } }).thresholds.complexityHigh, 0);
	for (const complexityHigh of [4.01, -1, Number.NaN, "3", null]) {
		assert.equal(
			loadDeciderConfig({ thresholds: { complexityHigh } }).thresholds.complexityHigh,
			DECIDER_DEFAULTS.thresholds.complexityHigh,
			String(complexityHigh),
		);
	}
	assert.equal(loadDeciderConfig({ thresholds: {} }).thresholds.complexityHigh, 3);
	assert.equal(loadDeciderConfig({}).thresholds.complexityHigh, 3);
});

test("a partial thresholds object keeps the other defaults", () => {
	const config = loadDeciderConfig({ thresholds: { approve: 0.2 } });
	assert.deepEqual(config.thresholds, { ...DECIDER_DEFAULTS.thresholds, approve: 0.2 });
	assert.deepEqual(loadDeciderConfig({ thresholds: "junk" }).thresholds, DECIDER_DEFAULTS.thresholds);
	assert.deepEqual(loadDeciderConfig({ thresholds: [] }).thresholds, DECIDER_DEFAULTS.thresholds);
});

test("unknown keys are ignored", () => {
	const config = loadDeciderConfig({ effort: "apply", extra: true, thresholds: { approve: 0.3, other: 5 } });
	assert.deepEqual(Object.keys(config).sort(), ["audit", "effort", "escalate", "model", "thresholds", "timeoutMs"]);
	assert.deepEqual(Object.keys(config.thresholds).sort(), [
		"approve",
		"complexityHigh",
		"dismiss",
		"effortLow",
		"effortMax",
		"minorWeight",
	]);
});
