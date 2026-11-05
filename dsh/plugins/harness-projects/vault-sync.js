/**
 * Vault replication status and the sanctioned sync path.
 *
 * This module never writes a vault file and never touches the vault's git
 * index: it reads state with read-only git plumbing, and `pull`/`push` go
 * through `vault.mjs sync`, the one supported writer. That keeps
 * `harness-vault`'s ownership intact — this plugin surfaces the state, the CLI
 * performs the change.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** Read-only `git -C <vault> <args>`; never throws, never mutates the index. */
function git(cwd, args, { timeoutMs = 6000 } = {}) {
	return new Promise((resolve) => {
		execFile(
			"git",
			["-C", cwd, ...args],
			{
				timeout: timeoutMs,
				env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
				maxBuffer: 4 * 1024 * 1024,
			},
			(error, stdout, stderr) => {
				if (error && error.killed) return resolve({ code: null, stdout: String(stdout ?? ""), stderr: "git timed out" });
				resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
			},
		);
	});
}

/**
 * Where the vault lives and how far it has drifted from its remote.
 * Returns `{ ok: false, reason }` rather than throwing: the panel renders the
 * reason, so a missing vault is a state, not an error.
 */
export async function readVaultSync(vaultPath, { remote = "origin" } = {}) {
	if (!vaultPath) return { ok: false, reason: "no vault resolved" };
	if (!fs.existsSync(vaultPath)) return { ok: false, reason: `vault path does not exist: ${vaultPath}` };
	if (!fs.existsSync(path.join(vaultPath, ".git"))) return { ok: false, reason: "vault is not a git repository" };

	const [branch, status, last] = await Promise.all([
		git(vaultPath, ["rev-parse", "--abbrev-ref", "HEAD"]),
		git(vaultPath, ["status", "--porcelain=v1"]),
		git(vaultPath, ["log", "-1", "--format=%h%x00%s%x00%ar"]),
	]);

	const name = branch.code === 0 ? branch.stdout.trim() : "";
	const dirty = status.code === 0 ? status.stdout.split("\n").filter(Boolean).length : 0;
	const [hash = "", subject = "", when = ""] = last.stdout.trim().split("\0");

	// ahead/behind needs an upstream; a vault with no remote is a valid state.
	const upstream = await git(vaultPath, ["rev-parse", "--abbrev-ref", `${remote}/HEAD`]);
	let ahead = 0;
	let behind = 0;
	let hasUpstream = false;
	if (upstream.code === 0) {
		const counts = await git(vaultPath, ["rev-list", "--left-right", "--count", `${upstream.stdout.trim()}...HEAD`]);
		if (counts.code === 0) {
			const [b, a] = counts.stdout.trim().split(/\s+/);
			ahead = Number(a) || 0;
			behind = Number(b) || 0;
			hasUpstream = true;
		}
	}

	return {
		ok: true,
		path: vaultPath,
		name: path.basename(vaultPath),
		branch: name,
		dirty,
		ahead,
		behind,
		hasUpstream,
		lastCommit: hash ? { hash, subject, when } : null,
		// "dirty" outranks drift: uncommitted notes are the riskier state.
		state: dirty > 0 || ahead > 0 ? "pending" : behind > 0 ? "behind" : hasUpstream ? "synced" : "local",
	};
}

/**
 * Run `vault.mjs sync pull|push`. The CLI owns locking and conflict handling;
 * a timeout returns a result the panel can display rather than rejecting.
 */
export function runVaultSync({ skillRoot, action, summary, node = process.execPath, timeoutMs = 60_000, cwd } = {}) {
	return new Promise((resolve) => {
		const script = path.join(skillRoot ?? "", "vault.mjs");
		if (!fs.existsSync(script)) return resolve({ code: 1, stdout: "", stderr: `vault.mjs not found at ${script}`, timedOut: false });
		const args = [script, "sync", action === "push" ? "push" : "pull"];
		if (action === "push" && summary) args.push("--summary", String(summary));

		const child = execFile(
			node,
			args,
			{ timeout: timeoutMs, cwd, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
			(error, stdout, stderr) => {
				if (error && error.killed) return resolve({ code: null, stdout: String(stdout ?? ""), stderr: "sync timed out", timedOut: true });
				resolve({
					code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
					stdout: String(stdout ?? ""),
					stderr: String(stderr ?? ""),
					timedOut: false,
				});
			},
		);
		// vault.mjs reads stdin in some paths; without EOF it can hang to the timeout.
		child.stdin?.end();
	});
}
