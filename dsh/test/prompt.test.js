import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWorkerPrompt } from "../plugins/harness-dispatch/prompt.js";
import { DEFAULT_CONFIG } from "../plugins/harness-dispatch/config.js";
import { parsePlan } from "../plugins/harness-dispatch/plan.js";

const plan = parsePlan("---\nid: p\n---\nShared context.\n\n## task: a\nfiles: src/a.ts\nrole: implement\nbody\n", "p");

test("the worker prompt carries context, task, files, role and the report format", () => {
	const text = buildWorkerPrompt(plan, plan.tasks[0], DEFAULT_CONFIG);
	assert.match(text, /one task from plan "p"/);
	assert.match(text, /## Plan context\nShared context\./);
	assert.match(text, /## Your task: a/);
	assert.match(text, /You own ONLY these paths: src\/a\.ts/);
	assert.match(text, /## Your role/);
	assert.match(text, /STATUS: done \| failed/);
});

test("a verify retry is presented as a failed check", () => {
	const task = { ...plan.tasks[0], feedback: "Independent verification failed", feedbackKind: "verify" };
	assert.match(buildWorkerPrompt(plan, task, DEFAULT_CONFIG), /previous attempt failed verification/);
});

test("a review feedback is presented as findings to fix", () => {
	const task = { ...plan.tasks[0], feedback: "1. broken", feedbackKind: "review" };
	const text = buildWorkerPrompt(plan, task, DEFAULT_CONFIG);
	assert.match(text, /reviewer found problems/);
	assert.match(text, /1\. broken/);
});

test("a task with no files gets the minimal-change wording", () => {
	const p = parsePlan("---\nid: p\n---\n## task: a\nbody\n", "p");
	assert.match(buildWorkerPrompt(p, p.tasks[0], DEFAULT_CONFIG), /No file list was given/);
});
