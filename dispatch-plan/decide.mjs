#!/usr/bin/env node
/**
 * The decider CLI: suggest a thinking level per task (`effort`), score
 * plan-audit findings and roll them into a proposal (`audit`), and report what
 * the recorded decisions led to (`stats`).
 *
 *   node decide.mjs effort --plan <file> --trace <T> [--root <dir>]
 *   node decide.mjs audit  --plan <file> --spec <file> --findings <file>
 *                          --audit-round <n> --verdict pass|fail --trace <T> [--root <dir>]
 *   node decide.mjs stats  [--root <dir>]
 *
 * The pure rules live in decide-core.mjs and the outcome joins in
 * decide-stats.mjs. The config parse, the effort question and rule and the
 * network live in the extension, under `pi-plan-dispatch/decider/`, and are
 * loaded from the dispatcher folder the same way `core.ts` is loaded for the
 * plan parser. This file reads the files, runs the privacy gate, calls the
 * backend once per request and writes the trace events. `--root` defaults to
 * the working directory.
 *
 * The decider modules are loaded once, after every usage check and before the
 * config, privacy and key checks, so a missing or stale dispatcher folder
 * exits 2 first. That is the one change to the exit order, and docs/decider.md
 * documents it.
 *
 * Exit codes: 0 ok / 2 dispatcher modules not found / 3 no key / 4 disabled /
 *             5 not allowed / 6 backend error / 64 usage or too many requests.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
	MAX_REQUESTS,
	aggregate,
	auditRequest,
	parseSpecRequirements,
	proposal,
	realDefectP,
} from "./decide-core.mjs";
import { renderStats, statsReport } from "./decide-stats.mjs";

const USAGE = [
	"usage: node decide.mjs effort --plan <file> --trace <T> [--root <dir>]",
	"       node decide.mjs audit --plan <file> --spec <file> --findings <file> --audit-round <n> --verdict pass|fail --trace <T> [--root <dir>]",
	"       node decide.mjs stats [--root <dir>]",
].join("\n");

/** The flags the CLI reads, as `--flag` to the name it is stored under. */
const FLAGS = {
	"--root": "root",
	"--plan": "plan",
	"--spec": "spec",
	"--findings": "findings",
	"--audit-round": "auditRound",
	"--verdict": "verdict",
	"--trace": "trace",
};

/** The flags each command needs, so a missing one is a usage error before anything runs. */
const REQUIRED = {
	effort: [
		["plan", "--plan"],
		["trace", "--trace"],
	],
	audit: [
		["plan", "--plan"],
		["spec", "--spec"],
		["findings", "--findings"],
		["auditRound", "--audit-round"],
		["verdict", "--verdict"],
		["trace", "--trace"],
	],
	stats: [],
};

const SEVERITIES = ["blocker", "major", "minor"];
const DISPATCHER_FILES = ["core.ts", "verify.ts", path.join("decider", "backend.ts")];
const LOCAL_KEY_PATTERN = /sk-or-[A-Za-z0-9_-]+/g;
const REDACTED = "<redacted>";
const GATE_TIMEOUT_MS = 30000;
const EVENT_TIMEOUT_MS = 30000;
const NOT_ALLOWED = "not allowed: the vault does not allow this repo";
const NO_KEY = "no key: set OPENROUTER_API_KEY or create ~/.config/pi-plan-dispatch/openrouter.key";

function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error) {
	if (error instanceof Error) return error.message;
	return String(error);
}

/**
 * While the dispatcher modules are not loaded: every `sk-or-` token is masked,
 * so a usage or argument error can never print a key. The shared `redact` of
 * the backend replaces this one once the modules are loaded.
 */
function localRedact(text) {
	return String(text).replace(LOCAL_KEY_PATTERN, REDACTED);
}

let redactText = localRedact;

/** One line on stdout, redacted, so a key can never reach it (R3). */
function say(text) {
	console.log(redactText(text));
}

/** One line on stderr, redacted (R3). */
function warn(text) {
	console.error(redactText(text));
}

/** `~` means the home directory; HOME can redirect it in tests. */
function expand(p) {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}

function isDispatcherDir(dir) {
	return DISPATCHER_FILES.every((name) => fs.existsSync(path.join(dir, name)));
}

