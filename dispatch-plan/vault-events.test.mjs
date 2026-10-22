/** Run with: node --test dispatch-plan/vault-events.test.mjs (Node 24+) */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { bootEventData, emitEvent } from "./vault-events.mjs";

function tempRoot() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-vault-events-"));
	return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function readEvents(root, trace) {
	const file = path.join(root, ".plans", "traces", `${trace}.jsonl`);
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

test("one event line has the documented fields and format", () => {
	const ctx = tempRoot();
	try {
		const before = Date.now();
		emitEvent({ root: ctx.dir, trace: "agent-vault" }, "vault.write", {
			type: "finding",
			id: "trace-f-12345678",
			op: "new",
		});
		const after = Date.now();

		const events = readEvents(ctx.dir, "agent-vault");
		assert.equal(events.length, 1);
		const ev = events[0];
		assert.deepEqual(Object.keys(ev), ["v", "ts", "trace", "span", "actor", "kind", "data"]);
		assert.equal(ev.v, 1);
		assert.equal(ev.trace, "agent-vault");
		assert.equal(ev.span, "vault.write:trace-f-12345678");
		assert.equal(ev.actor, "vault");
		assert.equal(ev.kind, "vault.write");
		assert.deepEqual(ev.data, { type: "finding", id: "trace-f-12345678", op: "new" });

		const ts = Date.parse(ev.ts);
		assert.equal(new Date(ts).toISOString(), ev.ts);
		assert.ok(ts >= before && ts <= after);
	} finally {
		ctx.cleanup();
	}
});

test("emitEvent creates the .plans/traces folders under root and appends", () => {
	const ctx = tempRoot();
	try {
		const root = path.join(ctx.dir, "repo");
		fs.mkdirSync(root);
		emitEvent({ root, trace: "t1" }, "vault.write", { id: "a", op: "set" });
		emitEvent({ root, trace: "t1" }, "vault.sync", { op: "push", result: 0 });

		const dir = path.join(root, ".plans", "traces");
		assert.equal(fs.statSync(dir).isDirectory(), true);
		const events = readEvents(root, "t1");
		assert.deepEqual(
			events.map((ev) => ev.span),
			["vault.write:a", "vault.sync:push"],
		);
		assert.equal(events[1].data.result, 0);
	} finally {
		ctx.cleanup();
	}
});

test("the span falls back from id to op to reason to a dash", () => {
	const ctx = tempRoot();
	try {
		const root = ctx.dir;
		emitEvent({ root, trace: "t2" }, "vault.write", { id: "id", op: "op", reason: "why" });
		emitEvent({ root, trace: "t2" }, "vault.sync", { op: "pull", reason: "why" });
		emitEvent({ root, trace: "t2" }, "vault.unavailable", { reason: "not configured" });
		emitEvent({ root, trace: "t2" }, "vault.boot", { bytes: 10, items: 1, truncated: 0 });
		assert.deepEqual(
			readEvents(root, "t2").map((ev) => ev.span),
			["vault.write:id", "vault.sync:pull", "vault.unavailable:not configured", "vault.boot:-"],
		);
	} finally {
		ctx.cleanup();
	}
});

test("without root or without trace nothing is written and nothing throws", () => {
	const ctx = tempRoot();
	try {
		emitEvent({ root: ctx.dir }, "vault.write", { id: "a" });
		emitEvent({ trace: "t3" }, "vault.write", { id: "a" });
		emitEvent({ root: "", trace: "t3" }, "vault.write", { id: "a" });
		emitEvent({ root: ctx.dir, trace: "" }, "vault.write", { id: "a" });
		emitEvent({}, "vault.write", { id: "a" });
		assert.deepEqual(fs.readdirSync(ctx.dir), []);
	} finally {
		ctx.cleanup();
	}
});

test("an unwritable root is swallowed and writes nothing", () => {
	const ctx = tempRoot();
	try {
		const root = path.join(ctx.dir, "not-a-folder");
		fs.writeFileSync(root, "file");
		assert.doesNotThrow(() => emitEvent({ root, trace: "t4" }, "vault.write", { id: "a" }));
		assert.equal(fs.readFileSync(root, "utf8"), "file");
	} finally {
		ctx.cleanup();
	}
});

test("bootEventData counts a plain boot text", () => {
	const text = "intro\n=== project ===\nproject body\n=== findings ===\n- one\n=== index ===\nindex\n";
	assert.deepEqual(bootEventData(text), {
		bytes: Buffer.byteLength(text),
		items: 3,
		truncated: 0,
	});
	assert.equal(bootEventData("no items\n").items, 0);
});

test("bootEventData reads the final truncation line", () => {
	const text = "intro\n=== project ===\nbody\n[truncated: 7 items]\n";
	assert.deepEqual(bootEventData(text), {
		bytes: Buffer.byteLength(text),
		items: 1,
		truncated: 7,
	});
});

test("bootEventData on over-budget text has no items and no truncation", () => {
	const text = `${"x".repeat(50)}\n[over budget: CLAUDE.md]\n`;
	assert.deepEqual(bootEventData(text), {
		bytes: Buffer.byteLength(text),
		items: 0,
		truncated: 0,
	});
});
