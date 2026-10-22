#!/usr/bin/env node
/**
 * Create .plans/config.json with the dispatcher's real defaults, so every
 * setting (the role models included) is visible and editable instead of
 * written by hand.
 *
 *   node config-init.mjs [--root <repo>] [--minimal] [--force] [--print]
 *
 * It finds pi-plan-dispatch exactly like preflight.mjs does (PI_PLAN_DISPATCH_DIR,
 * <root>/pi-plan-dispatch, the local `packages` of ~/.pi/agent/settings.json,
 * ~/.pi/agent/extensions/pi-plan-dispatch) and takes DEFAULT_CONFIG from core.ts,
 * so the written file cannot drift from the code.
 *
 * Exit codes: 0 done / 1 config exists without --force / 2 modules not found / 64 usage.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const USAGE = "usage: node config-init.mjs [--root <repo>] [--minimal] [--force] [--print]";

/** The role fields written for each role; prompts stay in the code. */
const ROLE_FIELDS = ["model", "thinking", "readonly"];

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

/**
 * Where the dispatcher modules may live, most specific first. There is no
 * fallback next to this script: it would find this repo's own copy and hide a
 * missing install.
 */
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
	const args = { root: process.cwd(), minimal: false, force: false, print: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--root") {
			const value = argv[++i];
			if (!value) return { error: `--root needs a directory\n${USAGE}` };
			args.root = path.resolve(expand(value));
		} else if (arg === "--minimal") {
			args.minimal = true;
		} else if (arg === "--force") {
			args.force = true;
		} else if (arg === "--print") {
			args.print = true;
		} else {
			return { error: `unknown option: ${arg}\n${USAGE}` };
		}
	}
	return args;
}

/** Every role as the fields its default actually sets: no prompts, no invented values. */
function rolesForFile(defaults) {
	const out = {};
	for (const [name, role] of Object.entries(defaults.roles ?? {})) {
		const entry = {};
		for (const field of ROLE_FIELDS) {
			if (role?.[field] !== undefined) entry[field] = role[field];
		}
		out[name] = entry;
	}
	return out;
}

/** The full defaults, plus the orchestrator-only `autoReady`. */
function fullConfig(defaults) {
	const out = { autoReady: false };
	for (const [key, value] of Object.entries(defaults)) {
		if (key === "roles") out[key] = rolesForFile(defaults);
		else out[key] = Array.isArray(value) ? [...value] : value;
	}
	return out;
}

/** Only the review model and thinking level, the fields most likely to be edited. */
function minimalConfig(defaults) {
	const review = defaults.roles?.review ?? {};
	return {
		autoReady: false,
		roles: { review: { model: review.model, thinking: review.thinking } },
	};
}

function serialize(config) {
	return `${JSON.stringify(config, null, 2)}\n`;
}

/** Write through a temp file in the same folder, then rename it into place. */
function writeAtomic(file, text) {
	const dir = path.dirname(file);
	fs.mkdirSync(dir, { recursive: true });
	const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}`);
	try {
		fs.writeFileSync(tmp, text);
		fs.renameSync(tmp, file);
	} finally {
		fs.rmSync(tmp, { force: true });
	}
}

/** Copy an existing config aside before it is replaced; returns the backup path. */
function backupConfig(file) {
	const copy = `${file}.bak-${Date.now()}`;
	fs.copyFileSync(file, copy);
	return copy;
}

/** Returns `{ ok: true, backup? }` or `{ ok: false, reason: "exists" }`. */
function writeConfig(file, text, force) {
	if (fs.existsSync(file)) {
		if (!force) return { ok: false, reason: "exists" };
		const copy = backupConfig(file);
		writeAtomic(file, text);
		return { ok: true, backup: copy };
	}
	writeAtomic(file, text);
	return { ok: true };
}

async function loadDefaults(root) {
	const candidates = dispatcherCandidates(root);
	const dir = candidates.find(isDispatcherDir);
	if (!dir) {
		const tried = candidates.map((d) => `  ${d}`).join("\n");
		throw new Error(`cannot find the pi-plan-dispatch modules (core.ts, verify.ts). Tried:\n${tried}`);
	}
	const core = await import(pathToFileURL(path.join(dir, "core.ts")).href);
	return core.DEFAULT_CONFIG;
}

async function main(argv) {
	const args = parseArgs(argv);
	if (args.error) {
		console.error(`ERROR: ${args.error}`);
		return 64;
	}

	let defaults;
	try {
		defaults = await loadDefaults(args.root);
	} catch (e) {
		console.error(`ERROR: ${e?.message ?? e}`);
		return 2;
	}

	const config = args.minimal ? minimalConfig(defaults) : fullConfig(defaults);
	const text = serialize(config);

	if (args.print) {
		process.stdout.write(text);
		return 0;
	}

	const file = path.join(args.root, ".plans", "config.json");
	const result = writeConfig(file, text, args.force);
	if (!result.ok) {
		console.error(`ERROR: ${file} already exists; pass --force to replace it`);
		return 1;
	}
	if (result.backup) console.error(`backup: ${result.backup}`);
	console.log(`wrote ${file}`);
	console.log("hint: change roles.review.model when the free review model's period ends; run /plans roles and /plans roles test in Pi to check the roles.");
	return 0;
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) process.exitCode = await main(process.argv.slice(2));

export { dispatcherCandidates, fullConfig, minimalConfig, parseArgs, serialize, writeConfig };
