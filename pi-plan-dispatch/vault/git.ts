/**
 * Git sync and lint for the agent vault (R9, R10): the secret scan, the lint
 * findings, the managed-file staging rule, and pull and push with the conflict
 * protocol the spec requires.
 *
 * The CLI holds the vault lock; this module does not take it.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Note, NoteType } from "./schema.ts";
import { NOTE_TYPES, TYPE_FOLDER, parseNote, validateNote } from "./schema.ts";
import type { Repos } from "./privacy.ts";
import { checkNote, leaksNoneRepo } from "./privacy.ts";
import { readRepos, writeIndex } from "./notes.ts";

export interface LintFinding {
	severity: "error" | "info";
	code: string;
	message: string;
	file?: string;
}

export interface LintOptions {
	range?: boolean;
	trackedFiles?: (repo: string) => Set<string> | undefined;
}

export interface SyncResult {
	code: 0 | 1 | 2 | 5;
	message: string;
	unmanaged: string[];
}

interface LoadedNote {
	file: string;
	note: Note;
}

interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

const SECRET_PATTERNS: readonly { name: string; re: RegExp }[] = [
	{ name: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
	{ name: "aws-access-key", re: /AKIA[0-9A-Z]{16}/ },
	{ name: "github-token", re: /ghp_[A-Za-z0-9]{20,}/ },
	{ name: "github-pat", re: /github_pat_[A-Za-z0-9_]{20,}/ },
	{ name: "anthropic-key", re: /sk-ant-[A-Za-z0-9_-]{10,}/ },
	{ name: "api-key", re: /sk-[A-Za-z0-9]{20,}/ },
	{ name: "slack-token", re: /xox[baprs-][A-Za-z0-9-]{10,}/ },
	{ name: "base64-near-secret", re: /(?:key|token|secret)\W{0,5}[=:]\s*["']?[A-Za-z0-9+/=]{40,}/i },
];

const ABSOLUTE_PATH_RE = /(^|[\s("'`])((?:\/(?:Users|home|var|tmp|private|etc)\/|[A-Za-z]:\\|~\/)[^\s)"'`]*)/;
const LINK_RE = /\[\[([^\]\n]+)\]\]/g;
/**
 * The note types whose body may hold an absolute path. A `spec` and a `plan`
 * body is a verbatim copy of a working file that names paths such as
 * `~/.claude/skills/...` or `/tmp/...`, so the absolute-path check does not
 * apply to them. The secret scan, the none-repo leak check and `checkNote`
 * still do.
 */
const VERBATIM_BODY_TYPES: readonly NoteType[] = ["plan", "spec"];
const UNMERGED_CODES = new Set(["UU", "AA", "DU", "UD", "AU", "UA"]);
const TYPE_FOLDERS: readonly string[] = NOTE_TYPES.map((type) => TYPE_FOLDER[type]);
const FOLDER_TYPES: Record<string, NoteType> = Object.fromEntries(
	NOTE_TYPES.map((type) => [TYPE_FOLDER[type], type]),
);
const MANAGED_ROOT_FILES: readonly string[] = [
	"log.md",
	"repos.json",
	"harness.json",
	"CLAUDE.md",
	"README.md",
	"bootstrap.sh",
	".gitattributes",
	".gitignore",
];

/** Names of the secret patterns that match, in table order. Empty when clean. */
export function scanSecrets(text: string): string[] {
	return SECRET_PATTERNS.filter((pattern) => pattern.re.test(text)).map((pattern) => pattern.name);
}

function readText(file: string): string | undefined {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}

function readDirNames(dir: string): string[] {
	try {
		return fs.readdirSync(dir);
	} catch {
		return [];
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Every file below the vault root, as slash-separated relative paths, `.git` skipped. */
function vaultFiles(vault: string): string[] {
	const files: string[] = [];
	const walk = (relative: string): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(path.join(vault, relative), { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
			if (entry.isDirectory()) {
				if (entry.name !== ".git") walk(child);
			} else if (entry.isFile()) {
				files.push(child);
			}
		}
	};
	walk("");
	return files.sort();
}

const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });

