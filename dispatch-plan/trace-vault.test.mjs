/** Run with: node --test dispatch-plan/trace-vault.test.mjs (Node 24+) */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const here = path.dirname(new URL(import.meta.url).pathname);
const cli = path.join(here, "trace.mjs");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pi-trace-vault-"));

let seq = 0;
function ev(trace, actor, kind, fields = {}) {
	seq += 1;
	return JSON.stringify({
		v: 1,
		ts: new Date(Date.UTC(2026, 9, 22, 12, 0, seq)).toISOString(),
		trace,
		span: `${kind}:${seq}`,
		actor,
		kind,
		plan: "p1",
		round: 1,
		...fields,
	});
}

function writeTrace(dir, trace, lines) {
	fs.mkdirSync(path.join(dir, ".plans", "traces"), { recursive: true });
	fs.writeFileSync(path.join(dir, ".plans", "traces", `${trace}.jsonl`), `${lines.join("\n")}\n`);
}

function runReport(dir, trace) {
	const r = spawnSync(process.execPath, [cli, "report", "--trace", trace, "--root", dir], { encoding: "utf8" });
	assert.equal(r.status, 0, r.stderr);
	return r.stdout;
}

function section(out, name, next) {
	const start = out.indexOf(`## ${name}`);
	assert.ok(start >= 0, `report has a ${name} section`);
	const end = out.indexOf(`## ${next}`, start);
	assert.ok(end > start, `${name} sits before ${next}`);
	return out.slice(start, end).trim().split("\n").map((l) => l.trim()).filter(Boolean);
}

// The timeline row for the nth event of a kind, as a detail cell.
function detailCell(out, kind, nth = 0) {
	const rows = out.split("\n").filter((l) => l.startsWith("|") && l.includes(` ${kind} `));
	assert.ok(rows[nth], `no timeline row ${nth} for ${kind}`);
	const cells = rows[nth].split("|").map((s) => s.trim());
	// A Markdown row ends with a closing pipe, so the detail is the second to last cell.
	return cells[cells.length - 2];
}

test("vault events render their detail in the timeline", () => {
	const dir = tmp();
	try {
		const trace = "v-detail";
		writeTrace(dir, trace, [
			ev(trace, "pi-dispatch", "plan.received", { data: { tasks: [{ id: "a" }] } }),
			ev(trace, "vault", "vault.boot", { data: { bytes: 120, items: 3, truncated: true } }),
			ev(trace, "vault", "vault.boot", { data: { bytes: 40, items: 1, truncated: 0 } }),
			ev(trace, "vault", "vault.write", { data: { type: "run", id: "p1-run", op: "new" } }),
			ev(trace, "vault", "vault.sync", { data: { op: "push", result: "pushed" } }),
			ev(trace, "vault", "vault.unavailable", { data: { reason: "not configured" } }),
			ev(trace, "vault", "vault.denied", { data: { repo: "github.com/o/x", type: "run" } }),
			ev(trace, "vault", "vault.write", { data: {} }),
		]);

		const out = runReport(dir, trace);

		assert.equal(detailCell(out, "vault.boot", 0), "boot 120 bytes, 3 items, truncated");
		assert.equal(detailCell(out, "vault.boot", 1), "boot 40 bytes, 1 items");
		assert.equal(detailCell(out, "vault.write", 0), "new run p1-run");
		assert.equal(detailCell(out, "vault.sync", 0), "push: pushed");
		assert.equal(detailCell(out, "vault.unavailable", 0), "unavailable: not configured");
		assert.equal(detailCell(out, "vault.denied", 0), "denied run note for github.com/o/x");
		assert.equal(detailCell(out, "vault.write", 1), "- - -");
		assert.ok(out.includes("| vault | vault.boot |"), "the vault actor is in the timeline");
		assert.ok(!out.includes("undefined"), "no field renders as undefined");
		assert.ok(!out.includes("[object Object]"), "no field renders as [object Object]");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("review tokens are added as a number, never as an object", () => {
	const dir = tmp();
	try {
		const trace = "v-tokens";
		writeTrace(dir, trace, [
			ev(trace, "pi-dispatch", "task.start", { task: "a", data: { model: "opencode-go/impl", role: "implement" } }),
			ev(trace, "worker", "task.review", {
				task: "a",
				data: { model: "opencode-go/rev", reviewer_role: "review", verdict: "approve", tokens: { total: 0 } },
			}),
			ev(trace, "worker", "task.review", {
				task: "a",
				data: { model: "opencode-go/rev", reviewer_role: "review", verdict: "changes", tokens: { input: 1 } },
			}),
			ev(trace, "worker", "task.review", {
				task: "a",
				data: { model: "opencode-go/rev", reviewer_role: "review", verdict: "approve", tokens: 40 },
			}),
		]);

		const out = runReport(dir, trace);
		assert.ok(!out.includes("[object Object]"), "no [object Object] in the report");

		const rows = section(out, "Models", "Timeline").filter((l) => l.includes("opencode-go/rev"));
		assert.equal(rows.length, 1);
		const cells = rows[0].split("|").map((s) => s.trim());
		assert.equal(cells[5], "40", `tokens cell is a plain number: ${rows[0]}`);
		assert.match(cells[5], /^\d+$/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("vault events add no Models row and leave the plan table alone", () => {
	const dir = tmp();
	try {
		const base = [ev("v-plain", "pi-dispatch", "plan.received", { data: { tasks: [{ id: "a" }] } })];
		const withVault = [
			ev("v-full", "pi-dispatch", "plan.received", { data: { tasks: [{ id: "a" }] } }),
			ev("v-full", "vault", "vault.boot", { data: { bytes: 120, items: 3, truncated: 0 } }),
			ev("v-full", "vault", "vault.write", { data: { type: "run", id: "p1-run", op: "new" } }),
			ev("v-full", "vault", "vault.unavailable", { data: { reason: "vault not configured" } }),
		];
		writeTrace(dir, "v-plain", base);
		writeTrace(dir, "v-full", withVault);

		const plain = runReport(dir, "v-plain");
		const full = runReport(dir, "v-full");

		assert.deepEqual(section(full, "Models", "Timeline"), section(plain, "Models", "Timeline"));
		assert.deepEqual(section(full, "Rounds", "Plan audit"), section(plain, "Rounds", "Plan audit"));
		assert.ok(!section(full, "Models", "Timeline").some((l) => l.includes("vault")), "no vault row in Models");
		assert.ok(full.includes("| vault | vault.boot |"), "the vault events still reach the timeline");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