/** Local package folders from the `packages` array, resolved against that file. */
function settingsPackageDirs() {
	const file = path.join(os.homedir(), ".pi", "agent", "settings.json");
	let settings;
	try {
		settings = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return [];
	}
	const base = path.dirname(file);
	const packages = Array.isArray(settings?.packages) ? settings.packages : [];
	return packages
		.filter((entry) => typeof entry === "string" && entry && !entry.startsWith("npm:"))
		.map((entry) => path.resolve(base, expand(entry)))
		.filter((dir) => path.basename(dir).endsWith("pi-plan-dispatch"));
}

/** Where the dispatcher modules may live, most specific first (the same search as preflight.mjs). */
function dispatcherCandidates(root) {
	const home = os.homedir();
	const fromEnv = process.env.PI_PLAN_DISPATCH_DIR;
	return [
		...(fromEnv ? [path.resolve(expand(fromEnv))] : []),
		path.join(root, "pi-plan-dispatch"),
		...settingsPackageDirs(),
		path.join(home, ".pi", "agent", "extensions", "pi-plan-dispatch"),
	];
}

/** The id the dispatcher falls back to: the file name without .md.draft or .md. */
function fallbackId(file) {
	const base = path.basename(file);
	if (base.endsWith(".md.draft")) return base.slice(0, -".md.draft".length);
	if (base.endsWith(".md")) return base.slice(0, -".md".length);
	return base;
}

function parseArgs(argv) {
	const flags = {};
	const rest = [];
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (!arg.startsWith("--")) {
			rest.push(arg);
			continue;
		}
		const name = FLAGS[arg];
		if (name === undefined) return { error: `unknown flag: ${arg}` };
		const value = argv[i + 1];
		if (value === undefined || value === "") return { error: `${arg} needs a value` };
		flags[name] = value;
		i += 1;
	}
	return { flags, rest };
}

/** A usage problem: one line, then the usage, on stderr, and exit 64. */
function usage(message) {
	warn(`${message}\n${USAGE}`);
	return 64;
}

/** The `decider` value of `.plans/config.json`; a missing or broken file gives the defaults. */
function readDeciderConfig(root, loadDeciderConfig) {
	const file = path.join(root, ".plans", "config.json");
	let parsed;
	try {
		parsed = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return loadDeciderConfig(undefined);
	}
	return loadDeciderConfig(parsed?.decider);
}

/**
 * The three decider modules of the dispatcher folder, loaded once and only for
 * `effort` and `audit`, so `stats` and the usage errors never depend on it. A
 * missing folder, or one without `decider/backend.ts`, is exit 2.
 */
async function loadDecider(root) {
	const dir = dispatcherCandidates(root).find(isDispatcherDir);
	if (dir === undefined) {
		return {
			code: 2,
			message: "cannot find the pi-plan-dispatch modules (core.ts, verify.ts, decider/backend.ts)",
		};
	}
	let config;
	let effort;
	let backend;
	try {
		config = await import(pathToFileURL(path.join(dir, "decider", "config.ts")).href);
		effort = await import(pathToFileURL(path.join(dir, "decider", "effort.ts")).href);
		backend = await import(pathToFileURL(path.join(dir, "decider", "backend.ts")).href);
	} catch (error) {
		return { code: 2, message: `cannot load the dispatcher: ${errorText(error)}` };
	}
	redactText = (text, key) => backend.redact(text, key);
	return { dir, mods: { config, effort, backend } };
}

/**
 * The privacy gate (R4): `vault.mjs repo check` reads the repository from its
 * working directory and ignores `--root`, so the child runs in the repo root.
 * Only an exit 0 with exactly `full` lets a request through; the environment is
 * inherited unchanged, so a worker, whose vault access is removed, is refused.
 */
function fullModeRepo(root) {
	const result = spawnSync(
		process.execPath,
		[path.join(import.meta.dirname, "vault.mjs"), "repo", "check", "--root", root],
		{ cwd: root, encoding: "utf8", timeout: GATE_TIMEOUT_MS },
	);
	return result.status === 0 && (result.stdout ?? "").trim() === "full";
}