/** The text of a UTF-8 file, or undefined when the bytes are not valid UTF-8. */
function decodeText(bytes: Uint8Array): string | undefined {
	try {
		return TEXT_DECODER.decode(bytes);
	} catch {
		return undefined;
	}
}

/**
 * The work and config folders are not note folders, so no note schema or link
 * check runs on them. A file below `work/` that is not UTF-8 text is an error;
 * below `config/` it is skipped and left to the secret scan. Every readable file
 * is checked for a `none` repo name.
 */
function workFindings(vault: string): LintFinding[] {
	const findings: LintFinding[] = [];
	const repos = readRepos(vault);
	for (const file of vaultFiles(vault)) {
		const isWork = file.startsWith("work/");
		const isConfig = file.startsWith("config/");
		if (!isWork && !isConfig) continue;
		if (path.posix.basename(file) === ".gitkeep") continue;
		let bytes: Uint8Array;
		try {
			bytes = fs.readFileSync(path.join(vault, file));
		} catch {
			continue;
		}
		const text = decodeText(bytes);
		if (text === undefined || text.includes("\0")) {
			if (isWork) {
				findings.push({ severity: "error", code: "work-binary", message: "not a UTF-8 text file", file });
			}
			continue;
		}
		for (const needle of leaksNoneRepo(repos, text)) {
			findings.push({
				severity: "error",
				code: "none-repo-leak",
				message: `names a repo that is not allowed: ${needle}`,
				file,
			});
		}
	}
	return findings;
}

function secretFindings(vault: string): LintFinding[] {
	const findings: LintFinding[] = [];
	for (const file of vaultFiles(vault)) {
		if (file === "index.md") continue;
		const text = readText(path.join(vault, file));
		if (text === undefined) continue;
		for (const name of scanSecrets(text)) {
			findings.push({ severity: "error", code: "secret", message: `secret pattern matched: ${name}`, file });
		}
	}
	return findings;
}

/** Notes are `.md` files in a type folder whose name does not start with a dot. */
function loadNotes(vault: string, findings: LintFinding[]): LoadedNote[] {
	const loaded: LoadedNote[] = [];
	for (const type of NOTE_TYPES) {
		const folder = TYPE_FOLDER[type];
		const dir = path.join(vault, folder);
		for (const name of readDirNames(dir).sort()) {
			if (name.startsWith(".") || !name.endsWith(".md")) continue;
			const file = `${folder}/${name}`;
			const basename = name.slice(0, -".md".length);
			try {
				loaded.push({ file, note: parseNote(basename, fs.readFileSync(path.join(dir, name), "utf8")) });
			} catch (error) {
				findings.push({ severity: "error", code: "parse", message: errorMessage(error), file });
			}
		}
	}
	return loaded;
}

function noteFindings(vault: string, loaded: LoadedNote[], opts: LintOptions): LintFinding[] {
	const repos = readRepos(vault);
	const findings: LintFinding[] = [];
	for (const { file, note } of loaded) {
		const folderType = FOLDER_TYPES[path.posix.dirname(file)];
		if (folderType !== undefined && note.type !== folderType) {
			findings.push({
				severity: "error",
				code: "schema",
				message: `note type ${note.type} does not match its folder ${path.posix.dirname(file)}`,
				file,
			});
		}
		for (const message of validateNote(note)) {
			findings.push({ severity: "error", code: "schema", message, file });
		}
		const rawRepo = note.props.repo;
		const repo = typeof rawRepo === "string" ? rawRepo : undefined;
		const tracked = repo === undefined ? undefined : opts.trackedFiles?.(repo);
		for (const message of checkNote(repos, note, tracked)) {
			findings.push({ severity: "error", code: "repo-not-allowed", message, file });
		}
		if (!VERBATIM_BODY_TYPES.includes(note.type)) {
			const absolute = ABSOLUTE_PATH_RE.exec(note.body);
			if (absolute !== null) {
				findings.push({
					severity: "error",
					code: "absolute-path",
					message: `absolute path in the note body: ${absolute[2]}`,
					file,
				});
			}
		}
	}
	return findings;
}

