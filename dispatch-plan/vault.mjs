#!/usr/bin/env node
/**
 * The agent-vault command line (R5): notes, the log, the index, the repo
 * allowlist, boot, lint, stats and sync over the pure modules in
 * pi-plan-dispatch/vault/. The init, setup and doctor commands live in
 * vault-admin.mjs and get their own entry in the command table below.
 *
 *   node vault.mjs <command> [arguments] [flags]
 *
 * It finds pi-plan-dispatch (core.ts, verify.ts) exactly like preflight.mjs does
 * (PI_PLAN_DISPATCH_DIR, <cwd>/pi-plan-dispatch, the local `packages` of
 * ~/.pi/agent/settings.json, ~/.pi/agent/extensions/pi-plan-dispatch) and loads
 * the vault modules from its vault/ folder, so this file imports no dispatcher
 * code of its own.
 *
 * Every command checks in this order: a Pi worker refuses every command; a usage
 * error exits 64; the vault must be configured. A write command then refuses
 * during a rebase, refuses a vault schema newer than this CLI, checks the write
 * target is inside the vault, and runs under the vault lock.
 *
 * Exit codes: 0 done / 1 failure / 2 rejected / 3 repo not allowed / 4 vault
 * locked / 5 sync conflict / 6 partial (work add: some files unmirrored) /
 * 64 usage.
 *
 * The work, restore and config commands delegate to vault-work.mjs,
 * vault-restore.mjs and vault-config.mjs, which are loaded inside their
 * handlers so a partial copy of these scripts still runs the older commands.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { bootEventData, emitEvent } from "./vault-events.mjs";
import { findHarnessRoot, runDoctor, runInit, runSetup } from "./vault-admin.mjs";

const USAGE = [
	"usage: node vault.mjs <command> [arguments] [flags]",
	"",
	"commands:",
	"  resolve                                     print the vault path, host and remote",
	"  boot [--repo <slug>] [--budget <tokens>]    print the text an agent boots with",
	"  lint [--range]                              check the vault, exit 1 on an error",
	"  stats [--repo <slug> | --all]               count notes, boot tokens and repeats",
	"  note new <type> <basename> [--set key=value]... [--body-stdin]",
	"  note set <basename> [--set key=value]... [--body-stdin]",
	"  note status <basename> <open|closed|taken|dropped>",
	"  note rm <basename>",
	"  log append --repo <slug|-> [--trace <id>] <text...>",
	"  index rebuild",
	"  repo allow <slug-or-uri> --mode <full|meta|none>",
	"  repo list",
	"  repo check",
	"  sync pull",
	"  sync push [--summary <text>]",
	"  work add --trace <id> --root <repo> [--probes]  copy a finished request into work/",
	"  work pending --root <repo>                  list the finished requests the vault misses",
	"  restore --root <repo>                       rebuild specs and draft plans from the vault",
	"  config push --root <repo>                   copy .plans/config.json into the vault",
	"  config pull --root <repo> [--force]         write .plans/config.json from the vault",
	"  init [--path <dir>] [--remote <url>]         create a vault from the template",
	"  setup [--path <dir>] [--force]               write the config and install the skill",
	"  doctor                                      check the machine and the vault",
	"",
	"flags, anywhere: --vault <path> --json --trace <id> --root <repo>",
].join("\n");

const DEFAULT_BOOT_BUDGET = 4000;
const MODES = ["full", "meta", "none"];
/** The status values `note status` accepts, by note type. */
const STATUS_VALUES = { finding: ["open", "closed"], idea: ["open", "taken", "dropped"] };
const STATUS_HELP = "status works on finding notes (open, closed) and idea notes (open, taken, dropped)";
const REPO_KEY_RE = /^[a-z0-9.-]+(?:\/[a-z0-9._-]+){2,}$/;
const SET_KEY_RE = /^[A-Za-z0-9_-]+$/;
const REPOS_FILE = "repos.json";
const HARNESS_DIR = "pi-plan-dispatch-phase1";
/** Flags every command accepts; a command adds its own through `flags` in the table. */
const GLOBAL_FLAGS = new Set(["vault", "trace", "root", "json"]);

/** Every flag the CLI knows; a value flag consumes the next word. */
const FLAGS = {
	"--vault": { name: "vault", value: true },
	"--root": { name: "root", value: true },
	"--trace": { name: "trace", value: true },
	"--repo": { name: "repo", value: true },
	"--budget": { name: "budget", value: true },
	"--mode": { name: "mode", value: true },
	"--summary": { name: "summary", value: true },
	"--path": { name: "path", value: true },
	"--remote": { name: "remote", value: true },
	"--set": { name: "sets", value: true, repeat: true },
	"--force": { name: "force" },
	"--json": { name: "json" },
	"--body-stdin": { name: "bodyStdin" },
	"--range": { name: "range" },
	"--all": { name: "all" },
	"--probes": { name: "probes" },
};

