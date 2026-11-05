/**
 * harness-vault: a thin dsh wrapper over dispatch-plan/vault.mjs.
 *
 * It boots the vault text into the system prompt at session start and exposes
 * the orchestrator's vault tools. It never writes a vault file itself; the CLI
 * is the only write path and keeps its schema, privacy modes, lock and events.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadVaultBoot } from "./boot.js";
import { createVaultCli, defaultSkillRoot } from "./vault-cli.js";
import { registerVaultTools } from "./tools.js";

export const name = "harness-vault";
export const inject = ["tools", "systemPrompt", "agents", "workingDirectory"];

export async function apply(ctx, config = {}) {
	const defaultRoot = config.root || ctx.workingDirectory?.defaultDirectory || process.cwd();
	const skillRoot = config.skillRoot || defaultSkillRoot(os.homedir());
	const cli = createVaultCli({ skillRoot, timeoutMs: config.timeoutMs ?? 20_000 });
	// Boot text is per session directory, not per plugin load: two sessions in
	// different repositories must not share one repo's vault mode.
	const boots = new Map();
	let mode = "unknown";

	// A session with no directory mapping must not inherit the host process cwd:
	// that is the exact bug being fixed, and the host cwd is a deployment folder
	// rather than a repository. Returning undefined makes that session read as
	// "unknown" instead of asserting a wrong "none".
	const directoryOf = (agent) => {
		try {
			const session = agent?.session;
			if (session && ctx.workingDirectory?.get) {
				const dir = ctx.workingDirectory.get(session);
				if (dir) return dir;
			}
		} catch {
			// Fall through to the configured root.
		}
		return config.root || undefined;
	};

	const bootFor = (dir) => {
		let entry = boots.get(dir);
		if (!entry) {
			entry = { text: "", ready: false };
			boots.set(dir, entry);
			if (config.injectVaultBoot !== false) {
				void loadVaultBoot({ cli, root: dir, log: (m) => ctx.logger?.info?.(m) })
					.then((result) => {
						entry.text = result.text;
						entry.ready = true;
						mode = result.mode;
						ctx.logger?.info?.(`harness-vault: mode ${result.mode} for ${dir}`);
					})
					.catch((e) => {
						entry.ready = true;
						entry.text = `## Agent vault (agent-vault)\nvault boot: ${e instanceof Error ? e.message : String(e)}`;
					});
			}
		}
		return entry.text;
	};

	const traceMjs = path.join(skillRoot, "trace.mjs");
	const runReport = async (trace) => {
		if (!fs.existsSync(traceMjs)) return { code: 0, skipped: true };
		return runNode(traceMjs, ["report", "--trace", String(trace ?? "")], defaultRoot, 60_000);
	};

	const isOrchestrator = (agent) => {
		if (!agent) return true;
		const roots = ctx.agents?.roots?.() ?? [];
		if (roots.length === 0) return true;
		return roots.includes(agent);
	};

	// Orchestrator-only: a subagent never sees the vault tools.
	ctx.tools.guard((exec) => {
		if (!exec.name.startsWith("vault_") && exec.name !== "vault_record_run") return undefined;
		if (isOrchestrator(exec.agent)) return undefined;
		return "BLOCKED by harness-dispatch: vault tools are orchestrator-only; a worker has no vault access.";
	});

	const disposeTools = registerVaultTools(ctx, { cli, root: defaultRoot, runReport, isOrchestrator });

	ctx.systemPrompt.section({
		name: "harness-vault",
		order: 950,
		// A worker has no vault tools, so handing it the boot text only spends
		// context on instructions it cannot follow. Give it the one rule instead,
		// mirroring how harness-projects tailors its section for workers.
		text: (context) => {
			const agent = context?.agent;
			if (agent && !isOrchestrator(agent)) {
				return "## Agent vault (agent-vault)\nWorkers never read the agent vault; use the task prompt and the repository itself.";
			}
			const dir = directoryOf(agent);
			return dir ? bootFor(dir) : "";
		},
	});

	return () => {
		disposeTools?.();
	};
}

function runNode(script, args, cwd, timeoutMs) {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		const proc = spawn(process.execPath, [script, ...args], { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
		const finish = (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		};
		const timer = setTimeout(() => {
			proc.kill("SIGTERM");
			finish(null);
		}, timeoutMs);
		if (timer.unref) timer.unref();
		proc.stdout.on("data", (d) => (stdout += d.toString()));
		proc.stderr.on("data", (d) => (stderr += d.toString()));
		proc.on("error", (e) => {
			stderr += e.message;
			finish(null);
		});
		proc.on("close", (code) => finish(code));
	});
}

export default { name, inject, apply };
