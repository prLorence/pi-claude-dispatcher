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
	const root = config.root || ctx.workingDirectory?.defaultDirectory || process.cwd();
	const skillRoot = config.skillRoot || defaultSkillRoot(os.homedir());
	const cli = createVaultCli({ skillRoot, timeoutMs: config.timeoutMs ?? 20_000 });
	let bootText = "";
	let mode = "unknown";

	const traceMjs = path.join(skillRoot, "trace.mjs");
	const runReport = async (trace) => {
		if (!fs.existsSync(traceMjs)) return { code: 0, skipped: true };
		return runNode(traceMjs, ["report", "--trace", String(trace ?? "")], root, 60_000);
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

	const disposeTools = registerVaultTools(ctx, { cli, root, runReport, isOrchestrator });

	ctx.systemPrompt.section({
		name: "harness-vault",
		order: 950,
		text: () => bootText,
	});

	if (config.injectVaultBoot !== false) {
		void loadVaultBoot({ cli, root, log: (m) => ctx.logger?.info?.(m) })
			.then((result) => {
				mode = result.mode;
				bootText = result.text;
				ctx.logger?.info?.(`harness-vault: mode ${mode}`);
			})
			.catch((e) => {
				bootText = `## Agent vault (agent-vault)\nvault boot: ${e instanceof Error ? e.message : String(e)}`;
			});
	}

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
