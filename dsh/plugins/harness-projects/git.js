/**
 * The git runner. Read-only commands only: rev-parse, status, log, remote.
 *
 * Why node:child_process and not ctx.shell: every command here is a read of a
 * user repository that may live outside the session workspace, and the plugin
 * needs argv-exact arguments (a path can contain a quote). The commands never
 * write, `GIT_OPTIONAL_LOCKS=0` stops git refreshing the index, and every call
 * is bounded by a timeout and an output cap. Plugin code is Host code; the
 * sandbox seam exists for agent-driven shell calls.
 */
import { spawn } from "node:child_process";
import * as path from "node:path";
import { localSlug, parseLog, parseStatus, slugFromRemote } from "./git-parse.js";

export const GIT_ENV = {
	GIT_OPTIONAL_LOCKS: "0",
	GIT_TERMINAL_PROMPT: "0",
	GIT_ASKPASS: "true",
	LC_ALL: "C",
	LANG: "C",
};

const MAX_OUTPUT = 64 * 1024;

/** Spawn `git -C <cwd> <args>`; resolves with code/stdout/stderr, never throws. */
export function runGit(cwd, args, { timeoutMs = 6000, env = {} } = {}) {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		let timedOut = false;
		const child = spawn("git", ["-C", cwd, ...args], {
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, ...GIT_ENV, ...env },
		});
		const finish = (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ code, stdout: cap(stdout), stderr: cap(stderr), timedOut });
		};
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 2000).unref?.();
		}, timeoutMs);
		if (timer.unref) timer.unref();
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
			if (stdout.length > MAX_OUTPUT * 2) stdout = stdout.slice(-MAX_OUTPUT);
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
			if (stderr.length > MAX_OUTPUT * 2) stderr = stderr.slice(-MAX_OUTPUT);
		});
		child.on("error", (error) => {
			stderr += error.message;
			finish(null);
		});
		child.on("close", (code) => finish(code));
	});
}

function cap(text) {
	return text.length > MAX_OUTPUT ? text.slice(-MAX_OUTPUT) : text;
}

/**
 * Everything the plugin needs for one repository path:
 * root, origin slug, branch, dirt, ahead/behind and the newest commits.
 * `dir` may be any directory inside the worktree.
 */
export async function inspectRepo(dir, { logCount = 5, timeoutMs = 6000, runner = runGit } = {}) {
	const top = await runner(dir, ["rev-parse", "--path-format=absolute", "--show-toplevel"], { timeoutMs });
	if (top.code !== 0 || !top.stdout.trim()) {
		return { path: dir, root: null, slug: undefined, error: top.timedOut ? "git timed out" : (top.stderr.trim().split("\n")[0] || "not a git repository"), git: null };
	}
	const root = top.stdout.trim().split("\n").pop().trim();
	const [status, remote, log] = await Promise.all([
		runner(root, ["status", "--porcelain=v2", "--branch", "--untracked-files=normal"], { timeoutMs }),
		runner(root, ["remote", "get-url", "origin"], { timeoutMs }),
		runner(root, ["log", `-n`, String(logCount), "--date=short", "--format=%H%x1f%h%x1f%s%x1f%an%x1f%ar"], { timeoutMs }),
	]);
	const state = parseStatus(status.code === 0 ? status.stdout : "");
	const commits = log.code === 0 ? parseLog(log.stdout) : [];
	const origin = remote.code === 0 ? remote.stdout.trim().split("\n")[0] : "";
	const slug = slugFromRemote(origin) ?? localSlug(root);
	return {
		path: dir,
		root,
		slug,
		origin: origin || undefined,
		name: path.basename(root),
		error: undefined,
		git: {
			...state,
			lastCommit: commits[0],
			commits,
			timedOut: status.timedOut || log.timedOut,
		},
	};
}
