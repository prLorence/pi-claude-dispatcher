/**
 * Worker-side guardrails: a `tool_call` policy for processes started with
 * PI_PLAN_DISPATCH_WORKER=1. Edits are limited to the task's `files:` and
 * destructive shell commands are refused. A read-only role (reviewers,
 * security) may not edit anything at all. No Pi imports and no local imports,
 * so a worker can load this on its own.
 *
 * Known gap: shell writes cannot be policed reliably (`sh -c "..."`, scripts,
 * an editor). For read-only roles the obvious shapes are denied below, but that
 * is best-effort only: the dirty-file snapshot taken before and after a reviewer
 * run is the real backstop, backed by the gate.
 */
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const BLOCKED_MARKER = "BLOCKED by pi-plan-dispatch:";
export const GUARD_ENV = "PI_PLAN_DISPATCH_GUARD";

export interface GuardPolicy {
	cwd: string;
	files: string[];
	bash: boolean;
	/** A read-only role: every edit-like tool call is refused. */
	readonly?: boolean;
}

export interface GuardDecision {
	block: boolean;
	/** Starts with BLOCKED_MARKER. */
	reason?: string;
}

const EDIT_TOOL = /edit|write|patch/i;
const SHELL_TOOL = /bash|shell/i;
const PATH_KEYS = ["path", "file_path", "filePath", "file"];
const ALWAYS_DENIED = [".git", ".plans"];
const READONLY_WHY = "this role is read-only, so no file may be changed here. Put your findings in the final message, or list the change under NEEDS instead.";

const allow = (): GuardDecision => ({ block: false });

function block(reason: string): GuardDecision {
	return { block: true, reason: `${BLOCKED_MARKER} ${reason}` };
}

