/**
 * Session start: resolve, repo check, sync pull, boot. Every step has a 20 s
 * timeout and a failure becomes one plain line; nothing blocks the session.
 */
import { failureLine, parseResolve } from "./vault-cli.js";

export const BOOT_TIMEOUT_MS = 20_000;

export async function loadVaultBoot({ cli, root, repo, log, timeoutMs = BOOT_TIMEOUT_MS } = {}) {
	const lines = [];
	let vault;
	let host;
	const record = (result) => {
		const text = result.stdout.trim();
		if (text) lines.push(text);
	};
	try {
		const resolved = await cli.run(["resolve", "--json"], { timeoutMs });
		if (resolved.code !== 0) {
			return { mode: "unknown", text: section([failureLine("resolve", resolved)]), lines };
		}
		const parsed = parseResolve(resolved.stdout);
		vault = parsed.path;
		host = parsed.host;
	} catch (e) {
		return { mode: "unknown", text: section([`vault resolve: ${e instanceof Error ? e.message : String(e)}`]), lines };
	}

	const checkArgs = ["repo", "check"];
	if (root) checkArgs.push("--root", root);
	const check = await cli.run(checkArgs, { timeoutMs });
	if (check.code === 3) {
		return { mode: "none", vault, host, text: section(["vault: this repo's mode is none; skip every vault step."]), lines };
	}
	if (check.code !== 0) return { mode: "unknown", vault, host, text: section([failureLine("repo check", check)]), lines };
	record(check);

	for (const step of ["sync pull", "boot"]) {
		const args = step.split(" ");
		if (root) args.push("--root", root);
		if (repo) args.push("--repo", repo);
		const result = await cli.run(args, { timeoutMs });
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