/** The config, the privacy gate and the key (R5, R4, R3), in that order. */
function prepare(root, command, mods) {
	const config = readDeciderConfig(root, mods.config.loadDeciderConfig);
	const wanted = command === "effort" ? "apply" : "shadow";
	const mode = command === "effort" ? config.effort : config.audit;
	if (mode !== wanted) {
		say("disabled");
		return { code: 4 };
	}
	if (!fullModeRepo(root)) {
		warn(NOT_ALLOWED);
		return { code: 5 };
	}
	const key = mods.backend.loadKey(process.env, os.homedir());
	if (key === null) {
		warn(NO_KEY);
		return { code: 3 };
	}
	return { config, key };
}

/** The plan, parsed by the dispatcher's own parser; `code` and `message` on a stop. */
async function loadPlan(file, dir) {
	let text;
	try {
		text = fs.readFileSync(path.resolve(file), "utf8");
	} catch {
		return { code: 64, message: `cannot read the plan file: ${file}` };
	}
	let core;
	try {
		core = await import(pathToFileURL(path.join(dir, "core.ts")).href);
	} catch (error) {
		return { code: 2, message: `cannot load the dispatcher: ${errorText(error)}` };
	}
	try {
		return { plan: core.parsePlan(text, fallbackId(file)) };
	} catch (error) {
		return { code: 64, message: `cannot parse the plan: ${errorText(error)}` };
	}
}

/** A file as text, or `code` and `message` when it cannot be read. */
function readTextFile(file, label) {
	try {
		return { text: fs.readFileSync(path.resolve(file), "utf8") };
	} catch {
		return { code: 64, message: `cannot read the ${label} file: ${file}` };
	}
}

/**
 * The findings file of `audit` (R7): an array of `{id, severity, text, tasks?,
 * reqs?}`. A finding without an id, a known severity or a text is a usage error.
 */
function readFindings(file) {
	const read = readTextFile(file, "findings");
	if (read.code !== undefined) return read;
	let parsed;
	try {
		parsed = JSON.parse(read.text);
	} catch {
		return { code: 64, message: `the findings file is not JSON: ${file}` };
	}
	if (!Array.isArray(parsed)) return { code: 64, message: `the findings file is not an array: ${file}` };
	const list = [];
	for (const [index, finding] of parsed.entries()) {
		const where = `finding ${index + 1}`;
		if (!isPlainObject(finding)) return { code: 64, message: `${where} is not an object` };
		if (typeof finding.id !== "string" || finding.id === "") {
			return { code: 64, message: `${where} has no id` };
		}
		if (!SEVERITIES.includes(finding.severity)) {
			return { code: 64, message: `${where} has an invalid severity: ${finding.severity}` };
		}
		if (typeof finding.text !== "string") return { code: 64, message: `${where} has no text` };
		list.push(finding);
	}
	return { list };
}

/**
 * The backend of this run: the fake replay when the environment asks for it and
 * allows it, the OpenRouter backend otherwise. The fake is a test switch and
 * needs both variables, so a stray one can never reach the network in a test.
 */
function makeBackend(config, key, mods, env = process.env) {
	const fake = env.DECIDE_FAKE_BACKEND;
	if (env.DECIDE_ALLOW_FAKE === "1" && typeof fake === "string" && fake !== "") {
		return replayBackend(fake, mods);
	}
	return mods.backend.openRouterBackend({ key, model: config.model, timeoutMs: config.timeoutMs });
}

/** A backend that replays a JSON array of results in call order; tests only. */
function replayBackend(file, mods) {
	let results = [];
	try {
		results = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		results = [];
	}
	if (!Array.isArray(results)) results = [];
	let index = 0;
	return mods.backend.fakeBackend(() => {
		const result = results[index];
		index += 1;
		if (!isPlainObject(result)) {
			throw new mods.backend.BackendError("fake backend: no result left for this request", { kind: "malformed" });
		}
		return result;
	});
}

/** One request through the backend, refusing an answer that is not the agreed shape (R2). */
async function askOne(backend, request, mods) {
	const result = await backend.ask(request);
	if (!isPlainObject(result) || !isPlainObject(result.answers)) {
		throw new mods.backend.BackendError("the backend answer is malformed", { kind: "malformed" });
	}
	return result;
}

function costOf(result) {
	const cost = result?.usage?.cost;
	return typeof cost === "number" && Number.isFinite(cost) ? cost : 0;
}

function modelOf(result) {
	return typeof result?.model === "string" ? result.model : null;
}