/** The flag spelling for a parsed flag name, so an error can name it back. */
const FLAG_NAMES = new Map(Object.entries(FLAGS).map(([flag, spec]) => [spec.name, flag]));

const out = (text) => process.stdout.write(`${text}\n`);
const err = (text) => process.stderr.write(`${text}\n`);
const errorText = (error) => String(error?.message ?? error);

/** `~` means the home directory; HOME can redirect it in tests. */
function expand(value) {
	if (value === "~") return os.homedir();
	if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
	return value;
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

function findModuleDir(root) {
	const candidates = dispatcherCandidates(root);
	return { dir: candidates.find(isDispatcherDir), candidates };
}

async function loadModules(moduleDir) {
	const load = (name) => import(pathToFileURL(path.join(moduleDir, "vault", name)).href);
	const [schema, notes, privacy, url, lock, git] = await Promise.all([
		load("schema.ts"),
		load("notes.ts"),
		load("privacy.ts"),
		load("url.ts"),
		load("lock.ts"),
		load("git.ts"),
	]);
	return { schema, notes, privacy, url, lock, git };
}

function parseArgs(argv) {
	const flags = { sets: [] };
	const positionals = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith("--")) {
			positionals.push(arg);
			continue;
		}
		const spec = FLAGS[arg];
		if (spec === undefined) return { error: `unknown flag: ${arg}` };
		if (spec.value !== true) {
			flags[spec.name] = true;
			continue;
		}
		const value = argv[++i];
		if (value === undefined) return { error: `${arg} needs a value` };
		if (spec.repeat === true) flags[spec.name].push(value);
		else flags[spec.name] = value;
	}
	return { flags, positionals };
}

/**
 * The command table: `write: true` runs the rebase, schema, containment and lock
 * checks first, `args` is the positional range, `requiredFlags` the flags
 * without which the command cannot run, and `target` the path the containment
 * check covers. The init, setup and doctor commands add an entry with
 * `needsVault: false` and `write: false`, because they work on a vault that may
 * not exist or is not configured yet.
 */
const COMMANDS = {
	resolve: { args: [0, 0], run: cmdResolve },
	boot: { args: [0, 0], run: cmdBoot },
	lint: { args: [0, 0], run: cmdLint },
	stats: { args: [0, 0], run: cmdStats },
	note: {
		subcommands: {
			new: { write: true, target: noteTarget, args: [2, 2], run: cmdNoteNew },
			set: { write: true, target: storedNoteTarget, args: [1, 1], run: cmdNoteSet },
			status: { write: true, target: storedNoteTarget, args: [2, 2], run: cmdNoteStatus },
			rm: { write: true, target: storedNoteTarget, args: [1, 1], run: cmdNoteRm },
		},
	},
	log: {
		subcommands: {
			append: { write: true, target: (call) => rootFile(call.ctx.vaultPath, "log.md"), args: [0, Infinity], requiredFlags: ["repo"], run: cmdLogAppend },
		},
	},
	index: {
		subcommands: {
			rebuild: { write: true, target: (call) => rootFile(call.ctx.vaultPath, "index.md"), args: [0, 0], run: cmdIndexRebuild },
		},
	},
	repo: {
		subcommands: {
			allow: { write: true, target: (call) => rootFile(call.ctx.vaultPath, REPOS_FILE), args: [1, 1], requiredFlags: ["mode"], run: cmdRepoAllow },
			list: { args: [0, 0], run: cmdRepoList },
			check: { args: [0, 0], run: cmdRepoCheck },
		},
	},
	sync: {
		subcommands: {
			pull: { write: true, target: (call) => call.ctx.vaultPath, args: [0, 0], run: cmdSyncPull },
			push: { write: true, target: (call) => call.ctx.vaultPath, args: [0, 0], prelock: prelockSummary, run: cmdSyncPush },
		},
	},
	work: {
		subcommands: {
			add: {
				write: true,
				target: (call) => rootFile(call.ctx.vaultPath, "work"),
				args: [0, 0],
				flags: ["probes"],
				requiredFlags: ["trace", "root"],
				run: cmdWorkAdd,
			},
			pending: { args: [0, 0], flags: [], requiredFlags: ["root"], run: cmdWorkPending },
		},
	},
	restore: { args: [0, 0], flags: [], requiredFlags: ["root"], run: cmdRestore },
	config: {
		subcommands: {
			push: {
				write: true,
				target: (call) => rootFile(call.ctx.vaultPath, "config"),
				args: [0, 0],
				flags: [],
				requiredFlags: ["root"],
				run: cmdConfigPush,
			},
			pull: { args: [0, 0], flags: ["force"], requiredFlags: ["root"], run: cmdConfigPull },
		},
	},
	init: { needsVault: false, args: [0, 0], flags: ["path", "remote"], run: cmdInit },
	setup: { needsVault: false, args: [0, 0], flags: ["path", "force"], run: cmdSetup },
	doctor: { needsVault: false, args: [0, 0], flags: [], run: cmdDoctor },
};

