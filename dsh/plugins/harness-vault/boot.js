/**
 * Session start: resolve, repo check, sync pull, boot. Every step has a 20 s
 * timeout and a failure becomes one plain line; nothing blocks the session.
 */
import * as fs from "node:fs";
import { failureLine, parseResolve } from "./vault-cli.js";

export const BOOT_TIMEOUT_MS = 20_000;

export async function loadVaultBoot({ cli, root, repo, log, timeoutMs = BOOT_TIMEOUT_MS } = {}) {
	const lines = [];
	let vault;
	let host;
	// `vault.mjs repo check` ignores `--root` entirely and derives the repo slug
	// from its own working directory, so the spawn cwd is the only thing that
	// decides full versus none. Without this every session inherits the host
	// process cwd and a real repository is reported as "mode none".
	const spawnOpts = { timeoutMs, ...(existingDir(root) ? { cwd: root } : {}) };
	const record = (result) => {
		const text = result.stdout.trim();
		if (text) lines.push(text);
	};
	try {
		const resolved = await cli.run(["resolve", "--json"], spawnOpts);
		if (resolved.code !== 0) {
			return { mode: "unknown", text: section([failureLine("resolve", resolved)]), lines };
		}
		const parsed = parseResolve(resolved.stdout);
		vault = parsed.path;
		host = parsed.host;
	} catch (e) {
		return { mode: "unknown", text: section([`vault resolve: ${e instanceof Error ? e.message : String(e)}`]), lines };
	}

	const check = await cli.run(["repo", "check"], spawnOpts);
	if (check.code === 3) {
		return { mode: "none", vault, host, text: section(["vault: this repo's mode is none; skip every vault step."]), lines };
	}
	if (check.code !== 0) return { mode: "unknown", vault, host, text: section([failureLine("repo check", check)]), lines };
	record(check);

	for (const step of ["sync pull", "boot"]) {
		const args = step.split(" ");
		if (repo) args.push("--repo", repo);
		const result = await cli.run(args, spawnOpts);
		if (result.code !== 0) {
			lines.push(failureLine(step, result));
			log?.(failureLine(step, result));
			continue;
		}
		record(result);
	}
	return { mode: "full", vault, host, text: section(lines), lines };
}

function section(lines) {
	return ["## Agent vault (agent-vault)", "Write only through vault.mjs; workers never get vault access.", ...lines].join("\n");
}

/** A directory that has since been deleted must not break the spawn. */
function existingDir(dir) {
	if (!dir) return false;
	try {
		return fs.statSync(dir).isDirectory();
	} catch {
		return false;
	}
}