function logFindings(vault: string, repos: Repos): LintFinding[] {
	const text = readText(path.join(vault, "log.md"));
	if (text === undefined) return [];
	const findings: LintFinding[] = [];
	for (const line of text.split("\n")) {
		const needles = leaksNoneRepo(repos, line);
		if (needles.length === 0) continue;
		findings.push({
			severity: "error",
			code: "none-slug-in-log",
			message: `log line names a repo that is not allowed: ${needles.join(", ")}`,
			file: "log.md",
		});
	}
	return findings;
}

function rangeSecretFindings(vault: string): LintFinding[] {
	const branch = currentBranch(vault);
	const range = branch !== undefined && hasRef(vault, `origin/${branch}`) ? `origin/${branch}..HEAD` : undefined;
	const log = git(vault, range === undefined ? ["log", "-p"] : ["log", "-p", range]);
	if (log.code !== 0) return [];
	return scanSecrets(log.stdout).map((name) => ({
		severity: "error" as const,
		code: "secret",
		message: `secret pattern matched in the commits: ${name}`,
	}));
}

function linkTargets(body: string): string[] {
	const targets: string[] = [];
	for (const match of body.matchAll(LINK_RE)) {
		const target = match[1].split("|")[0].split("#")[0].trim();
		if (target !== "") targets.push(target);
	}
	return targets;
}

function linkFindings(loaded: LoadedNote[], findings: LintFinding[]): LintFinding[] {
	const basenames = new Set(loaded.map((entry) => entry.note.basename));
	const inbound = new Map<string, Set<string>>();
	for (const { file, note } of loaded) {
		for (const target of linkTargets(note.body)) {
			if (!basenames.has(target)) {
				findings.push({
					severity: "info",
					code: "dangling-link",
					message: `link to a note that does not exist: ${target}`,
					file,
				});
				continue;
			}
			const sources = inbound.get(target) ?? new Set<string>();
			sources.add(note.basename);
			inbound.set(target, sources);
		}
	}
	for (const { file, note } of loaded) {
		const sources = inbound.get(note.basename) ?? new Set<string>();
		const linked = [...sources].some((source) => source !== note.basename);
		if (!linked) {
			findings.push({ severity: "info", code: "orphan", message: "no other note links to this note", file });
		}
	}
	return findings;
}

export function lintVault(vault: string, opts: LintOptions = {}): LintFinding[] {
	const findings: LintFinding[] = secretFindings(vault);
	findings.push(...workFindings(vault));
	const loaded = loadNotes(vault, findings);
	findings.push(...noteFindings(vault, loaded, opts));
	findings.push(...logFindings(vault, readRepos(vault)));
	if (opts.range === true) findings.push(...rangeSecretFindings(vault));
	findings.push(...linkFindings(loaded, []));
	return findings;
}

/**
 * Every `.md` note and `.gitkeep` in a type folder, the root files, `templates/`,
 * every file below `work/` at any depth, and the two managed files below
 * `config/` (`dispatch.json` and `.gitkeep`).
 */
function isManaged(relative: string): boolean {
	const file = relative.replace(/\\/g, "/");
	if (file.startsWith("templates/")) return true;
	if (file.startsWith("work/")) return true;
	if (file === "config/dispatch.json" || file === "config/.gitkeep") return true;
	const parts = file.split("/");
	const top = parts[0];
	const rest = parts.slice(1);
	if (rest.length > 0 && TYPE_FOLDERS.includes(top)) {
		const base = rest[rest.length - 1];
		if (base === ".gitkeep") return true;
		return base.endsWith(".md") && !base.startsWith(".");
	}
	return MANAGED_ROOT_FILES.includes(file);
}