function asRecord(input: unknown): Record<string, unknown> {
	return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

function pathArg(args: Record<string, unknown>): string | undefined {
	for (const key of PATH_KEYS) {
		const v = args[key];
		if (typeof v === "string" && v.trim()) return v;
	}
	return undefined;
}

/**
 * Resolve a path argument the way Pi does: drop a leading `@`, expand a leading
 * `~` or `~/`, convert a `file://` URL to a path. Undefined when a URL cannot be
 * converted, which is treated like a path outside the repo.
 */
function normaliseArg(value: string): string | undefined {
	let p = value.trim();
	if (p.startsWith("@")) p = p.slice(1);
	if (p === "~" || p.startsWith("~/")) p = path.join(os.homedir(), p.slice(1));
	if (/^file:/i.test(p)) {
		try {
			p = fileURLToPath(p);
		} catch {
			return undefined;
		}
	}
	return p;
}

/** Repo-relative, forward-slash path, or undefined when it escapes the repo. */
function repoRelative(cwd: string, p: string): string | undefined {
	const rel = path.relative(cwd, path.resolve(cwd, p)).replace(/\\/g, "/");
	if (path.isAbsolute(rel)) return undefined;
	if (rel === ".." || rel.startsWith("../")) return undefined;
	return rel;
}

function coveredBy(rel: string, files: string[], cwd: string): boolean {
	for (const entry of files) {
		const norm = repoRelative(cwd, entry);
		if (norm === undefined) continue;
		// `files: .` covers the whole repo
		if (norm === "") return true;
		if (rel === norm || rel.startsWith(`${norm}/`)) return true;
	}
	return false;
}

// ---------- Shell deny list ----------

/** Git's global options, as they may sit between `git` and the subcommand, repeated. */
const GIT_GLOBAL = String.raw`(?:\s+(?:-C\s+\S+|-C\S+|-c\s+\S+|-c\S*=|--no-pager|-p|--paginate|--git-dir=\S+|--git-dir\s+\S+|--work-tree=\S+|--work-tree\s+\S+|--no-replace-objects))*`;

/** `git <global options> <rest>`, so `git --no-pager push` is caught too. */
const git = (rest: string): RegExp => new RegExp(String.raw`\bgit${GIT_GLOBAL}\s+(?:${rest})`, "i");

const BASH_DENY: { re: RegExp; why: string }[] = [
	{ re: /\bsudo\b/i, why: "sudo is never allowed in a worker" },
	{ re: git("(?:commit|push|stash|rebase|merge|tag|clean)\\b"), why: "git state belongs to the planner (commit, push, stash, rebase, merge, tag, clean)" },
	{ re: git("reset\\b[^\\n;&|]*--hard"), why: "git reset --hard discards work" },
	{ re: git("checkout\\s+(?:--\\s|\\.(?:\\s|$))"), why: "git checkout -- / git checkout . discards local changes" },
	{ re: git("branch\\s+(?:-D\\b|--delete\\b)"), why: "deleting branches is not a worker's job" },
	{ re: /\bgh\s+pr\s+(?:create|merge)\b/i, why: "the planner owns pull requests" },
	{ re: /\bnpm\s+publish\b/i, why: "publishing a package is not a worker's job" },
	{ re: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/i, why: "piping a download into a shell is not allowed" },
];

/**
 * `rm` with both a recursive and a force flag: any short cluster (`-rf`, `-fr`,
 * `-Rf`, `-r -f`) or the exact `--recursive` and `--force`. Letters inside long
 * options do not count, so `rm --preserve-root file` stays a plain remove.
 */
function deniesRm(command: string): boolean {
	const re = /\brm\s+([^\n;&|]*)/gi;
	for (let m = re.exec(command); m; m = re.exec(command)) {
		let recursive = false;
		let force = false;
		for (const word of m[1].split(/\s+/).filter(Boolean)) {
			if (word === "--") break;
			if (word === "--recursive") recursive = true;
			else if (word === "--force") force = true;
			else if (/^-[^-]/.test(word)) {
				if (/[rR]/.test(word.slice(1))) recursive = true;
				if (/f/.test(word.slice(1))) force = true;
			}
			if (recursive && force) return true;
		}
	}
	return false;
}

// ---------- Read-only shell writes ----------

/**
 * Best-effort: catches the obvious ways a shell writes a file, in a read-only
 * role. It cannot see writes hidden in `sh -c "..."`, in a quoted string, in a
 * script the worker runs or in an editor, so the dirty-file snapshot before and
 * after each reviewer run is what actually proves a reviewer changed nothing.
 */
const READONLY_WRITE_WHY = "read-only roles may not write files, even through the shell";

/** Commands that write files. Matched in command position only, so `cat src/tee.ts` stays a read. */
const WRITE_COMMANDS = new Set(["mv", "cp", "touch", "rm", "mkdir", "install", "ln", "chmod", "chown", "tee"]);
const SHELL_KEYWORDS = new Set(["do", "then", "else", "elif", "if", "while", "until", "for", "{", "}", "!", "time"]);
/** Words that run another command, so the command is not in command position itself. */
const WRAPPERS = new Set(["env", "command", "nohup", "exec", "xargs", "nice", "stdbuf", "time", "timeout"]);
/** Wrapper options that consume the next word as their argument. */
const WRAPPER_OPTION_ARGS: Record<string, Set<string>> = {
	env: new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]),
	command: new Set(),
	nohup: new Set(),
	exec: new Set(["-a"]),
	xargs: new Set(["-I", "-n", "-P", "-d", "-E", "-L", "-s", "--replace", "--max-args", "--max-procs", "--delimiter", "--eof", "--max-lines", "--max-chars"]),
	nice: new Set(["-n", "--adjustment"]),
	stdbuf: new Set(["-i", "-o", "-e", "--input", "--output", "--error"]),
	time: new Set(),
	timeout: new Set(["-s", "--signal", "-k", "--kill-after"]),
};
const VAR_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const IN_PLACE_EDIT: { re: RegExp; why: string }[] = [
	{ re: /\bsed\b[^\n;&|]*\s(?:-[a-zA-Z]*i|--in-place)\b/i, why: "sed -i edits files in place" },
	{ re: /\bperl\b[^\n;&|]*\s-[a-zA-Z]*i\b/i, why: "perl -i edits files in place" },
];

/**
 * Drop one wrapper's own words: options, their arguments, `VAR=value`, and for
 * `timeout` its duration, so the next command word is left in front.
 */
function skipWrapperWords(words: string[], wrapper: string): void {
	const withArg = WRAPPER_OPTION_ARGS[wrapper] ?? new Set<string>();
	while (words.length > 0) {
		const word = words[0];
		if (word === "--") {
			words.shift();
			break;
		}
		if (VAR_ASSIGN.test(word)) {
			words.shift();
			continue;
		}
		if (!word.startsWith("-")) break;
		words.shift();
		if (withArg.has(word) || withArg.has(word.split("=")[0])) words.shift();
	}
	// `timeout <duration> <command>`: the duration is positional, after the options
	if (wrapper === "timeout") words.shift();
}

/** First real command word of one simple command, skipping keywords, `VAR=value` and wrapper commands. */
function commandWord(segment: string): string | undefined {
	const words = segment.trim().split(/\s+/).filter(Boolean);
	while (words.length > 0) {
		const word = words[0];
		const base = word.split("/").pop() ?? word;
		if (WRAPPERS.has(base)) {
			words.shift();
			skipWrapperWords(words, base);
			continue;
		}
		if (SHELL_KEYWORDS.has(word) || VAR_ASSIGN.test(word)) {
			words.shift();
			continue;
		}
		break;
	}
	return words[0]?.split("/").pop();
}