/** Every string stored passes through `redact`, so a key can never land in a trace (R3). */
function writeEvent({ root, trace, plan, round, kind, data, key }) {
	const args = [
		path.join(import.meta.dirname, "trace.mjs"),
		"event",
		"--trace",
		trace,
		"--actor",
		"decider",
		"--kind",
		kind,
		"--plan",
		plan,
		"--root",
		root,
		"--data",
		redactText(JSON.stringify(data), key),
	];
	if (round !== undefined) args.push("--round", String(round));
	const result = spawnSync(process.execPath, args, { encoding: "utf8", timeout: EVENT_TIMEOUT_MS });
	if (result.status !== 0) warn("warning: could not write the trace event");
}

/** The decided JSON and nothing else, redacted, on stdout. */
function printJson(value, key) {
	console.log(redactText(JSON.stringify(value), key));
}

/** A backend or malformed-answer failure: one stderr line, one event, exit 6 (R9). */
function backendFailure({ error, command, root, trace, plan, key, mods }) {
	const failure =
		error instanceof mods.backend.BackendError
			? error
			: new mods.backend.BackendError(`malformed answer: ${errorText(error)}`, {
					status: 0,
					kind: "malformed",
				});
	const message = redactText(failure.message, key);
	console.error(redactText(`backend error: ${message}`, key));
	writeEvent({
		root,
		trace,
		plan: plan.id,
		round: plan.round,
		kind: "decision.error",
		data: { command, status: failure.status, kind: failure.kind, message },
		key,
	});
	return 6;
}

/** One request per sent task, one suggestion and one event each, then the JSON. */
async function runEffort({ backend, config, plan, tasks, requests, root, trace, key, mods }) {
	const results = [];
	for (const request of requests) results.push(await askOne(backend, request, mods));
	const rows = [];
	let cost = 0;
	for (const [index, result] of results.entries()) {
		const suggestion = mods.effort.suggestEffort(result.answers, config.thresholds);
		const task = tasks[index];
		const taskCost = costOf(result);
		cost += taskCost;
		rows.push({ task: task.id, ...suggestion });
		writeEvent({
			root,
			trace,
			plan: plan.id,
			round: plan.round,
			kind: "decision.effort",
			data: {
				task: task.id,
				suggested: suggestion.suggested,
				probabilities: suggestion.probabilities,
				confidence: suggestion.confidence,
				complexity: suggestion.complexity,
				model: modelOf(result),
				cost: taskCost,
				mode: config.effort,
			},
			key,
		});
	}
	printJson({ model: results.length ? modelOf(results[0]) : null, cost, tasks: rows }, key);
	return 0;
}

/** One request per finding, the aggregate, the proposal, one event for the command, then the JSON. */
async function runAudit({ backend, config, plan, findings, requests, verdict, auditRound, root, trace, key, mods }) {
	const results = [];
	for (const request of requests) results.push(await askOne(backend, request, mods));
	const scored = findings.map((finding, index) => ({
		id: finding.id,
		severity: finding.severity,
		p: realDefectP(results[index].answers),
	}));
	const value = aggregate(scored, config.thresholds);
	const decided = proposal(verdict, scored, value, config.thresholds);
	const cost = results.reduce((sum, result) => sum + costOf(result), 0);
	const data = {
		model: results.length ? modelOf(results[0]) : null,
		cost,
		audit_round: auditRound,
		verdict,
		proposal: decided,
		aggregate: value,
		findings: scored,
	};
	writeEvent({ root, trace, plan: plan.id, round: plan.round, kind: "decision.audit", data, key });
	printJson(data, key);
	return 0;
}

async function effort(root, flags, mods, dir) {
	const ready = prepare(root, "effort", mods);
	if (ready.code !== undefined) return ready.code;
	const { config, key } = ready;
	const loaded = await loadPlan(flags.plan, dir);
	if (loaded.code !== undefined) {
		warn(loaded.message);
		return loaded.code;
	}
	const plan = loaded.plan;
	const tasks = plan.tasks
		.map((task) => ({
			id: task.id,
			body: task.body,
			files: [...task.files],
			role: task.role ?? "implement",
		}))
		.filter((task) => task.role === "implement" || task.role === "qa");
	if (tasks.length > MAX_REQUESTS) {
		warn(`too many requests: ${tasks.length} tasks, the limit is ${MAX_REQUESTS}`);
		return 64;
	}
	const requests = tasks.map((task) => mods.effort.effortRequest(task));
	const backend = makeBackend(config, key, mods);
	try {
		return await runEffort({ backend, config, plan, tasks, requests, root, trace: flags.trace, key, mods });
	} catch (error) {
		return backendFailure({ error, command: "effort", root, trace: flags.trace, plan, key, mods });
	}
}

