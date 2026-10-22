/**
 * The admin commands of the agent-vault CLI: init, setup and doctor (R1, R20 to R22).
 *
 * Plain Node, no dependencies beyond the built-ins. The vault modules arrive
 * through ctx.moduleDir, so this file imports nothing from the dispatcher and
 * nothing from vault.mjs. Every function reports through ctx.out and ctx.err,
 * one line per call, and returns the exit code.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_MIN_NODE = 24;
const COMMAND_TIMEOUT_MS = 10000;
const SSH_COMMAND = "ssh -o BatchMode=yes -o ConnectTimeout=5";
const DEFAULT_VAULT_DIR = "agent-vault";
const HARNESS_DIR = "pi-plan-dispatch-phase1";
const INITIAL_COMMIT = "vault: init";
const WORK_FOLDERS = ["specs", "ideas", "work", "config"];
const GITATTRIBUTES_LINE = "work/**/*.jsonl merge=union";
const NOT_NOTE_FOLDERS = new Set([".git", "templates", "work", "config", "node_modules"]);

function readText(file) {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}

function readJson(file) {
	const text = readText(file);
	if (text === undefined) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function isObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function writeJson(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sortedObject(value) {
	const out = {};
	for (const key of Object.keys(value).sort()) out[key] = value[key];
	return out;
}

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function hashFile(file) {
	try {
		return sha256(fs.readFileSync(file));
	} catch {
		return undefined;
	}
}

function isDirectory(dir) {
	try {
		return fs.statSync(dir).isDirectory();
	} catch {
		return false;
	}
}

/** The `type:` value of a note's front matter block, or undefined when it has none. */
function frontMatterType(text) {
	const lines = text.split("\n");
	if (lines[0].trim() !== "---") return undefined;
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i].trim();
		if (line === "---") return undefined;
		if (!line.startsWith("type:")) continue;
		const value = line.slice("type:".length).trim().replace(/^["']|["']$/gu, "");
		return value === "" ? undefined : value;
	}
	return undefined;
}

/** The vault folders of the work files, and the merge rule their files need. */
function ensureWorkLayout(ctx, vault) {
	for (const folder of WORK_FOLDERS) {
		const dir = path.join(vault, folder);
		if (isDirectory(dir)) continue;
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, ".gitkeep"), "");
		ctx.out(`created: ${dir}`);
	}
	ensureGitattributes(ctx, vault);
}

function ensureGitattributes(ctx, vault) {
	const file = path.join(vault, ".gitattributes");
	const text = readText(file);
	if (text === undefined) {
		fs.writeFileSync(file, `log.md merge=union\n${GITATTRIBUTES_LINE}\n`);
		ctx.out(`updated: ${file}`);
		return;
	}
	if (text.split("\n").some((line) => line.trim() === GITATTRIBUTES_LINE)) return;
	const separator = text === "" || text.endsWith("\n") ? "" : "\n";
	fs.writeFileSync(file, `${text}${separator}${GITATTRIBUTES_LINE}\n`);
	ctx.out(`updated: ${file}`);
}

/** A JSON value with the keys of every object sorted, so two files compare by content. */
function sortedDeep(value) {
	if (Array.isArray(value)) return value.map(sortedDeep);
	if (!isObject(value)) return value;
	const out = {};
	for (const key of Object.keys(value).sort()) out[key] = sortedDeep(value[key]);
	return out;
}

/**
 * The notes of a type this CLI does not know: how many, and their types sorted
 * and unique. A file with no front matter type is not a note and is skipped.
 */
function unknownNoteTypes(vault, known) {
	const types = new Set();
	let count = 0;
	if (!isDirectory(vault)) return { count, types: [] };
	for (const entry of fs.readdirSync(vault, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		if (entry.name.startsWith(".") || NOT_NOTE_FOLDERS.has(entry.name)) continue;
		for (const name of filesIn(path.join(vault, entry.name))) {
			if (!name.endsWith(".md")) continue;
			const type = frontMatterType(readText(path.join(vault, entry.name, name)) ?? "");
			if (type === undefined || known.includes(type)) continue;
			count++;
			types.add(type);
		}
	}
	return { count, types: [...types].sort() };
}

function firstLine(text) {
	return String(text ?? "")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "")[0] ?? "";
}

function expandHome(value, home) {
	if (value === "~") return home;
	if (value.startsWith("~/")) return path.join(home, value.slice(2));
	return value;
}