function commandWords(command: string): string[] {
	const words = command.split(/[|;&\n()]+/).map(commandWord);
	return words.filter((w): w is string => Boolean(w));
}

/** Quoted text is not a redirect (`git log --format='%h -> %s'`). */
function withoutQuotes(command: string): string {
	return command.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
}

/** The word after the `>` run, stopping at a separator. */
function redirectTarget(rest: string): string {
	const m = /^\s*([^\s;&|)]+)/.exec(rest);
	return m ? m[1] : "";
}

/** `>|` is the noclobber override: the file is still the word after the bar. */
function redirectWord(rest: string): string {
	return redirectTarget(rest.startsWith("|") ? rest.slice(1) : rest);
}

/** `&1`, `&2` and /dev/null are not files; everything else written with `>` is. */
function isHarmlessTarget(target: string): boolean {
	return target === "" || target === "/dev/null" || /^&[12]$/.test(target);
}

function deniesRedirect(command: string): string | undefined {
	const text = withoutQuotes(command);
	for (let i = text.indexOf(">"); i !== -1; i = text.indexOf(">", i + 1)) {
		let end = i;
		while (text[end + 1] === ">") end++;
		const target = redirectWord(text.slice(end + 1));
		if (isHarmlessTarget(target)) continue;
		return `redirecting output with > writes ${target}`;
	}
	return undefined;
}

function denyReadonlyWrite(command: string): string | undefined {
	for (const { re, why } of IN_PLACE_EDIT) if (re.test(command)) return why;
	const words = commandWords(command);
	for (const word of words) if (WRITE_COMMANDS.has(word)) return `${word} writes to the filesystem`;
	if (words.includes("dd") && /\bdd\b[^\n;&|]*\bof=/.test(command)) return "dd with of= writes to the filesystem";
	return deniesRedirect(command);
}

function denyReason(command: string): string | undefined {
	for (const { re, why } of BASH_DENY) if (re.test(command)) return why;
	if (deniesRm(command)) return "rm -rf / rm -fr deletes without review";
	return undefined;
}

// ---------- Policy ----------

export function policyFromEnv(env: NodeJS.ProcessEnv, cwd: string): GuardPolicy | undefined {
	const raw = env[GUARD_ENV];
	if (!raw) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	const obj = parsed as Record<string, unknown>;
	const files = Array.isArray(obj.files) ? obj.files.filter((f): f is string => typeof f === "string") : [];
	return { cwd, files, bash: obj.bash === true, readonly: obj.readonly === true };
}

function checkEdit(policy: GuardPolicy, toolName: string, args: Record<string, unknown>): GuardDecision {
	if (policy.readonly) return block(READONLY_WHY);
	const raw = pathArg(args);
	if (raw === undefined) {
		if (policy.files.length === 0) return allow();
		return block(`could not tell which path the ${toolName} tool targets. Edit a file listed under this task's files, or list this under NEEDS instead.`);
	}
	const normalised = normaliseArg(raw);
	const rel = normalised === undefined ? undefined : repoRelative(policy.cwd, normalised);
	if (rel === undefined) {
		return block(`${raw} is outside the repository. Only edit files listed under this task's files, or list this under NEEDS instead.`);
	}
	// The filesystem is case-insensitive: `.GIT/config` reaches the real `.git`.
	const lower = rel.toLowerCase();
	for (const denied of ALWAYS_DENIED) {
		if (lower === denied || lower.startsWith(`${denied}/`)) {
			return block(`edits inside ${denied}/ are never allowed for a worker. List this under NEEDS instead.`);
		}
	}
	if (policy.files.length === 0) return allow();
	if (!coveredBy(rel, policy.files, policy.cwd)) {
		return block(`${rel} is outside this task's files (${policy.files.join(", ")}). List this under NEEDS instead.`);
	}
	return allow();
}

function checkBash(policy: GuardPolicy, command: string): GuardDecision {
	if (!policy.bash || !command.trim()) return allow();
	const why = denyReason(command);
	if (why) return block(`${why}. Do the safe part with tools, and list anything risky under NEEDS instead.`);
	if (!policy.readonly) return allow();
	const write = denyReadonlyWrite(command);
	if (!write) return allow();
	return block(`${READONLY_WRITE_WHY} (${write}). Put your findings in the final message, or list the change under NEEDS instead.`);
}

export function checkToolCall(policy: GuardPolicy, toolName: string, input: unknown): GuardDecision {
	const args = asRecord(input);
	if (EDIT_TOOL.test(toolName)) return checkEdit(policy, toolName, args);
	const isShell = SHELL_TOOL.test(toolName) || typeof args.command === "string";
	if (isShell) return checkBash(policy, typeof args.command === "string" ? args.command : "");
	return allow();
}
