/**
 * Spawn `vault.mjs` with an argument array, no shell, a timeout, and an
 * allow-list of subcommands. This module never writes a vault file.
 */
import { spawn } from "node:child_process";
import * as path from "node:path";

export const ALLOWED_COMMANDS = new Set([
	"resolve",
	"boot",
	"lint",
	"stats",
	"search",
	"eval",
	"note",
	"log",
	"index",
	"repo",
	"sync",
	"work",
	"restore",
	"config",
	"init",
	"setup",
	"doctor",
]);

export class VaultRejected extends Error {}

export function defaultSkillRoot(home) {
	return path.join(home, ".claude", "skills", "dispatch-plan");
}

export function createVaultCli({ skillRoot, node = process.execPath, timeoutMs = 20_000, env = process.env, cwd } = {}) {
	const vaultMjs = path.join(skillRoot, "vault.mjs");
	const run = (args, opts = {}) => {
		const [command] = args;
		if (!command || !ALLOWED_COMMANDS.has(command)) {
			return Promise.reject(new VaultRejected(`rejected vault subcommand: ${command ?? "(none)"}`));
		}
		const limit = opts.timeoutMs ?? timeoutMs;
		return new Promise((resolve) => {
			const started = Date.now();
			let stdout = "";
			let stderr = "";
			let timedOut = false;
			let settled = false;
			const proc = spawn(node, [vaultMjs, ...args], {
				cwd: opts.cwd ?? cwd,
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
				env: { ...env, ...(opts.env ?? {}) },
			});
			const finish = (code) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve({ code, stdout, stderr, timedOut, durationMs: Date.now() - started });
			};
			const timer = setTimeout(() => {
				timedOut = true;
				proc.kill("SIGTERM");
				setTimeout(() => proc.kill("SIGKILL"), 3000).unref?.();
				finish(null);
			}, limit);
			if (timer.unref) timer.unref();
			proc.stdout.on("data", (d) => {
				stdout += d.toString();
				if (stdout.length > 1_000_000) stdout = stdout.slice(-500_000);
			});
			proc.stderr.on("data", (d) => {
				stderr += d.toString();
				if (stderr.length > 1_000_000) stderr = stderr.slice(-500_000);
			});
			proc.on("error", (e) => {
				stderr += `${e.message}\n`;
				finish(null);
			});
			proc.on("close", (code) => finish(code));
			if (opts.stdin !== undefined) {
				proc.stdin.end(opts.stdin);
			} else {
				proc.stdin.end();
			}
		});
	};
	return { run, vaultMjs, skillRoot };
}

/** One plain failure line: never blocks a session. */
export function failureLine(step, result) {
	if (result.timedOut) return `vault ${step}: timed out after ${Math.round(result.durationMs / 1000)}s`;
	const first = `${result.stderr}\n${result.stdout}`
		.split("\n")
		.map((l) => l.trim())
		.find(Boolean);
	return `vault ${step}: failed (exit ${result.code ?? "none"})${first ? `: ${first.slice(0, 200)}` : ""}`;
}

/** `resolve` path and host, from `resolve --json` or its text output. */
export function parseResolve(stdout) {
	try {
		const parsed = JSON.parse(stdout);
		if (parsed && typeof parsed === "object") {
			return { path: typeof parsed.path === "string" ? parsed.path : undefined, host: typeof parsed.host === "string" ? parsed.host : undefined };
		}
	} catch {
		// Fall back to the text form.
	}
	const pathLine = /^path\s*:\s*(.+)$/m.exec(stdout);
	const hostLine = /^host\s*:\s*(.+)$/m.exec(stdout);
	return { path: pathLine?.[1]?.trim(), host: hostLine?.[1]?.trim() };
}