function git(cwd: string, args: string[]): GitResult {
	try {
		const stdout = execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		return { code: 0, stdout, stderr: "" };
	} catch (error) {
		const failure = error as { status?: number | null; stdout?: unknown; stderr?: unknown };
		return {
			code: typeof failure.status === "number" ? failure.status : 1,
			stdout: typeof failure.stdout === "string" ? failure.stdout : "",
			stderr: typeof failure.stderr === "string" ? failure.stderr : "",
		};
	}
}

function firstLine(text: string): string {
	return text.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
}

function gitDir(vault: string): string {
	const result = git(vault, ["rev-parse", "--git-dir"]);
	const dir = result.stdout.trim();
	if (result.code !== 0 || dir === "") return path.join(vault, ".git");
	return path.isAbsolute(dir) ? dir : path.join(vault, dir);
}

function rebaseInProgress(vault: string): boolean {
	const dir = gitDir(vault);
	return fs.existsSync(path.join(dir, "rebase-merge")) || fs.existsSync(path.join(dir, "rebase-apply"));
}

function currentBranch(vault: string): string | undefined {
	const result = git(vault, ["rev-parse", "--abbrev-ref", "HEAD"]);
	const branch = result.stdout.trim();
	return result.code === 0 && branch !== "" && branch !== "HEAD" ? branch : undefined;
}

function revParse(vault: string, ref: string): string | undefined {
	const result = git(vault, ["rev-parse", "--verify", "--quiet", ref]);
	const value = result.stdout.trim();
	return result.code === 0 && value !== "" ? value : undefined;
}

function hasRef(vault: string, ref: string): boolean {
	return revParse(vault, ref) !== undefined;
}

function hasOrigin(vault: string): boolean {
	const result = git(vault, ["remote"]);
	return result.code === 0 && result.stdout.split("\n").map((line) => line.trim()).includes("origin");
}

function stashList(vault: string): string {
	return git(vault, ["stash", "list"]).stdout;
}

function unmergedPaths(vault: string): string[] {
	const result = git(vault, ["status", "--porcelain"]);
	if (result.code !== 0) return [];
	return result.stdout
		.split("\n")
		.filter((line) => UNMERGED_CODES.has(line.slice(0, 2)))
		.map((line) => line.slice(3));
}

/** The tree value of each status line, with a rename resolved to its new path. */
function changedPaths(vault: string): string[] {
	const result = git(vault, ["status", "--porcelain", "-uall"]);
	if (result.code !== 0) return [];
	const files: string[] = [];
	for (const line of result.stdout.split("\n")) {
		if (line.length < 4) continue;
		let file = line.slice(3);
		const arrow = file.lastIndexOf(" -> ");
		if (arrow !== -1) file = file.slice(arrow + " -> ".length);
		if (file.startsWith('"') && file.endsWith('"')) {
			try {
				file = JSON.parse(file) as string;
			} catch {
				continue;
			}
		}
		if (file !== "") files.push(file);
	}
	return files;
}

/** Undo a pull that left a rebase, unmerged paths or a changed stash list. */
function undoPull(vault: string, head: string | undefined, stashBefore: string): string | undefined {
	if (rebaseInProgress(vault)) {
		git(vault, ["rebase", "--abort"]);
		return "pull conflict: rebase aborted, the tree is as it was";
	}
	const stashChanged = stashList(vault) !== stashBefore;
	if (unmergedPaths(vault).length === 0 && !stashChanged) return undefined;
	if (head === undefined) return "pull conflict: the tree could not be restored";
	git(vault, ["reset", "--hard", head]);
	if (stashChanged) git(vault, ["stash", "pop"]);
	return "pull conflict: local changes restored, the tree is as it was";
}