/** A `--verdict` or `--audit-round` problem, checked before the modules are loaded. */
function auditFlagProblem(flags) {
	const verdict = flags.verdict;
	if (verdict !== "pass" && verdict !== "fail") return "--verdict must be pass or fail";
	const auditRound = Number(flags.auditRound);
	if (!Number.isInteger(auditRound) || auditRound < 1) {
		return "--audit-round must be a positive integer";
	}
	return undefined;
}

async function audit(root, flags, mods, dir) {
	const verdict = flags.verdict;
	const auditRound = Number(flags.auditRound);
	const ready = prepare(root, "audit", mods);
	if (ready.code !== undefined) return ready.code;
	const { config, key } = ready;
	const loaded = await loadPlan(flags.plan, dir);
	if (loaded.code !== undefined) {
		warn(loaded.message);
		return loaded.code;
	}
	const plan = loaded.plan;
	const spec = readTextFile(flags.spec, "spec");
	if (spec.code !== undefined) return usage(spec.message);
	const findings = readFindings(flags.findings);
	if (findings.code !== undefined) return usage(findings.message);
	if (findings.list.length > MAX_REQUESTS) {
		warn(`too many requests: ${findings.list.length} findings, the limit is ${MAX_REQUESTS}`);
		return 64;
	}
	const ctx = {
		tasks: Object.fromEntries(plan.tasks.map((task) => [task.id, task.body])),
		reqs: parseSpecRequirements(spec.text),
		planContext: plan.context,
	};
	const requests = findings.list.map((finding) => auditRequest(finding, ctx));
	const backend = makeBackend(config, key, mods);
	try {
		return await runAudit({
			backend,
			config,
			plan,
			findings: findings.list,
			requests,
			verdict,
			auditRound,
			root,
			trace: flags.trace,
			key,
			mods,
		});
	} catch (error) {
		return backendFailure({ error, command: "audit", root, trace: flags.trace, plan, key, mods });
	}
}

/** Every trace of the root, joined and rendered; no config check, no network (R10). */
function stats(root) {
	const dir = path.join(root, ".plans", "traces");
	let names = [];
	try {
		names = fs
			.readdirSync(dir)
			.filter((name) => name.endsWith(".jsonl"))
			.sort();
	} catch {
		names = [];
	}
	const events = [];
	for (const name of names) {
		let text;
		try {
			text = fs.readFileSync(path.join(dir, name), "utf8");
		} catch {
			continue;
		}
		for (const line of text.split("\n")) {
			if (line.trim() === "") continue;
			try {
				events.push(JSON.parse(line));
			} catch {
				// A damaged line is skipped: stats never fails on a broken trace.
			}
		}
	}
	say(renderStats(statsReport(events)));
	return 0;
}

async function main() {
	const parsed = parseArgs(process.argv.slice(2));
	if (parsed.error !== undefined) return usage(parsed.error);
	const [command, ...extra] = parsed.rest;
	if (command === undefined) return usage("a command is required");
	if (extra.length > 0) return usage(`too many arguments: ${extra.join(" ")}`);
	if (!Object.hasOwn(REQUIRED, command)) return usage(`unknown command: ${command}`);
	const flags = parsed.flags;
	const missing = REQUIRED[command].filter(([name]) => flags[name] === undefined);
	if (missing.length > 0) {
		return usage(`missing ${missing.map(([, flag]) => flag).join(", ")}`);
	}
	const root = path.resolve(flags.root ?? process.cwd());
	if (command === "stats") return stats(root);
	if (command === "audit") {
		const problem = auditFlagProblem(flags);
		if (problem !== undefined) return usage(problem);
	}
	const loaded = await loadDecider(root);
	if (loaded.code !== undefined) {
		warn(loaded.message);
		return loaded.code;
	}
	return command === "effort"
		? effort(root, flags, loaded.mods, loaded.dir)
		: audit(root, flags, loaded.mods, loaded.dir);
}

process.exitCode = await main();
