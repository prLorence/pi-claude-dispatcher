#!/usr/bin/env node
/**
 * Trace CLI for the dispatch-plan flow. Plain Node, no dependencies.
 *
 *   trace.mjs event  --trace T --actor A --kind K [--plan P] [--round N] [--task X]
 *                    [--span S] [--parent S] [--data '{"k":"v"}']
 *   trace.mjs wait   --plan P [--timeout 540] [--pickup 90]
 *   trace.mjs gate   --plan P
 *   trace.mjs report --trace T            (prints Markdown, writes .plans/traces/T.md)
 *   trace.mjs new-id [slug]               (prints a trace id: yyyymmdd-hhmm-slug)
 *
 * Run it from the repo root, or pass --root <repo>. Events append to
 * .plans/traces/<trace>.jsonl, the same file the pi-plan-dispatch extension writes.
 *
 * Exit codes: wait 0 done / 2 rejected / 3 still running / 4 never picked up;
 *             gate 0 pass / 1 fail / 2 no evidence.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const argv = process.argv.slice(2);
const cmd = argv.shift();
const flags = {};
const rest = [];
for (let i = 0; i < argv.length; i++) {
	if (argv[i].startsWith("--")) flags[argv[i].slice(2)] = argv[++i];
	else rest.push(argv[i]);
}
const root = path.join(path.resolve(flags.root || process.cwd()), ".plans");
const safe = (v) => String(v).replace(/[^\w.-]+/g, "-");
const die = (msg, code = 1) => {
	console.error(msg);
	process.exit(code);
};
const tracePath = (t) => path.join(root, "traces", `${safe(t)}.jsonl`);

function readEvents(trace) {
	try {
		return fs
			.readFileSync(tracePath(trace), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
	} catch {
		return [];
	}
}

function readEvidence(plan) {
	try {
		return JSON.parse(fs.readFileSync(path.join(root, "done", safe(plan), "evidence.json"), "utf8"));
	} catch {
		return undefined;
	}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- commands ----------

function cmdEvent() {
	if (!flags.trace || !flags.actor || !flags.kind) die("event needs --trace, --actor and --kind");
	let data;
	if (flags.data) {
		try {
			data = JSON.parse(flags.data);
		} catch {
			die("--data must be valid JSON");
		}
	}
	const plan = flags.plan ? safe(flags.plan) : undefined;
	const ev = {
		v: 1,
		ts: new Date().toISOString(),
		trace: safe(flags.trace),
		span: flags.span || `${flags.kind}:${plan || safe(flags.trace)}`,
		parent: flags.parent || (plan ? `plan:${plan}` : undefined),
		actor: flags.actor,
		kind: flags.kind,
		plan,
		round: flags.round ? Number(flags.round) : undefined,
		task: flags.task,
		data,
	};
	fs.mkdirSync(path.dirname(tracePath(ev.trace)), { recursive: true });
	fs.appendFileSync(tracePath(ev.trace), `${JSON.stringify(ev)}\n`);
	console.log(`ok ${ev.kind} ${ev.span}`);
}

async function cmdWait() {
	if (!flags.plan) die("wait needs --plan");
	const plan = safe(flags.plan);
	const timeoutMs = Number(flags.timeout || 540) * 1000;
	const pickupMs = Number(flags.pickup || 90) * 1000;
	const done = path.join(root, "done", plan, "_summary.md");
	const failed = path.join(root, "failed", `${plan}.error.md`);
	const running = path.join(root, "running", `${plan}.md`);
	const inbox = path.join(root, "inbox", `${plan}.md`);
	const t0 = Date.now();
	for (;;) {
		if (fs.existsSync(done)) {
			const ev = readEvidence(plan);
			console.log(fs.readFileSync(done, "utf8"));
			if (ev) console.log(`GATE ${ev.gate.pass ? "PASS" : "FAIL"} ${JSON.stringify(ev.gate)}`);
			process.exit(0);
		}
		if (fs.existsSync(failed)) {
			// A rejection file from an earlier drop of the same id is stale once the plan is queued or running again.
			const stale = fs.statSync(failed).mtimeMs < t0 && (fs.existsSync(running) || fs.existsSync(inbox));
			if (!stale) {
				console.log(fs.readFileSync(failed, "utf8"));
				process.exit(2);
			}
		}
		if (!fs.existsSync(running) && fs.existsSync(inbox) && Date.now() - t0 > pickupMs) {
			console.log("Plan is still in .plans/inbox/. The Pi session with pi-plan-dispatch is probably not running. Tell the user.");
			process.exit(4);
		}
		if (Date.now() - t0 > timeoutMs) {
			console.log(`Still running after ${Math.round((Date.now() - t0) / 1000)}s. Call wait again.`);
			process.exit(3);
		}
		await sleep(5000);
	}
}

function cmdGate() {
	if (!flags.plan) die("gate needs --plan");
	const ev = readEvidence(flags.plan);
	if (!ev) die(`no evidence.json for plan ${flags.plan} (has it finished?)`, 2);
	console.log(JSON.stringify({ plan: ev.plan, round: ev.round, gate: ev.gate, faults: ev.faults, changed: ev.changed }, null, 2));
	process.exit(ev.gate.pass ? 0 : 1);
}

function cmdNewId() {
	const d = new Date();
	const p = (n) => String(n).padStart(2, "0");
	const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
	const slug = safe(rest[0] || "").toLowerCase().replace(/^-+|-+$/g, "").slice(0, 32);
	console.log(slug ? `${stamp}-${slug}` : stamp);
}

function cmdReport() {
	if (!flags.trace) die("report needs --trace");
	const events = readEvents(flags.trace);
	if (!events.length) die(`no events for trace ${flags.trace}`, 2);
	const md = render(flags.trace, events);
	fs.mkdirSync(path.join(root, "traces"), { recursive: true });
	fs.writeFileSync(path.join(root, "traces", `${safe(flags.trace)}.md`), md);
	console.log(md);
}

// ---------- report rendering ----------

const money = (n) => `$${(n || 0).toFixed(4)}`;
const clock = (ms) => {
	const s = Math.max(0, Math.round(ms / 1000));
	return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

function detail(e) {
	const d = e.data || {};
	switch (e.kind) {
		case "plan.received":
			return `${(d.tasks || []).length} tasks${d.dry ? ", dry run" : ""}${e.round ? `, round ${e.round}` : ""}`;
		case "task.start":
			return `${d.model} (${d.thinking}) prompt ${d.prompt_sha}${d.session_id ? ` session ${d.session_id}` : ""}`;
		case "task.end":
			return `${d.state} in ${d.duration_s}s, ${d.tokens?.total ?? 0} tok, ${money(d.cost)}, ${d.tools?.total ?? 0} tool calls${d.error ? `, error: ${String(d.error).split("\n")[0].slice(0, 80)}` : ""}`;
		case "fault":
			return `[${d.severity}] ${d.code}: ${d.message}`;
		case "gate":
			return `${d.pass ? "PASS" : "FAIL"} (${d.counts?.error} err, ${d.counts?.warn} warn)${d.reasons?.length ? `: ${d.reasons.join("; ")}` : ""}`;
		case "plan.end":
			return `${d.done} done, ${d.failed} failed, ${d.skipped} skipped, ${money(d.cost)}, ${d.duration_s}s`;
		case "audit.verdict":
			// Legacy: the old result audit. Kept so old traces still render.
			return `${String(d.verdict).toUpperCase()}, ${d.findings ?? 0} finding(s)${d.summary ? `: ${d.summary}` : ""}`;
		case "spec.confirmed":
			return `${d.requirements ?? 0} requirements, ${d.spec}`;
		case "plan.audit":
			return `${String(d.verdict).toUpperCase()} audit round ${d.audit_round ?? d.round ?? e.round ?? "-"}: ${d.blockers ?? 0} blocker, ${d.majors ?? 0} major, ${d.minors ?? 0} minor${d.summary ? `: ${d.summary}` : ""}`;
		default:
			return d && Object.keys(d).length ? JSON.stringify(d).slice(0, 140) : "";
	}
}

const taskKey = (e) => `${e.plan ?? ""}\u0000${e.task ?? ""}`;

// One row per model seen in task.start or task.review. Costs come from task.end
// (matched by task and attempt) plus the review event's own cost, so a reviewer
// model is never missing from the picture.
function modelsTable(events) {
	const rows = new Map();
	const taskModels = new Map();
	const startedWith = new Map();
	const row = (model) => {
		const key = model || "unknown";
		if (!rows.has(key)) rows.set(key, { model: key, roles: new Set(), tasks: new Set(), reviews: 0, tokens: 0, cost: 0, errors: 0, warns: 0 });
		return rows.get(key);
	};
	const addModels = (task, model) => {
		if (!taskModels.has(task)) taskModels.set(task, new Set());
		taskModels.get(task).add(model || "unknown");
	};

	for (const e of events) {
		const d = e.data || {};
		if (e.kind === "task.start") {
			const r = row(d.model);
			r.roles.add(d.role || "implement");
			if (e.task) {
				r.tasks.add(taskKey(e));
				addModels(taskKey(e), d.model);
				startedWith.set(`${taskKey(e)}|${e.attempt ?? 1}`, d.model || "unknown");
			}
		}
	}
	for (const e of events) {
		const d = e.data || {};
		if (e.kind === "task.end" && e.task) {
			const key = taskKey(e);
			const model = startedWith.get(`${key}|${e.attempt ?? 1}`) || [...(taskModels.get(key) || [])].at(-1) || "unknown";
			const r = row(model);
			r.tokens += d.tokens?.total || 0;
			r.cost += d.cost || 0;
		} else if (e.kind === "task.review") {
			const r = row(d.model);
			r.roles.add(d.reviewer_role || "implement");
			r.reviews += 1;
			r.tokens += d.tokens?.total || d.tokens || 0;
			r.cost += d.cost || 0;
		} else if (e.kind === "fault" && e.task) {
			for (const model of taskModels.get(taskKey(e)) || []) {
				const r = row(model);
				if (d.severity === "error") r.errors += 1;
			else if (d.severity === "warn") r.warns += 1;
			}
		}
	}
	return [...rows.values()].sort((a, b) => a.model.localeCompare(b.model));
}

function renderModels(events) {
	const rows = modelsTable(events);
	if (!rows.length) return ["None."];
	const out = ["| model | roles | tasks | reviews | tokens | cost | error faults | warn faults |", "|---|---|---|---|---|---|---|---|"];
	for (const r of rows)
		out.push(`| ${r.model} | ${[...r.roles].sort().join(", ")} | ${r.tasks.size} | ${r.reviews} | ${r.tokens} | ${money(r.cost)} | ${r.errors} | ${r.warns} |`);
	return out;
}

function render(trace, events) {
	const t0 = Date.parse(events[0].ts);
	const plans = new Map();
	for (const e of events) {
		if (!e.plan) continue;
		// plan.audit carries the PLAN round in e.round, so it must not seed or update the Rounds table's round.
		const isPlanAudit = e.kind === "plan.audit";
		const p = plans.get(e.plan) || { id: e.plan, round: isPlanAudit ? undefined : e.round, cost: 0 };
		if (e.kind === "plan.received") p.parent = e.parent?.replace(/^plan:/, "");
		if (e.kind === "gate") p.gate = e.data;
		if (e.kind === "plan.end") Object.assign(p, { cost: e.data.cost, dur: e.data.duration_s, done: e.data.done, failed: e.data.failed, skipped: e.data.skipped });
		if (e.kind === "audit.verdict") p.verdict = e.data;
		if (e.round && !isPlanAudit) p.round = e.round;
		plans.set(e.plan, p);
	}
	const faults = events.filter((e) => e.kind === "fault");
	const planAudits = events.filter((e) => e.kind === "plan.audit");
	const total = [...plans.values()].reduce((n, p) => n + (p.cost || 0), 0);
	const last = [...plans.values()].at(-1);
	const lastAudit = planAudits.at(-1);
	// The audit column and the audit.verdict half of the headline are legacy (the old result audit).
	const auditText = lastAudit
		? `plan audit: ${String(lastAudit.data?.verdict ?? "").toUpperCase()} audit round ${lastAudit.data?.audit_round ?? lastAudit.data?.round ?? lastAudit.round ?? "-"}`
		: `audit ${last?.verdict ? String(last.verdict.verdict).toUpperCase() : "none yet"}`;
	const out = [`# Trace ${trace}`, ""];
	out.push(
		`${plans.size} plan(s) over ${clock(Date.parse(events.at(-1).ts) - t0)}, worker cost ${money(total)}. ` +
			`Latest: ${last ? `${last.id}, gate ${last.gate ? (last.gate.pass ? "PASS" : "FAIL") : "n/a"}, ${auditText}` : "none"}.`,
		"",
		"## Rounds",
		"",
		"| round | plan | follows | tasks done/failed/skipped | gate | audit | cost |",
		"|---|---|---|---|---|---|---|",
	);
	for (const p of plans.values())
		out.push(
			`| ${p.round ?? "-"} | ${p.id} | ${p.parent ?? "-"} | ${p.done ?? "-"}/${p.failed ?? "-"}/${p.skipped ?? "-"} | ${p.gate ? (p.gate.pass ? "PASS" : "FAIL") : "-"} | ${p.verdict ? `${String(p.verdict.verdict).toUpperCase()} (${p.verdict.findings ?? 0})` : "-"} | ${money(p.cost)} |`,
		);

	out.push("", "## Plan audit", "");
	if (!planAudits.length) out.push("None.");
	else {
		out.push("| plan | audit round | verdict | blockers | majors | minors |", "|---|---|---|---|---|---|");
		for (const e of planAudits) {
			const d = e.data || {};
			out.push(
				`| ${e.plan ?? "-"} | ${d.audit_round ?? d.round ?? e.round ?? "-"} | ${String(d.verdict ?? "").toUpperCase() || "-"} | ${d.blockers ?? 0} | ${d.majors ?? 0} | ${d.minors ?? 0} |`,
			);
		}
	}

	out.push("", "## Faults", "");
	if (!faults.length) out.push("None.");
	else for (const f of faults) out.push(`- ${f.plan}${f.task ? `/${f.task}` : ""} [${f.data.severity}] **${f.data.code}**: ${f.data.message}`);

	out.push("", "## Models", "", ...renderModels(events));

	out.push("", "## Timeline", "", "| t | actor | event | span | detail |", "|---|---|---|---|---|");
	for (const e of events) out.push(`| +${clock(Date.parse(e.ts) - t0)} | ${e.actor} | ${e.kind}${e.attempt > 1 ? ` #${e.attempt}` : ""} | \`${e.span}\` | ${detail(e).replace(/\|/g, "\\|")} |`);
	out.push("", "Spans link by `parent`: task -> plan -> the plan it follows (fix rounds); audit -> plan. Per-task prompts and worker reports are in `.plans/done/<plan>/`.", "");
	return out.join("\n");
}

// ---------- main ----------

switch (cmd) {
	case "event":
		cmdEvent();
		break;
	case "wait":
		await cmdWait();
		break;
	case "gate":
		cmdGate();
		break;
	case "report":
		cmdReport();
		break;
	case "new-id":
		cmdNewId();
		break;
	default:
		die("usage: trace.mjs event|wait|gate|report|new-id (see the header of this file)", 64);
}
