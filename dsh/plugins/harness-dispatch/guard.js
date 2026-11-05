/**
 * Worker-side guardrails (G2): a pure policy that limits edits to the task's
 * `files:`, refuses paths outside the repo and under `.git/` or `.plans/`,
 * refuses destructive shell commands, and refuses the vault for every tool.
 *
 * A shell write can never be policed completely; the git evidence and gate are
 * the backstop. Known limit, unchanged from Pi.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const BLOCKED_MARKER = "BLOCKED by harness-dispatch:";
export const GUARD_ENV = "PI_PLAN_DISPATCH_GUARD";
export const VAULT_ENV = "PI_PLAN_DISPATCH_VAULT";

const EDIT_TOOL = /edit|write|patch/i;
const SHELL_TOOL = /bash|shell/i;
const PATH_KEYS = ["path", "file_path", "filePath", "file"];
const ALWAYS_DENIED = [".git", ".plans"];
const READONLY_WHY = "this role is read-only, so no file may be changed here. Put your findings in the final message, or list the change under NEEDS instead.";
const VAULT_WHY = "is inside the knowledge vault, which no worker may read or write. List what you need from the vault under NEEDS instead.";

const allow = () => ({ block: false });
const block = (reason) => ({ block: true, reason: `${BLOCKED_MARKER} ${reason}` });

function asRecord(input) {
	return input && typeof input === "object" && !Array.isArray(input) ? input : {};
}

function pathArg(args) {
	for (const key of PATH_KEYS) {
		const v = args[key];
		if (typeof v === "string" && v.trim()) return v;
	}
	return undefined;
}

function normaliseArg(value) {
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

function repoRelative(cwd, p) {
	const rel = path.relative(cwd, path.resolve(cwd, p)).replace(/\\/g, "/");
	if (path.isAbsolute(rel)) return undefined;
	if (rel === ".." || rel.startsWith("../")) return undefined;
	return rel;
}

function coveredBy(rel, files, cwd) {
	for (const entry of files) {
		const norm = repoRelative(cwd, entry);
		if (norm === undefined) continue;
		if (norm === "") return true;
		if (rel === norm || rel.startsWith(`${norm}/`)) return true;
	}
	return false;
}

const GIT_GLOBAL = String.raw`(?:\s+(?:-C\s+\S+|-C\S+|-c\s+\S+|-c\S*=|--no-pager|-p|--paginate|--git-dir=\S+|--git-dir\s+\S+|--work-tree=\S+|--work-tree\s+\S+|--no-replace-objects))*`;
const git = (rest) => new RegExp(String.raw`\bgit${GIT_GLOBAL}\s+(?:${rest})`, "i");

const BASH_DENY = [
	{ re: /\bsudo\b/i, why: "sudo is never allowed in a worker" },
	{ re: git("(?:commit|push|stash|rebase|merge|tag|clean)\\b"), why: "git state belongs to the planner (commit, push, stash, rebase, merge, tag, clean)" },
	{ re: git("reset\\b[^\\n;&|]*--hard"), why: "git reset --hard discards work" },
	{ re: git("checkout\\s+(?:--\\s|\\.(?:\\s|$))"), why: "git checkout -- / git checkout . discards local changes" },
	{ re: git("branch\\s+(?:-D\\b|--delete\\b)"), why: "deleting branches is not a worker's job" },
	{ re: /\bgh\s+pr\s+(?:create|merge)\b/i, why: "the planner owns pull requests" },
	{ re: /\bnpm\s+publish\b/i, why: "publishing a package is not a worker's job" },
	{ re: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/i, why: "piping a download into a shell is not allowed" },
];

function deniesRm(command) {
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

const READONLY_WRITE_WHY = "read-only roles may not write files, even through the shell";
const WRITE_COMMANDS = new Set(["mv", "cp", "touch", "rm", "mkdir", "install", "ln", "chmod", "chown", "tee"]);
const SHELL_KEYWORDS = new Set(["do", "then", "else", "elif", "if", "while", "until", "for", "{", "}", "!", "time"]);
const WRAPPERS = new Set(["env", "command", "nohup", "exec", "xargs", "nice", "stdbuf", "time", "timeout"]);
const WRAPPER_OPTION_ARGS = {
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
const IN_PLACE_EDIT = [
	{ re: /\bsed\b[^\n;&|]*\s(?:-[a-zA-Z]*i|--in-place)\b/i, why: "sed -i edits files in place" },
	{ re: /\bperl\b[^\n;&|]*\s-[a-zA-Z]*i\b/i, why: "perl -i edits files in place" },
];

function skipWrapperWords(words, wrapper) {
	const withArg = WRAPPER_OPTION_ARGS[wrapper] ?? new Set();
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
	if (wrapper === "timeout") words.shift();
}

function commandWord(segment) {
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

function commandWords(command) {
	return command
		.split(/[|;&\n()]+/)
		.map(commandWord)
		.filter(Boolean);
}

function withoutQuotes(command) {
	return command.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
}

function redirectTarget(rest) {
	const m = /^\s*([^\s;&|)]+)/.exec(rest);
	return m ? m[1] : "";
}

function redirectWord(rest) {
	return redirectTarget(rest.startsWith("|") ? rest.slice(1) : rest);
}

function isHarmlessTarget(target) {
	return target === "" || target === "/dev/null" || /^&[12]$/.test(target);
}

function deniesRedirect(command) {
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

function denyReadonlyWrite(command) {
	for (const { re, why } of IN_PLACE_EDIT) if (re.test(command)) return why;
	const words = commandWords(command);
	for (const word of words) if (WRITE_COMMANDS.has(word)) return `${word} writes to the filesystem`;
	if (words.includes("dd") && /\bdd\b[^\n;&|]*\bof=/.test(command)) return "dd with of= writes to the filesystem";
	return deniesRedirect(command);
}

function denyReason(command) {
	for (const { re, why } of BASH_DENY) if (re.test(command)) return why;
	if (deniesRm(command)) return "rm -rf / rm -fr deletes without review";
	return undefined;
}

function vaultFromEnv(env) {
	const raw = env[VAULT_ENV];
	if (typeof raw !== "string" || !raw.trim() || !path.isAbsolute(raw)) return undefined;
	const resolved = path.resolve(raw);
	try {
		return fs.realpathSync(resolved);
	} catch {
		return resolved;
	}
}

function realpathLoose(p) {
	let head = p;
	const tail = [];
	for (;;) {
		try {
			return path.join(fs.realpathSync(head), ...tail.reverse());
		} catch {
			const parent = path.dirname(head);
			if (parent === head) return p;
			tail.push(path.basename(head));
			head = parent;
		}
	}
}

function samePath(a, b) {
	const fold = (p) => p.replace(/\\/g, "/");
	const ci = process.platform === "darwin" || process.platform === "win32";
	return ci ? fold(a).toLowerCase() === fold(b).toLowerCase() : fold(a) === fold(b);
}

function insideVault(target, vault) {
	if (samePath(target, vault)) return true;
	const sep = vault.endsWith("/") || vault.endsWith("\\") ? "" : path.sep;
	const prefix = `${vault}${sep}`;
	const ci = process.platform === "darwin" || process.platform === "win32";
	return ci ? target.toLowerCase().startsWith(prefix.toLowerCase()) : target.startsWith(prefix);
}

function checkVault(policy, args) {
	if (!policy.vault) return undefined;
	const vaultRoot = realpathLoose(path.resolve(policy.vault));
	for (const key of PATH_KEYS) {
		const value = args[key];
		if (typeof value !== "string" || !value.trim()) continue;
		const normalised = normaliseArg(value);
		if (normalised === undefined) continue;
		const target = realpathLoose(path.resolve(policy.cwd, normalised));
		if (insideVault(target, vaultRoot)) return block(`${value} ${VAULT_WHY}`);
	}
	return undefined;
}

export function policyFromEnv(env, cwd) {
	const vault = vaultFromEnv(env);
	const raw = env[GUARD_ENV];
	let parsed;
	if (raw) {
		try {
			parsed = JSON.parse(raw);
		} catch {
			parsed = undefined;
		}
	}
	let policy;
	if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
		const obj = parsed;
		const files = Array.isArray(obj.files) ? obj.files.filter((f) => typeof f === "string") : [];
		policy = { cwd, files, bash: obj.bash === true, readonly: obj.readonly === true };
	}
	if (policy) return vault === undefined ? policy : { ...policy, vault };
	if (vault === undefined) return undefined;
	return { cwd, files: [], bash: false, readonly: false, vault, vaultOnly: true };
}

function checkEdit(policy, toolName, args) {
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

function checkBash(policy, command) {
	if (!policy.bash || !command.trim()) return allow();
	const why = denyReason(command);
	if (why) return block(`${why}. Do the safe part with tools, and list anything risky under NEEDS instead.`);
	if (!policy.readonly) return allow();
	const write = denyReadonlyWrite(command);
	if (!write) return allow();
	return block(`${READONLY_WRITE_WHY} (${write}). Put your findings in the final message, or list the change under NEEDS instead.`);
}

export function checkToolCall(policy, toolName, input) {
	const args = asRecord(input);
	const vault = checkVault(policy, args);
	if (vault) return vault;
	if (policy.vaultOnly) return allow();
	if (EDIT_TOOL.test(toolName)) return checkEdit(policy, toolName, args);
	const isShell = SHELL_TOOL.test(toolName) || typeof args.command === "string";
	if (isShell) return checkBash(policy, typeof args.command === "string" ? args.command : "");
	return allow();
}
