#!/usr/bin/env node
/**
 * Preflight a dispatch plan with the dispatcher's own code, so the plan-auditor
 * and the orchestrator can check a plan before it is flipped to ready.
 *
 *   node preflight.mjs <plan-file> [--root <repo>]
 *
 * It finds pi-plan-dispatch (core.ts, verify.ts) in this order:
 * PI_PLAN_DISPATCH_DIR, <root>/pi-plan-dispatch, the local `packages` of
 * ~/.pi/agent/settings.json, ~/.pi/agent/extensions/pi-plan-dispatch.
 *
 * Exit codes: 0 pass / 1 errors / 2 dispatcher modules not found / 64 usage.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const USAGE = "usage: node preflight.mjs <plan-file> [--root <repo>]";

/** `~` means the home directory; HOME can redirect it in tests. */
function expand(p) {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}

function isDispatcherDir(dir) {
	return fs.existsSync(path.join(dir, "core.ts")) && fs.existsSync(path.join(dir, "verify.ts"));
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

/** Where the dispatcher modules may live, most specific first. */
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

function parseArgs(argv) {
	const args = { file: undefined, root: process.cwd() };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--root") {
			const value = argv[++i];
			if (!value) return { error: `--root needs a directory\n${USAGE}` };
			args.root = path.resolve(value);
		} else if (args.file === undefined) {
			args.file = argv[i];
		} else {
			return { error: `too many arguments\n${USAGE}` };
		}
	}
	return args;
}

/** The id the dispatcher falls back to: the file name without .md.draft or .md. */
function fallbackId(file) {
	const base = path.basename(file);
	if (base.endsWith(".md.draft")) return base.slice(0, -".md.draft".length);
	if (base.endsWith(".md")) return base.slice(0, -".md".length);
	return base;
}

/**
 * Dispatcher problems first, then the verify-command errors and warnings, in
 * the order the dispatcher checks them.
 */
function collectProblems(core, verify, plan, cfg, root) {
	const errors = core.preflightPlan(plan, cfg);
	const warnings = [];
	const checks = [["plan", plan.verify], ...plan.tasks.map((task) => [`task ${task.id}`, task.verify])];
	for (const [label, command] of checks) {
		if (!command) {
			warnings.push(`${label}: no verify: command`);
			continue;
		}
		if (!verify.commandExists(root, command)) errors.push(`${label}: verify command not found: ${command.split(/\s+/)[0]}`);
	}
	return { errors, warnings };
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.error) {
		console.error(`ERROR: ${args.error}`);
		return 64;
	}
	if (!args.file) {
		console.error(USAGE);
		return 64;
	}

	const root = args.root;
	const candidates = dispatcherCandidates(root);
	const dir = candidates.find(isDispatcherDir);
	if (!dir) {
		console.error(`ERROR: cannot find the pi-plan-dispatch modules (core.ts, verify.ts). Tried:\n${candidates.map((d) => `  ${d}`).join("\n")}`);
		return 2;
	}
	console.error(`dispatcher: ${dir}`);
	const core = await import(pathToFileURL(path.join(dir, "core.ts")).href);
	const verify = await import(pathToFileURL(path.join(dir, "verify.ts")).href);

	const file = path.resolve(args.file);
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (e) {
		console.log(`ERROR: cannot read ${file}: ${e.message}`);
		return 1;
	}

	let plan;
	try {
		plan = core.parsePlan(text, fallbackId(file));
	} catch (e) {
		console.log(`ERROR: ${e instanceof core.PlanParseError ? e.message : String(e?.message ?? e)}`);
		return 1;
	}

	const cfg = core.loadConfig(core.getDirs(root));
	const { errors, warnings } = collectProblems(core, verify, plan, cfg, root);
	for (const error of errors) console.log(`ERROR: ${error}`);
	for (const warning of warnings) console.log(`WARN: ${warning}`);
	if (errors.length) return 1;
	console.log(`OK: ${plan.id}, ${plan.tasks.length} tasks`);
	return 0;
}

process.exitCode = await main();