function lookupCommand(positionals) {
	const name = positionals[0];
	if (name === undefined) return { error: "no command given" };
	const entry = COMMANDS[name];
	if (entry === undefined) return { error: `unknown command: ${name}` };
	if (entry.subcommands === undefined) return { name, spec: entry, depth: 1 };
	const sub = positionals[1];
	const spec = sub === undefined ? undefined : entry.subcommands[sub];
	if (spec === undefined) {
		const shown = [name, sub].filter((part) => part !== undefined).join(" ");
		return { error: `unknown command: ${shown}` };
	}
	return { name: `${name} ${sub}`, spec, depth: 2 };
}

/** The positional and flag count problems, which are usage errors and so come first. */
function argumentProblem(lookup, args, flags) {
	const [min, max] = lookup.spec.args ?? [0, Infinity];
	if (args.length < min) return `${lookup.name} needs ${min} argument${min === 1 ? "" : "s"}`;
	if (args.length > max) return `${lookup.name} takes at most ${max} argument${max === 1 ? "" : "s"}`;
	for (const flag of lookup.spec.requiredFlags ?? []) {
		if (flags[flag] === undefined) return `${lookup.name} needs --${flag}`;
	}
	if (lookup.spec.flags === undefined) return undefined;
	const allowed = new Set([...GLOBAL_FLAGS, ...lookup.spec.flags]);
	for (const [name, value] of Object.entries(flags)) {
		const given = name === "sets" ? value.length > 0 : value !== undefined;
		if (given && !allowed.has(name)) return `${lookup.name} does not take ${FLAG_NAMES.get(name) ?? name}`;
	}
	return undefined;
}

/**
 * The context the handlers share with vault-admin.mjs. The admin commands add
 * ctx.harnessRoot from findHarnessRoot and a moduleDir that already points at
 * the vault/ folder, which is where vault-admin.mjs loads schema.ts and notes.ts.
 */
function makeContext({ vaultPath, moduleDir }) {
	return {
		env: process.env,
		home: os.homedir(),
		cwd: process.cwd(),
		vaultPath,
		moduleDir,
		out,
		err,
	};
}