/** The vault modules, loaded from ctx.moduleDir so this file stays dependency-free. */
async function loadModules(ctx) {
	const load = (name) => import(pathToFileURL(path.join(ctx.moduleDir, name)).href);
	const [schema, notes] = await Promise.all([load("schema.ts"), load("notes.ts")]);
	return {
		slug: schema.slug,
		schemaVersion: schema.SCHEMA_VERSION,
		noteTypes: schema.NOTE_TYPES,
		writeIndex: notes.writeIndex,
		readRepos: notes.readRepos,
	};
}

/** One external command, with ctx.env and a hard timeout; a timeout is never success. */
function runCommand(ctx, command, args, opts = {}) {
	try {
		const result = spawnSync(command, args, {
			cwd: opts.cwd,
			env: opts.env ?? ctx.env,
			encoding: "utf8",
			timeout: COMMAND_TIMEOUT_MS,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const code = result.error?.code;
		return {
			ok: result.status === 0,
			status: result.status,
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
			missing: code === "ENOENT",
			timedOut: code === "ETIMEDOUT",
		};
	} catch {
		return { ok: false, status: null, stdout: "", stderr: "", missing: true, timedOut: false };
	}
}

function git(ctx, args, cwd, extraEnv) {
	const env = extraEnv === undefined ? ctx.env : { ...ctx.env, ...extraEnv };
	return runCommand(ctx, "git", args, { cwd, env });
}

function gitOrigin(ctx, vault) {
	const result = git(ctx, ["remote", "get-url", "origin"], vault);
	const url = result.ok ? result.stdout.trim() : "";
	return url === "" ? undefined : url;
}

function gitHasIdentity(ctx, cwd) {
	const result = git(ctx, ["config", "--get", "user.email"], cwd);
	return result.ok && result.stdout.trim() !== "";
}

function isHarnessRoot(dir) {
	return (
		fs.existsSync(path.join(dir, "dispatch-plan", "SKILL.md")) &&
		fs.existsSync(path.join(dir, "pi-plan-dispatch", "core.ts")) &&
		fs.existsSync(path.join(dir, "vault-template"))
	);
}

/**
 * The harness repo root: the first candidate holding the skill, the dispatcher
 * and the vault template. An installed skills folder has the skill only, so it
 * never counts as the harness.
 */
export function findHarnessRoot({ env, scriptDir, vaultPath, home }) {
	const candidates = [];
	if (env && typeof env.PI_PLAN_DISPATCH_HARNESS === "string" && env.PI_PLAN_DISPATCH_HARNESS !== "") {
		candidates.push(path.resolve(env.PI_PLAN_DISPATCH_HARNESS));
	}
	if (typeof scriptDir === "string" && scriptDir !== "") candidates.push(path.dirname(path.resolve(scriptDir)));
	if (typeof vaultPath === "string" && vaultPath !== "") {
		candidates.push(path.join(path.dirname(path.resolve(vaultPath)), HARNESS_DIR));
	}
	if (typeof home === "string" && home !== "") candidates.push(path.join(home, "Documents", "repos", HARNESS_DIR));
	return candidates.find(isHarnessRoot);
}

function copyTree(src, dest) {
	const stat = fs.statSync(src);
	if (stat.isDirectory()) {
		fs.mkdirSync(dest, { recursive: true, mode: stat.mode & 0o777 });
		for (const name of fs.readdirSync(src)) copyTree(path.join(src, name), path.join(dest, name));
		return;
	}
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	fs.copyFileSync(src, dest);
	fs.chmodSync(dest, stat.mode & 0o777);
}

/** Why a target is not an acceptable vault location, or undefined when it is. */
function targetProblem(target) {
	let stat;
	try {
		stat = fs.statSync(target);
	} catch {
		return undefined;
	}
	if (!stat.isDirectory()) return `${target} is not a directory`;
	const others = fs.readdirSync(target).filter((name) => name !== ".git");
	if (others.length > 0) {
		const shown = others.slice(0, 3).map((name) => JSON.stringify(name)).join(", ");
		return `${target} is not empty (found ${shown})`;
	}
	return undefined;
}

export async function runInit(args = {}, ctx) {
	const harnessRoot = ctx.harnessRoot;
	if (typeof harnessRoot !== "string" || harnessRoot === "") {
		ctx.err("init: the harness repo was not found");
		return 1;
	}
	const template = path.join(harnessRoot, "vault-template");
	if (!isDirectory(template)) {
		ctx.err(`init: ${template} is missing`);
		return 1;
	}
	const given = typeof args.path === "string" && args.path !== "" ? args.path : path.join(ctx.home, "Documents", "repos", DEFAULT_VAULT_DIR);
	const target = path.resolve(given);
	const problem = targetProblem(target);
	if (problem !== undefined) {
		ctx.err(`init: ${problem}; nothing was changed`);
		return 1;
	}

	fs.mkdirSync(target, { recursive: true });
	copyTree(template, target);

	if (!fs.existsSync(path.join(target, ".git"))) {
		const created = git(ctx, ["init", "-b", "main"], target);
		if (!created.ok) {
			ctx.err(`init: git init failed: ${firstLine(created.stderr) || `exit ${created.status}`}`);
			return 1;
		}
	}
	const added = git(ctx, ["add", "-A"], target);
	if (!added.ok) {
		ctx.err(`init: git add failed: ${firstLine(added.stderr) || `exit ${added.status}`}`);
		return 1;
	}
	const identity = gitHasIdentity(ctx, target)
		? []
		: ["-c", "user.name=agent-vault", "-c", "user.email=agent-vault@localhost"];
	const committed = git(ctx, [...identity, "commit", "-m", INITIAL_COMMIT], target);
	if (!committed.ok) {
		ctx.err(`init: git commit failed: ${firstLine(committed.stderr) || `exit ${committed.status}`}`);
		return 1;
	}
	if (typeof args.remote === "string" && args.remote !== "") {
		const remote = git(ctx, ["remote", "add", "origin", args.remote], target);
		if (!remote.ok) {
			ctx.err(`init: git remote add failed: ${firstLine(remote.stderr) || `exit ${remote.status}`}`);
			return 1;
		}
	}

	ctx.out(`created ${target}`);
	ctx.out("next steps:");
	ctx.out("  1. create the private remote for this vault");
	ctx.out("  2. git push -u origin HEAD");
	ctx.out("  3. run bootstrap.sh on your other machines");
	return 0;
}

function filesIn(dir) {
	try {
		return fs
			.readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
}

/** Every file setup installs, as { src, dest } pairs. */
function installTargets(harnessRoot, home) {
	const skills = path.join(home, ".claude", "skills", "dispatch-plan");
	const agents = path.join(home, ".claude", "agents");
	const targets = [];
	for (const name of filesIn(path.join(harnessRoot, "dispatch-plan"))) {
		if (name.includes(".test.")) continue;
		targets.push({ src: path.join(harnessRoot, "dispatch-plan", name), dest: path.join(skills, name) });
	}
	for (const name of filesIn(path.join(harnessRoot, "dispatch-plan", "agents"))) {
		targets.push({ src: path.join(harnessRoot, "dispatch-plan", "agents", name), dest: path.join(agents, name) });
	}
	return targets;
}

/** True when the file was written; false when a locally modified copy was kept. */
function installOne({ src, dest, force, record }) {
	const current = hashFile(dest);
	const untouched = current !== undefined && current === record[dest];
	if (!force && current !== undefined && !untouched) return false;
	const bytes = fs.readFileSync(src);
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	fs.writeFileSync(dest, bytes);
	fs.chmodSync(dest, fs.statSync(src).mode & 0o777);
	record[dest] = sha256(bytes);
	return true;
}

export async function runSetup(args = {}, ctx) {
	const given = typeof args.path === "string" && args.path !== "" ? args.path : ctx.vaultPath;
	if (typeof given !== "string" || given === "") {
		ctx.err("setup: no vault given. Fix: node dispatch-plan/vault.mjs setup --path <vault>");
		return 1;
	}
	const vault = path.resolve(given);
	if (!isDirectory(vault) || !fs.existsSync(path.join(vault, ".git"))) {
		ctx.err(`setup: ${vault} is not a git repository. Fix: node dispatch-plan/vault.mjs init --path ${vault}`);
		return 1;
	}
	const harnessRoot = ctx.harnessRoot;
	if (typeof harnessRoot !== "string" || harnessRoot === "") {
		ctx.err("setup: the harness repo was not found");
		return 1;
	}

	const modules = await loadModules(ctx);
	const configFile = path.join(ctx.home, ".config", "agent-vault", "config.json");
	const previous = readJson(configFile);
	const host =
		isObject(previous) && typeof previous.host === "string" && previous.host !== ""
			? previous.host
			: modules.slug(os.hostname());
	const remote = gitOrigin(ctx, vault);
	const config = { path: vault, ...(remote === undefined ? {} : { remote }), host };
	writeJson(configFile, config);
	ctx.out(`vault: ${vault}`);
	ctx.out(`config: ${configFile}`);

	ensureWorkLayout(ctx, vault);

	const recordFile = path.join(ctx.home, ".config", "agent-vault", "installed.json");
	const stored = readJson(recordFile);
	const record = isObject(stored) ? { ...stored } : {};
	for (const { src, dest } of installTargets(harnessRoot, ctx.home)) {
		const written = installOne({ src, dest, force: args.force === true, record });
		ctx.out(written ? `installed: ${dest}` : `kept (modified): ${dest}`);
	}
	writeJson(recordFile, sortedObject(record));

	try {
		modules.writeIndex(vault);
	} catch (error) {
		ctx.err(`setup: could not write index.md: ${String(error?.message ?? error)}`);
		return 1;
	}
	ctx.out(`index: ${path.join(vault, "index.md")}`);

	// Loaded here so a copied vault-admin.mjs without the new modules still works until this step.
	if (isDirectory(path.join(ctx.cwd, ".plans"))) {
		const { configPull } = await import("./vault-config.mjs");
		configPull({ vault, root: ctx.cwd, modules: {}, out: ctx.out, err: ctx.err, inside: () => true }, { force: false });
	}

	await runDoctor({}, { ...ctx, vaultPath: vault });
	return 0;
}

function onPath(name, env) {
	const dirs = String(env.PATH ?? "")
		.split(path.delimiter)
		.filter((dir) => dir !== "");
	return dirs.some((dir) => {
		try {
			fs.accessSync(path.join(dir, name), fs.constants.X_OK);
			return true;
		} catch {
			return false;
		}
	});
}

export async function runDoctor(args = {}, ctx) {
	const vault = ctx.vaultPath;
	if (typeof vault !== "string" || vault === "") {
		ctx.out("fail vault configured. Fix: node dispatch-plan/vault.mjs setup --path <vault>");
		return 1;
	}

	const modules = await loadModules(ctx);
	const harnessRoot = ctx.harnessRoot;
	const home = ctx.home;
	const vaultHarness = readJson(path.join(vault, "harness.json"));
	const checks = [];
	const required = (ok, name, failure) => checks.push({ required: true, ok, line: ok ? `ok   ${name}` : `fail ${name}: ${failure}` });
	const optional = (ok, name, failure) =>
		checks.push({ required: false, ok, line: ok ? `optional ok ${name}` : `optional fail ${name}: ${failure}` });

	const minNode = isObject(vaultHarness) && typeof vaultHarness.min_node === "number" ? vaultHarness.min_node : DEFAULT_MIN_NODE;
	const nodeMajor = Number(process.versions.node.split(".")[0]);
	required(nodeMajor >= minNode, "node", `Node ${process.versions.node} is older than ${minNode}. Fix: install Node ${minNode} or newer`);

	const gitVersion = runCommand(ctx, "git", ["--version"]);
	required(gitVersion.ok, "git", `${gitVersion.missing ? "git is not installed" : "git --version failed"}. Fix: install git`);

	required(fs.existsSync(path.join(vault, ".git")), "vault repo", `${vault} is not a git repository. Fix: node dispatch-plan/vault.mjs init --path ${vault}`);

	const schema = isObject(vaultHarness) && typeof vaultHarness.schema === "number" ? vaultHarness.schema : undefined;
	required(
		schema !== undefined && schema <= modules.schemaVersion,
		"vault schema",
		schema === undefined
			? `${path.join(vault, "harness.json")} has no numeric schema. Fix: restore the file from the vault template`
			: `schema ${schema} is newer than this CLI supports (${modules.schemaVersion}). Fix: update the harness clone and rerun setup`,
	);

	const origin = gitOrigin(ctx, vault);
	if (origin === undefined) {
		required(false, "remote", "no origin remote. Fix: git remote add origin <url>");
	} else {
		const reachable = git(ctx, ["ls-remote", "origin"], vault, { GIT_SSH_COMMAND: SSH_COMMAND });
		required(reachable.ok, "remote", `${reachable.timedOut ? "git ls-remote origin timed out" : "git ls-remote origin failed"}. Fix: git remote add origin <url>`);
	}

	const upstream = git(ctx, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], vault);
	required(upstream.ok && upstream.stdout.trim() !== "", "upstream", "the current branch has no upstream. Fix: git push -u origin HEAD");

	const targets = typeof harnessRoot === "string" && harnessRoot !== "" ? installTargets(harnessRoot, home) : [];
	const stale = targets.filter(({ src, dest }) => hashFile(dest) !== hashFile(src));
	required(
		targets.length > 0 && stale.length === 0,
		"installed",
		targets.length === 0
			? "the harness repo was not found. Fix: set PI_PLAN_DISPATCH_HARNESS to the harness repo"
			: `${stale.length} file(s) differ from the harness copy: ${stale.slice(0, 3).map(({ dest }) => path.basename(dest)).join(", ")}. Fix: node dispatch-plan/vault.mjs setup --path ${vault}`,
	);

	const pi = runCommand(ctx, "pi", ["--version"]);
	required(pi.ok, "pi", `${pi.missing ? "pi is not installed" : "pi --version failed"}. Fix: install the Pi coding agent (@earendil-works/pi-coding-agent)`);

	const settingsFile = path.join(home, ".pi", "agent", "settings.json");
	const settings = readJson(settingsFile);
	const packages = isObject(settings) && Array.isArray(settings.packages) ? settings.packages : [];
	const expected = typeof harnessRoot === "string" && harnessRoot !== "" ? path.join(harnessRoot, "pi-plan-dispatch") : undefined;
	const registered =
		expected !== undefined &&
		packages.some(
			(entry) =>
				typeof entry === "string" &&
				entry !== "" &&
				!entry.startsWith("npm:") &&
				path.resolve(path.dirname(settingsFile), expandHome(entry, home)) === expected,
		);
	required(
		registered,
		"extension",
		`no local package entry in ${settingsFile} resolves to ${expected ?? "<harnessRoot>/pi-plan-dispatch"}. Fix: add ${expected ?? "<harnessRoot>/pi-plan-dispatch"} to its packages array and restart Pi`,
	);

	const authFile = path.join(home, ".pi", "agent", "auth.json");
	const auth = readJson(authFile);
	required(
		isObject(auth) && auth["opencode-go"] !== undefined && auth["opencode-go"] !== null,
		"credentials",
		`no opencode-go entry in ${authFile}. Fix: log Pi in to the OpenCode Go provider`,
	);

	const repos = modules.readRepos(vault);
	const repoCount = Object.keys(isObject(repos.repos) ? repos.repos : {}).length;
	required(
		repoCount > 0,
		"repos",
		`${isObject(repos) && repos.malformed ? "repos.json is malformed" : "repos.json lists no repos"}. Fix: node ~/.claude/skills/dispatch-plan/vault.mjs repo allow <slug> --mode full`,
	);

	optional(onPath("graphify", ctx.env), "graphify", "graphify is not on the PATH. Fix: uv tool install graphifyy && graphify install");

	const pluginDirs = [
		path.join(home, ".claude", "plugins", "marketplaces", "obsidian-skills"),
		path.join(home, ".claude", "plugins", "cache", "obsidian-skills"),
	];
	optional(
		pluginDirs.some((dir) => fs.existsSync(dir)),
		"obsidian-skills",
		"the obsidian-skills plugin is not installed. Fix: /plugin marketplace add kepano/obsidian-skills then /plugin install obsidian@obsidian-skills, run in Claude Code",
	);

	const unknown = unknownNoteTypes(vault, modules.noteTypes);
	optional(
		unknown.count === 0,
		"note types",
		`${unknown.count} note(s) of a type this CLI does not know (${unknown.types.join(", ")}). Fix: update the harness clone and rerun setup`,
	);

	const localConfig = typeof ctx.cwd === "string" ? path.join(ctx.cwd, ".plans", "config.json") : undefined;
	const vaultConfig = path.join(vault, "config", "dispatch.json");
	if (localConfig !== undefined && fs.existsSync(localConfig) && fs.existsSync(vaultConfig)) {
		const local = readJson(localConfig);
		const stored = readJson(vaultConfig);
		const same =
			local !== undefined && stored !== undefined && JSON.stringify(sortedDeep(local)) === JSON.stringify(sortedDeep(stored));
		optional(same, "dispatch config", "differs from the vault. Fix: node ~/.claude/skills/dispatch-plan/vault.mjs config push --root .");
	}

	let failed = 0;
	for (const check of checks) {
		if (check.required && !check.ok) failed++;
		ctx.out(check.line);
	}
	return failed === 0 ? 0 : 1;
}