export function syncPull(vault: string): SyncResult {
	if (!hasOrigin(vault)) return { code: 1, message: "no remote configured", unmanaged: [] };
	const branch = currentBranch(vault);
	if (branch === undefined) return { code: 5, message: "cannot determine the current branch", unmanaged: [] };
	const head = revParse(vault, "HEAD");
	const stashBefore = stashList(vault);
	const upstream = hasRef(vault, `${branch}@{upstream}`);
	if (!upstream) {
		const fetch = git(vault, ["fetch", "origin"]);
		if (fetch.code !== 0) {
			return { code: 5, message: `fetch failed: ${firstLine(fetch.stderr || fetch.stdout)}`, unmanaged: [] };
		}
		if (!hasRef(vault, `origin/${branch}`)) return { code: 0, message: "nothing to pull yet", unmanaged: [] };
	}
	const pull = upstream
		? git(vault, ["pull", "--rebase", "--autostash"])
		: git(vault, ["pull", "--rebase", "--autostash", "origin", branch]);
	const conflict = undoPull(vault, head, stashBefore);
	if (conflict !== undefined) return { code: 5, message: conflict, unmanaged: [] };
	if (pull.code !== 0) {
		return { code: 5, message: `pull failed: ${firstLine(pull.stderr || pull.stdout)}`, unmanaged: [] };
	}
	writeIndex(vault);
	return { code: 0, message: "pulled", unmanaged: [] };
}

function commitMessage(opts: { summary?: string; trace?: string }): string {
	const summary = opts.summary !== undefined && opts.summary.trim() !== "" ? opts.summary : "update";
	const trace = opts.trace !== undefined && opts.trace.trim() !== "" ? ` [trace ${opts.trace}]` : "";
	return `vault: ${summary}${trace}`;
}

/** The commit arguments, with a fallback identity when git config has no user.email. */
function commitArgs(vault: string, message: string): string[] {
	const identity = git(vault, ["config", "user.email"]);
	const flags =
		identity.code !== 0 || identity.stdout.trim() === ""
			? ["-c", "user.name=agent-vault", "-c", "user.email=agent-vault@localhost"]
			: [];
	return [...flags, "commit", "-m", message];
}

function pushOnce(vault: string): GitResult {
	const branch = currentBranch(vault);
	const upstream = branch !== undefined && hasRef(vault, `${branch}@{upstream}`);
	return upstream ? git(vault, ["push"]) : git(vault, ["push", "-u", "origin", "HEAD"]);
}

function pushRejected(result: GitResult): boolean {
	return /non-fast-forward|remote rejected/.test(`${result.stderr}${result.stdout}`);
}

function describeFindings(findings: LintFinding[]): string {
	const parts = findings.map((finding) => (finding.file === undefined ? finding.code : `${finding.code} (${finding.file})`));
	return [...new Set(parts)].join(", ");
}

export function syncPush(vault: string, opts: { summary?: string; trace?: string } = {}): SyncResult {
	const errors = lintVault(vault, { range: true }).filter((finding) => finding.severity === "error");
	if (errors.length > 0) {
		return { code: 1, message: `lint failed: ${describeFindings(errors)}`, unmanaged: [] };
	}
	const changed = changedPaths(vault);
	const unmanaged = changed.filter((file) => !isManaged(file));
	const managed = changed.filter((file) => isManaged(file));
	if (managed.length > 0) git(vault, ["add", "--", ...managed]);
	if (git(vault, ["diff", "--cached", "--quiet"]).code !== 0) {
		const commit = git(vault, commitArgs(vault, commitMessage(opts)));
		if (commit.code !== 0) {
			return { code: 1, message: `commit failed: ${firstLine(commit.stderr || commit.stdout)}`, unmanaged };
		}
	}
	if (!hasOrigin(vault)) return { code: 1, message: "no remote configured", unmanaged };
	const pulled = syncPull(vault);
	if (pulled.code !== 0) return { code: pulled.code, message: pulled.message, unmanaged };
	const push = pushOnce(vault);
	if (push.code === 0) return { code: 0, message: "pushed", unmanaged };
	if (!pushRejected(push)) {
		return { code: 5, message: `push failed: ${firstLine(push.stderr || push.stdout)}`, unmanaged };
	}
	const pulledAgain = syncPull(vault);
	if (pulledAgain.code !== 0) return { code: pulledAgain.code, message: pulledAgain.message, unmanaged };
	if (pushOnce(vault).code === 0) return { code: 0, message: "pushed", unmanaged };
	return { code: 5, message: "push rejected (non-fast-forward)", unmanaged };
}