function harnessSettings(vault) {
	try {
		const parsed = JSON.parse(fs.readFileSync(path.join(vault, "harness.json"), "utf8"));
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function hostName(call) {
	const info = call.modules.notes.findVault(call.ctx.env, call.ctx.home);
	return info?.host ?? call.modules.schema.slug(os.hostname());
}

/** Today as a local YYYY-MM-DD, not the UTC date. */
function today() {
	const now = new Date();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	return `${now.getFullYear()}-${month}-${day}`;
}

function readStdin() {
	try {
		return fs.readFileSync(0, "utf8");
	} catch {
		return "";
	}
}

/** `--set key=value`: a repeated key becomes a list, a bad key is an error. */
function parseSets(raw) {
	const errors = [];
	const collected = new Map();
	for (const item of raw) {
		const at = item.indexOf("=");
		if (at <= 0) {
			errors.push(`--set needs key=value: ${item}`);
			continue;
		}
		const key = item.slice(0, at);
		if (!SET_KEY_RE.test(key)) {
			errors.push(`--set key must be letters, digits, _ or -: ${key}`);
			continue;
		}
		const values = collected.get(key) ?? [];
		values.push(item.slice(at + 1));
		collected.set(key, values);
	}
	const props = {};
	for (const [key, values] of collected) props[key] = values.length === 1 ? values[0] : values;
	return { props, errors };
}

/**
 * A run note for a meta repo takes its body from its own fields, so stdin is
 * refused there; every other body is stdin when asked for, else the fallback.
 */
function bodyForNote(call, { type, props, repos, bodyStdin, fallback }) {
	const repo = typeof props.repo === "string" ? props.repo : undefined;
	const metaRun = type === "run" && call.modules.privacy.modeFor(repos, repo) === "meta";
	if (metaRun) {
		if (bodyStdin) return { error: "a meta repo run note takes its body from its fields, not stdin" };
		return { body: call.modules.privacy.renderMetaRunBody(props) };
	}
	return { body: bodyStdin ? readStdin() : fallback };
}

/** The files the working directory's repo tracks, only for the note's own repo. */
function trackedFilesForNote(call, aliases, noteRepo) {
	if (typeof noteRepo !== "string" || noteRepo === "") return undefined;
	const repo = call.modules.url.repoSlugFromCwd(call.ctx.cwd, aliases);
	if (repo === undefined || repo !== noteRepo) return undefined;
	return trackedFiles(call.ctx.cwd);
}

function trackedFiles(cwd) {
	try {
		const top = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		if (top === "") return undefined;
		const listed = execFileSync("git", ["-C", top, "ls-files"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		return new Set(listed.split("\n").filter((line) => line !== ""));
	} catch {
		return undefined;
	}
}

/** The lint callback: the tracked files describe the working directory's repo only. */
function trackedFilesProvider(call, aliases) {
	const repo = call.modules.url.repoSlugFromCwd(call.ctx.cwd, aliases);
	const files = repo === undefined ? undefined : trackedFiles(call.ctx.cwd);
	return (noteRepo) => (noteRepo === repo ? files : undefined);
}

/** The nearest existing directory at or above the target. */
function nearestDir(target) {
	let dir = target;
	for (;;) {
		try {
			if (fs.statSync(dir).isDirectory()) return dir;
		} catch {
			// not there yet, so keep walking up
		}
		const up = path.dirname(dir);
		if (up === dir) return dir;
		dir = up;
	}
}

function insideVault(vault, target) {
	let root;
	try {
		root = fs.realpathSync(vault);
	} catch {
		return false;
	}
	let dir;
	try {
		dir = fs.realpathSync(nearestDir(target));
	} catch {
		return false;
	}
	const rel = path.relative(root, dir);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** The realpath check every write target passes: a symlink cannot lead out of the vault. */
function writeTargetAllowed(ctx, target) {
	if (insideVault(ctx.vaultPath, target)) return true;
	ctx.err(`refusing to write outside the vault (${ctx.vaultPath}): ${target}`);
	return false;
}

function noteTarget(call) {
	const [type, basename] = call.args;
	if (typeof basename !== "string" || !call.modules.schema.NOTE_TYPES.includes(type)) return undefined;
	return call.modules.notes.notePath(call.ctx.vaultPath, type, basename);
}

function storedNoteTarget(call) {
	const basename = call.args[0];
	const existing = call.modules.notes.readNote(call.ctx.vaultPath, basename);
	if (existing === undefined) return undefined;
	return call.modules.notes.notePath(call.ctx.vaultPath, existing.type, basename);
}

function rootFile(vault, name) {
	return path.join(vault, name);
}

function writeRefusal(vault, modules) {
	for (const name of ["rebase-merge", "rebase-apply"]) {
		if (fs.existsSync(path.join(vault, ".git", name))) {
			return `the vault has a rebase in progress (.git/${name}); finish it before a write`;
		}
	}
	const schema = harnessSettings(vault).schema;
	if (typeof schema === "number" && schema > modules.schema.SCHEMA_VERSION) {
		return `the vault schema is ${schema}; this CLI reads schema ${modules.schema.SCHEMA_VERSION}`;
	}
	return undefined;
}

/** AGENT_VAULT_LOCK_WAIT_MS overrides the lock wait; anything else takes withLock's default. */
function lockWaitMs(env) {
	const raw = env?.AGENT_VAULT_LOCK_WAIT_MS;
	if (typeof raw !== "string" || raw.trim() === "") return undefined;
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

function isLockBusy(error) {
	return error?.name === "LockBusyError" || error?.code === "LOCK_BUSY";
}

function sortedObject(source) {
	const sorted = {};
	for (const key of Object.keys(source).sort()) sorted[key] = source[key];
	return sorted;
}

function reposText(repos) {
	const entries = {};
	for (const key of Object.keys(repos.repos).sort()) entries[key] = { mode: repos.repos[key].mode };
	return `${JSON.stringify({ repos: entries, aliases: sortedObject(repos.aliases) }, null, 2)}\n`;
}

/** Write repos.json through a dot-prefixed temp file in the vault root, then a rename. */
function writeReposFile(vault, repos) {
	const target = path.join(vault, REPOS_FILE);
	const temp = path.join(vault, `.${REPOS_FILE}.tmp-${process.pid}-${Date.now()}`);
	try {
		fs.writeFileSync(temp, reposText(repos));
		fs.renameSync(temp, target);
	} finally {
		fs.rmSync(temp, { force: true });
	}
}

function repoKey(key, aliases, url) {
	const trimmed = key.trim();
	if (trimmed === "") return undefined;
	if (!trimmed.includes(":") && !trimmed.includes("@")) {
		const lower = trimmed.toLowerCase();
		return REPO_KEY_RE.test(lower) ? lower : undefined;
	}
	return url.normalizeRemote(trimmed, aliases);
}

function repoOf(note) {
	const value = note.props.repo;
	return typeof value === "string" && value !== "" ? value : "-";
}

function refuseNote(call, note, errors) {
	for (const text of errors) call.ctx.err(text);
	if (errors.some((text) => text.includes("is not allowed"))) {
		call.emit("vault.denied", { repo: repoOf(note), type: note.type });
	}
	return 2;
}

/** Validate, check, refuse a basename clash, then write and report the path. */
function saveNote(call, note, op) {
	const { ctx, modules } = call;
	const repos = modules.notes.readRepos(ctx.vaultPath);
	const tracked = trackedFilesForNote(call, repos.aliases, note.props.repo);
	const errors = [...modules.schema.validateNote(note), ...modules.privacy.checkNote(repos, note, tracked)];
	if (errors.length > 0) return refuseNote(call, note, errors);
	const existing = modules.notes.readNote(ctx.vaultPath, note.basename);
	if (existing !== undefined && existing.type !== note.type) {
		ctx.err(`basename ${note.basename} is already used by a ${existing.type} note`);
		return 2;
	}
	const target = modules.notes.notePath(ctx.vaultPath, note.type, note.basename);
	if (!writeTargetAllowed(ctx, target)) return 2;
	const written = modules.notes.writeNote(ctx.vaultPath, note);
	ctx.out(written.path);
	call.emit("vault.write", { type: note.type, id: note.basename, op });
	return 0;
}

function refuseSets(ctx, errors) {
	for (const text of errors) ctx.err(text);
	return 2;
}

function cmdResolve(call) {
	const { ctx, flags, modules } = call;
	const info = modules.notes.findVault(ctx.env, ctx.home);
	const host = info?.host ?? modules.schema.slug(os.hostname());
	const remote = info?.remote;
	if (flags.json === true) {
		const body = { path: ctx.vaultPath, host };
		if (remote !== undefined) body.remote = remote;
		ctx.out(JSON.stringify(body, null, 2));
		return 0;
	}
	ctx.out(`path: ${ctx.vaultPath}`);
	ctx.out(`host: ${host}`);
	if (remote !== undefined) ctx.out(`remote: ${remote}`);
	return 0;
}

function cmdBoot(call) {
	const { ctx, flags, modules } = call;
	let budget = DEFAULT_BOOT_BUDGET;
	if (flags.budget !== undefined) {
		const given = Number(flags.budget);
		if (!Number.isFinite(given) || given <= 0) {
			ctx.err(`--budget must be a positive number of tokens: ${flags.budget}`);
			return 2;
		}
		budget = given;
	} else {
		const stored = harnessSettings(ctx.vaultPath).boot_budget_tokens;
		if (typeof stored === "number" && stored > 0) budget = stored;
	}
	const aliases = modules.notes.readRepos(ctx.vaultPath).aliases;
	const repo = flags.repo ?? modules.url.repoSlugFromCwd(ctx.cwd, aliases);
	const text = modules.notes.bootText(ctx.vaultPath, { repo, budgetTokens: budget });
	ctx.out(text.endsWith("\n") ? text.slice(0, -1) : text);
	call.emit("vault.boot", bootEventData(text));
	return 0;
}

function cmdLint(call) {
	const { ctx, flags, modules } = call;
	const aliases = modules.notes.readRepos(ctx.vaultPath).aliases;
	const trackedFiles = trackedFilesProvider(call, aliases);
	const findings = modules.git.lintVault(ctx.vaultPath, { range: flags.range === true, trackedFiles });
	for (const finding of findings) {
		const level = finding.severity === "error" ? "ERROR" : "INFO";
		ctx.out(`${level} ${finding.code} ${finding.file ?? "-"} ${finding.message}`);
	}
	const errors = findings.filter((finding) => finding.severity === "error").length;
	ctx.out(`lint: ${errors} errors, ${findings.length - errors} info`);
	return errors > 0 ? 1 : 0;
}

function cmdStats(call) {
	const { ctx, flags, modules } = call;
	const all = flags.all === true;
	const aliases = modules.notes.readRepos(ctx.vaultPath).aliases;
	const repo = flags.repo ?? (all ? undefined : modules.url.repoSlugFromCwd(ctx.cwd, aliases));
	const stats = modules.notes.statsFor(ctx.vaultPath, all ? { all: true } : { repo });
	if (flags.json === true) {
		ctx.out(JSON.stringify(stats, null, 2));
		return 0;
	}
	ctx.out(`boot tokens: ${stats.bootTokens}`);
	for (const type of modules.schema.NOTE_TYPES) ctx.out(`${type}: ${stats.counts[type] ?? 0}`);
	ctx.out(`work: ${stats.workFiles} files, ${stats.workBytes} bytes`);
	ctx.out(`repeats: ${stats.repeats}`);
	ctx.out(`total: ${stats.total}`);
	ctx.out(`repeat rate: ${stats.repeatRate === null ? "-" : stats.repeatRate}`);
	return 0;
}

function cmdNoteNew(call) {
	const { ctx, args, flags, modules } = call;
	const [type, basename] = args;
	if (!modules.schema.NOTE_TYPES.includes(type)) {
		ctx.err(`unknown note type: ${type}`);
		return 2;
	}
	const parsed = parseSets(flags.sets);
	if (parsed.errors.length > 0) return refuseSets(ctx, parsed.errors);
	const props = parsed.props;
	if (type === "project" && typeof props.repos === "string") props.repos = [props.repos];
	if (typeof props.created !== "string") props.created = today();
	if (typeof props.updated !== "string") props.updated = today();
	const repos = modules.notes.readRepos(ctx.vaultPath);
	const resolved = bodyForNote(call, {
		type,
		props,
		repos,
		bodyStdin: flags.bodyStdin === true,
		fallback: "",
	});
	if (resolved.error !== undefined) {
		ctx.err(resolved.error);
		return 2;
	}
	return saveNote(call, { type, basename, props, body: resolved.body }, "new");
}

function cmdNoteSet(call) {
	const { ctx, args, flags, modules } = call;
	const basename = args[0];
	const existing = modules.notes.readNote(ctx.vaultPath, basename);
	if (existing === undefined) {
		ctx.err(`no note named ${basename}`);
		return 2;
	}
	const parsed = parseSets(flags.sets);
	if (parsed.errors.length > 0) return refuseSets(ctx, parsed.errors);
	const props = { ...existing.props, ...parsed.props };
	if (existing.type === "project" && typeof props.repos === "string") props.repos = [props.repos];
	const repos = modules.notes.readRepos(ctx.vaultPath);
	const resolved = bodyForNote(call, {
		type: existing.type,
		props,
		repos,
		bodyStdin: flags.bodyStdin === true,
		fallback: existing.body,
	});
	if (resolved.error !== undefined) {
		ctx.err(resolved.error);
		return 2;
	}
	return saveNote(call, { type: existing.type, basename, props, body: resolved.body }, "set");
}

function cmdNoteStatus(call) {
	const { ctx, args, modules } = call;
	const [basename, value] = args;
	const existing = modules.notes.readNote(ctx.vaultPath, basename);
	if (existing === undefined) {
		ctx.err(`no note named ${basename}`);
		return 2;
	}
	const allowed = STATUS_VALUES[existing.type];
	if (allowed === undefined || !allowed.includes(value)) {
		ctx.err(STATUS_HELP);
		return 2;
	}
	const props = { ...existing.props, status: value };
	return saveNote(call, { type: existing.type, basename, props, body: existing.body }, "status");
}

function cmdNoteRm(call) {
	const { ctx, args, modules } = call;
	const basename = args[0];
	const existing = modules.notes.readNote(ctx.vaultPath, basename);
	if (existing === undefined) {
		ctx.err(`no note named ${basename}`);
		return 2;
	}
	const target = modules.notes.notePath(ctx.vaultPath, existing.type, basename);
	if (!writeTargetAllowed(ctx, target)) return 2;
	if (!modules.notes.removeNote(ctx.vaultPath, basename)) {
		ctx.err(`could not remove ${target}`);
		return 1;
	}
	call.emit("vault.write", { type: existing.type, id: basename, op: "rm" });
	return 0;
}

function cmdIndexRebuild(call) {
	const { ctx, modules } = call;
	const target = rootFile(ctx.vaultPath, "index.md");
	if (!writeTargetAllowed(ctx, target)) return 2;
	modules.notes.writeIndex(ctx.vaultPath);
	call.emit("vault.write", { type: "index", id: "index", op: "rebuild" });
	return 0;
}

function cmdLogAppend(call) {
	const { ctx, flags, args, modules } = call;
	const repo = flags.repo;
	const text = args.join(" ");
	if (text === "") {
		ctx.err("log append needs some text");
		return 2;
	}
	const repos = modules.notes.readRepos(ctx.vaultPath);
	if (repo !== "-" && modules.privacy.modeFor(repos, repo) === "none") {
		ctx.err(`repo ${repo} is not allowed`);
		return 2;
	}
	const leaks = modules.privacy.leaksNoneRepo(repos, `${repo} ${text}`);
	if (leaks.length > 0) {
		for (const needle of leaks) ctx.err(`the log line names a repo that is not allowed: ${needle}`);
		return 2;
	}
	const target = rootFile(ctx.vaultPath, "log.md");
	if (!writeTargetAllowed(ctx, target)) return 2;
	const trace = flags.trace ?? "-";
	modules.notes.appendLog(ctx.vaultPath, {
		ts: new Date().toISOString(),
		host: hostName(call),
		repo,
		trace,
		text,
	});
	call.emit("vault.write", { type: "log", id: trace, op: "append" });
	return 0;
}

function cmdRepoAllow(call) {
	const { ctx, flags, args, modules } = call;
	const mode = flags.mode;
	if (!MODES.includes(mode)) {
		ctx.err(`--mode must be one of: ${MODES.join(", ")}`);
		return 2;
	}
	const repos = modules.notes.readRepos(ctx.vaultPath);
	if (repos.malformed === true) {
		ctx.err(`${REPOS_FILE} is malformed; fix it by hand before allowing a repo`);
		return 2;
	}
	const slug = repoKey(args[0], repos.aliases, modules.url);
	if (slug === undefined) {
		ctx.err(`cannot read ${args[0]} as a repo slug: ${args[0]}`);
		return 2;
	}
	const target = rootFile(ctx.vaultPath, REPOS_FILE);
	if (!writeTargetAllowed(ctx, target)) return 2;
	writeReposFile(ctx.vaultPath, { repos: { ...repos.repos, [slug]: { mode } }, aliases: repos.aliases });
	call.emit("vault.write", { type: "repos", id: slug, op: "allow" });
	return 0;
}

function cmdRepoList(call) {
	const { ctx, modules } = call;
	const repos = modules.notes.readRepos(ctx.vaultPath);
	for (const key of Object.keys(repos.repos).sort()) ctx.out(`${key}\t${repos.repos[key].mode}`);
	return 0;
}

function cmdRepoCheck(call) {
	const { ctx, modules } = call;
	const repos = modules.notes.readRepos(ctx.vaultPath);
	const slug = modules.url.repoSlugFromCwd(ctx.cwd, repos.aliases);
	const mode = modules.privacy.modeFor(repos, slug);
	ctx.out(mode);
	return mode === "none" ? 3 : 0;
}

/** The summary is checked before the lock, so a leak never waits for another writer. */
function prelockSummary(call) {
	const summary = call.flags.summary;
	if (summary === undefined || summary === "") return undefined;
	const repos = call.modules.notes.readRepos(call.ctx.vaultPath);
	const leaks = call.modules.privacy.leaksNoneRepo(repos, summary);
	if (leaks.length === 0) return undefined;
	for (const needle of leaks) call.ctx.err(`the summary names a repo that is not allowed: ${needle}`);
	return 2;
}

function reportSync(call, op, result) {
	call.ctx.out(result.message);
	for (const file of result.unmanaged) call.ctx.out(`unmanaged change: ${file}`);
	call.emit("vault.sync", { op, result });
	return result.code;
}

function cmdSyncPull(call) {
	const { ctx, modules } = call;
	if (!writeTargetAllowed(ctx, call.ctx.vaultPath)) return 2;
	return reportSync(call, "pull", modules.git.syncPull(ctx.vaultPath));
}

function cmdSyncPush(call) {
	const { ctx, flags, modules } = call;
	if (!writeTargetAllowed(ctx, call.ctx.vaultPath)) return 2;
	const result = modules.git.syncPush(ctx.vaultPath, { summary: flags.summary, trace: flags.trace });
	return reportSync(call, "push", result);
}

/** The event a module returned, when it returned one, then its exit code. */
function finishModule(call, result) {
	if (result.event !== undefined) call.emit(result.event.kind, result.event.data);
	return result.code;
}

/**
 * The context vault-work.mjs, vault-restore.mjs and vault-config.mjs take.
 * `inside` is the same realpath check every vault write passes, so a module
 * refuses a target that leaves the vault.
 */
function moduleContext(call) {
	const { ctx } = call;
	return {
		vault: ctx.vaultPath,
		root: call.flags.root,
		modules: call.modules,
		out: ctx.out,
		err: ctx.err,
		inside: (target) => insideVault(ctx.vaultPath, target),
	};
}

async function cmdWorkAdd(call) {
	const { workAdd } = await import("./vault-work.mjs");
	const { trace, probes } = call.flags;
	return finishModule(call, workAdd(moduleContext(call), { trace, probes: probes === true }));
}

async function cmdWorkPending(call) {
	const { workPending } = await import("./vault-work.mjs");
	return finishModule(call, workPending(moduleContext(call)));
}

async function cmdRestore(call) {
	const { restore } = await import("./vault-restore.mjs");
	return finishModule(call, restore(moduleContext(call)));
}

async function cmdConfigPush(call) {
	const { configPush } = await import("./vault-config.mjs");
	return finishModule(call, configPush(moduleContext(call)));
}

async function cmdConfigPull(call) {
	const { configPull } = await import("./vault-config.mjs");
	return finishModule(call, configPull(moduleContext(call), { force: call.flags.force === true }));
}

/** The same candidates findHarnessRoot tries, so a miss can name each one. */
function harnessCandidates({ env, scriptDir, vaultPath, home }) {
	const candidates = [];
	if (typeof env.PI_PLAN_DISPATCH_HARNESS === "string" && env.PI_PLAN_DISPATCH_HARNESS !== "") {
		candidates.push(path.resolve(env.PI_PLAN_DISPATCH_HARNESS));
	}
	if (typeof scriptDir === "string" && scriptDir !== "") candidates.push(path.dirname(path.resolve(scriptDir)));
	if (typeof vaultPath === "string" && vaultPath !== "") {
		candidates.push(path.join(path.dirname(path.resolve(vaultPath)), HARNESS_DIR));
	}
	if (typeof home === "string" && home !== "") candidates.push(path.join(home, "Documents", "repos", HARNESS_DIR));
	return candidates;
}

/**
 * The admin commands work on a vault that may not exist yet, so they skip every
 * write check and take no lock. They only need the harness root, which they
 * report when it is missing instead of calling the command.
 */
async function runAdmin(call, command, args) {
	const { ctx } = call;
	const looked = { env: process.env, scriptDir: import.meta.dirname, vaultPath: ctx.vaultPath, home: os.homedir() };
	const harnessRoot = findHarnessRoot(looked);
	if (harnessRoot === undefined) {
		ctx.err(`vault: the harness repo was not found (needs dispatch-plan/SKILL.md, pi-plan-dispatch/core.ts and vault-template/). Tried:`);
		for (const dir of harnessCandidates(looked)) ctx.err(`  ${dir}`);
		return 1;
	}
	return command(args, {
		env: process.env,
		home: os.homedir(),
		cwd: process.cwd(),
		harnessRoot,
		vaultPath: ctx.vaultPath,
		moduleDir: path.join(ctx.moduleDir, "vault"),
		out: ctx.out,
		err: ctx.err,
	});
}

function cmdInit(call) {
	return runAdmin(call, runInit, { path: call.flags.path, remote: call.flags.remote });
}

function cmdSetup(call) {
	return runAdmin(call, runSetup, { path: call.flags.path, force: call.flags.force });
}

function cmdDoctor(call) {
	return runAdmin(call, runDoctor, {});
}

async function runWrite(spec, call) {
	const refusal = writeRefusal(call.ctx.vaultPath, call.modules);
	if (refusal !== undefined) {
		call.ctx.err(refusal);
		return 2;
	}
	const target = spec.target?.(call);
	if (target !== undefined && !writeTargetAllowed(call.ctx, target)) return 2;
	if (spec.prelock !== undefined) {
		const code = spec.prelock(call);
		if (code !== undefined) return code;
	}
	try {
		const work = () => spec.run(call);
		return await call.modules.lock.withLock(call.ctx.vaultPath, work, { waitMs: lockWaitMs(call.ctx.env) });
	} catch (error) {
		if (!isLockBusy(error)) throw error;
		call.ctx.err(errorText(error));
		return 4;
	}
}

function usageProblem(message) {
	err(`vault: ${message}`);
	err(USAGE);
	return 64;
}

async function run(argv) {
	if (process.env.PI_PLAN_DISPATCH_WORKER === "1") {
		err("vault: refusing to run inside a Pi worker (PI_PLAN_DISPATCH_WORKER is set)");
		return 2;
	}
	const parsed = parseArgs(argv);
	if (parsed.error !== undefined) return usageProblem(parsed.error);
	const lookup = lookupCommand(parsed.positionals);
	if (lookup.error !== undefined) return usageProblem(lookup.error);
	const flags = parsed.flags;
	const args = parsed.positionals.slice(lookup.depth);
	const problem = argumentProblem(lookup, args, flags);
	if (problem !== undefined) return usageProblem(problem);
	if (flags.vault !== undefined) flags.vault = path.resolve(expand(flags.vault));
	if (flags.root !== undefined) flags.root = path.resolve(expand(flags.root));

	const found = findModuleDir(process.cwd());
	if (found.dir === undefined) {
		err("vault: cannot find the pi-plan-dispatch modules (core.ts, verify.ts). Tried:");
		for (const dir of found.candidates) err(`  ${dir}`);
		return 2;
	}
	const modules = await loadModules(found.dir);
	const emit = (kind, data) => emitEvent({ root: flags.root, trace: flags.trace }, kind, data);
	const info = modules.notes.findVault(process.env, os.homedir());
	const vaultPath = flags.vault !== undefined ? flags.vault : info?.path;
	const ctx = makeContext({ vaultPath, moduleDir: found.dir });
	if (vaultPath === undefined && lookup.spec.needsVault !== false) {
		err("vault not configured");
		emit("vault.unavailable", { reason: "vault not configured" });
		return 1;
	}

	const call = { ctx, args, flags, modules, emit };
	try {
		if (lookup.spec.write === true) return await runWrite(lookup.spec, call);
		return await lookup.spec.run(call);
	} catch (error) {
		err(`vault: ${errorText(error)}`);
		return 1;
	}
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) process.exitCode = await run(process.argv.slice(2));

export { lockWaitMs, parseArgs };
