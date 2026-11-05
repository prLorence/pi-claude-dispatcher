import { test } from "node:test";
import assert from "node:assert/strict";
import { filesOverlap, isPlanFinished, pickRunnable } from "../plugins/harness-dispatch/schedule.js";

const task = (id, files, dependsOn = []) => ({ id, files, dependsOn, state: "pending", attempts: 0, pairRound: 0 });
const plan = (tasks) => ({ tasks });

test("filesOverlap treats directory prefixes as overlapping", () => {
	assert.equal(filesOverlap(["src/a.ts"], ["src/a.ts"]), true);
	assert.equal(filesOverlap(["src/other/"], ["src/other/x.ts"]), true);
	assert.equal(filesOverlap(["src/a.ts"], ["src/b.ts"]), false);
	assert.equal(filesOverlap(["./src/a.ts"], ["src/a.ts"]), true);
});

test("overlapping tasks serialise and dependencies gate order", () => {
	const p = plan([task("a", ["src/a.ts"]), task("b", ["src/a.ts"]), task("c", ["src/c.ts"])]);
	const picked = pickRunnable(p, 3);
	assert.deepEqual(picked.map((t) => t.id), ["a", "c"]);
	p.tasks[0].state = "running";
	assert.deepEqual(pickRunnable(p, 3).map((t) => t.id), ["c"]);
	p.tasks[0].state = "done";
	assert.deepEqual(pickRunnable(p, 3).map((t) => t.id), ["b", "c"]);
});

test("a task with no files runs alone", () => {
	const p = plan([task("a", []), task("b", ["b.ts"])]);
	assert.deepEqual(pickRunnable(p, 3).map((t) => t.id), ["a"]);
	p.tasks[0].state = "running";
	assert.deepEqual(pickRunnable(p, 3), []);
});

test("a failed dependency skips its dependents", () => {
	const p = plan([task("a", ["a.ts"]), task("b", ["b.ts"], ["a"])]);
	p.tasks[0].state = "failed";
	assert.deepEqual(pickRunnable(p, 3), []);
	assert.equal(p.tasks[1].state, "skipped");
});

test("max parallel caps the picked set", () => {
	const p = plan([task("a", ["a.ts"]), task("b", ["b.ts"]), task("c", ["c.ts"])]);
	assert.equal(pickRunnable(p, 2).length, 2);
});

test("isPlanFinished requires every task terminal", () => {
	const p = plan([task("a", ["a.ts"])]);
	assert.equal(isPlanFinished(p), false);
	p.tasks[0].state = "done";
	assert.equal(isPlanFinished(p), true);
});
