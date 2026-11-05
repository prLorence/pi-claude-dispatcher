/**
 * Worker runners.
 *
 * `dsh` (default): start one in-process dsh subagent per task through the
 * built-in subagent service, apply the task's scoped guard and tool restriction,
 * and observe its session events for tool calls and usage.
 *
 * `pi`: spawn `pi --mode json -p` exactly like the old adapter.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAdapter } from "./adapters/index.js";
import { BLOCKED_MARKER, GUARD_ENV, checkToolCall } from "./guard.js";
import { StallTracker } from "./resilience.js";
import { costOf } from "./config.js";
import { resolveAgent, resolveModel } from "./roles.js";

const DELEGATION_TOOLS = [
	"subagent",
	"subagent_fork",
	"subagent_claude_code",
	"workflow",
	"send_message",
	"interrupt_agent",
	"list_agents",
	"job_kill",
	"job_list",
	"job_output",
	"dispatch_status",
	"dispatch_project",
	"coding_subagent",
	"audit_plan",
	"skill",
];
const VAULT_TOOLS = [
	"vault_search",
	"vault_note",
	"vault_work",
	"vault_log",
	"vault_sync",
	"vault_restore",
	"vault_config",
	"vault_record_run",
];

function textOfContent(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((p) => p && typeof p === "object" && p.type === "text" && typeof p.text === "string")
		.map((p) => p.text)
		.join("\n");
}

export function splitModel(model) {
	const at = model.indexOf("/");
	if (at === -1) return { provider: undefined, model };
	return { provider: model.slice(0, at), model: model.slice(at + 1) };
}

/** Wait for the process root Agent a subagent must name as its parent. */
async function waitForRootAgent(ctx, timeoutMs = 10_000) {
	const roots = ctx.agents?.roots?.() ?? [];
	if (roots.length > 0) return roots[0];
	return new Promise((resolve) => {
		let done = false;
		const finish = (agent) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			dispose?.();
			resolve(agent);
		};
		const dispose = ctx.on("agent/created", (payload) => {
			finish(payload?.agent);
		});
		const timer = setTimeout(() => finish(undefined), timeoutMs);
		if (timer.unref) timer.unref();
	});
}

/**
 * Build the `runWorker` seam for queue.js.
 * `active` is a Map<sessionId, {taskId, policy, records, blocked}> shared with
 * the plugin's global guard.
 */
export function createWorkerRunner({ ctx, root, cfgOf, active, log }) {
	const runner = async (opts) => {
		const { cfg, plan, task } = opts;
		const role = task.role || "implement";
		const agent = resolveAgent(cfg, role);
		const resolved = resolveModel(cfg, plan, task);
		const thinking = opts.thinking !== undefined ? opts.thinking : resolved.thinking;
		// omp runs through the managed subagent seam when its provider is
		// registered, so the dispatcher gets the same admission, parent
		// ownership, cancellation and tracking as every other child. The direct
		// CLI path stays as the fallback for a profile without the provider.
		if (agent === "omp" && ctx.subagents?.getProvider?.("omp") !== undefined) {
			return runManaged("omp", opts, cfg, resolved, thinking);
		}
		if (agent === "pi" || agent === "omp") return runCli(agent, opts, cfg, resolved, thinking);
		if (agent !== "dsh") return { ok: false, cost: 0, output: "", error: `unknown agent "${agent}" for role "${role}"` };
		return runManaged("spawn", opts, cfg, resolved, thinking);
	};

	const runManaged = async (provider, opts, cfg, resolved, thinking) => {
		const { plan, task, prompt, signal, onLine } = opts;
		if (!ctx.subagents) return { ok: false, cost: 0, output: "", error: "the dsh subagent service is not mounted (ctx.subagents missing)" };
		const parent = opts.parent ?? (await waitForRootAgent(ctx));
		if (!parent) return { ok: false, cost: 0, output: "", error: "no root dsh agent is available to parent a worker" };
		const route = splitModel(resolved.model);
		const agentOptions = {
			...route.provider ? { provider: route.provider } : {},
			model: route.model,
			...(thinking ? { reasoningEffort: thinking } : {}),
		};
		const readonly = resolveRoleReadonly(cfg, task.role);
		const policy = { cwd: opts.cwd, files: task.files, bash: true, readonly };
		// An external provider applies its guard inside the child process from
		// this value; an in-process child ignores it and gets a scoped
		// ctx.tools.guard below instead.
		const guard = cfg.workerGuards ? { files: task.files, bash: true, readonly } : undefined;
		// A managed child reports liveness through this callback rather than a
		// readable stdout; runManaged below feeds it into the stall tracker.
		const tracker = new StallTracker({ stallMs: cfg.stallMinutes * 60_000 });
		// The seam rejects a request whose maxDepth is set on a provider without
		// the depthLimit capability, and omp does not advertise it. Sending 1
		// there would fail every omp task, so ask only for what is supported:
		// an external one-shot child cannot delegate again anyway.
		const depthCapable = ctx.subagents.getProvider?.(provider)?.capabilities?.depthLimit !== false;
		let activation;
		try {
			activation = await ctx.subagents.startActivation({
				provider,
				label: `${plan.id}/${task.id}`,
				request: {
					prompt: [{ type: "text", text: prompt }],
					parent,
					cwd: opts.cwd,
					agentOptions,
					...(depthCapable ? { maxDepth: 1 } : {}),
					// Read by the omp provider; ignored by in-process backends,
					// which get their per-run policy from the child ctx instead.
					tools: cfg.tools,
					readonly,
					guard,
					timeoutMs: cfg.timeoutMinutes * 60_000,
					onProgress: () => tracker.touch(),
				},
				signal,
				delivery: "caller",
			});
		} catch (e) {
			return { ok: false, cost: 0, output: "", error: `could not start a ${provider} subagent: ${e instanceof Error ? e.message : String(e)}` };
		}

		const childId = activation.childId ?? activation.subagentId;
		const entry = { taskId: task.id, policy, records: [], blocked: 0, text: "", usage: { input: 0, output: 0, total: 0 }, stopReason: "", error: "" };
		active.set(childId, entry);
		const child = ctx.agents?.get?.(childId);
		if (child?.ctx) {
			try {
				child.ctx.tools.guard((exec) => {
					const d = checkToolCall(policy, exec.name, exec.arguments);
					if (d.block) entry.blocked++;
					return d.reason;
				});
			} catch (e) {
				log?.(`dispatch: could not scope the worker guard to ${childId}: ${e instanceof Error ? e.message : String(e)}`);
			}
			try {
				const deny = [...DELEGATION_TOOLS, ...VAULT_TOOLS].filter((n) => ctx.tools.get(n) !== undefined);
				if (deny.length > 0) await child.ctx.tools.restrict({ deny });
			} catch (e) {
				log?.(`dispatch: could not restrict ${childId}: ${e instanceof Error ? e.message : String(e)}`);
			}
		}

		const toolById = new Map();
		const onSessionEvent = (event) => {
			tracker.touch();
			const data = event.data ?? event;
			if (event.type === "tool/call") {
				let args = data.arguments;
				if (typeof args === "string") {
					try {
						args = JSON.parse(args);
					} catch {
						args = {};
					}
				}
				const rec = {
					name: data.name,
					path: args?.file_path ?? args?.path,
					detail: typeof args?.command === "string" ? args.command.slice(0, 160) : undefined,
				};
				entry.records.push(rec);
				toolById.set(data.callId, rec);
				tracker.toolStart(data.callId);
			} else if (event.type === "tool/result") {
				const msg = data.message ?? {};
				const id = msg.callId ?? msg.toolCallId;
				const rec = toolById.get(id);
				tracker.toolEnd(id);
				if (rec) {
					rec.isError = msg.isError === true;
					const text = textOfContent(msg.content);
					rec.result = text.slice(0, 300);
					if (rec.isError && text.includes(BLOCKED_MARKER)) rec.blocked = true;
				}
			} else if (event.type === "assistant/message") {
				const text = textOfContent(data.message?.content);
				if (text) {
					entry.text = text;
					onLine?.(text.split("\n")[0].slice(0, 120));
				}
				const usage = data.usage ?? {};
				entry.usage.input += Number(usage.input ?? usage.inputTokens ?? 0) || 0;
				entry.usage.output += Number(usage.output ?? usage.outputTokens ?? 0) || 0;
				entry.usage.total += Number(usage.total ?? usage.totalTokens ?? 0) || 0;
			} else if (event.type === "turn/end") {
				entry.stopReason = String(data.reason?.kind ?? "");
				if (data.reason?.error?.message) entry.error = String(data.reason.error.message);
			}
		};
		const off = ctx.on("session/event", (session, event) => {
			if (session?.id !== childId) return;
			onSessionEvent(event);
		});
		let stallTimer;
		if (cfg.stallMinutes > 0) {
			const every = Math.min(10_000, Math.max(100, (cfg.stallMinutes * 60_000) / 4));
			stallTimer = setInterval(() => {
				if (!entry.stallKilled && tracker.stalled()) {
					entry.stallKilled = true;
					entry.error = `stalled: no output for ${cfg.stallMinutes} min`;
					try {
						activation.dispose?.();
					} catch {}
				}
			}, every);
			if (stallTimer.unref) stallTimer.unref();
		}

		let result;
		try {
			result = await activation.result;
		} catch (e) {
			entry.error = entry.error || (e instanceof Error ? e.message : String(e));
		} finally {
			off?.();
			if (stallTimer) clearInterval(stallTimer);
			active.delete(childId);
		}
		const output = (entry.text || textOfContent(result?.output)).trim();
		// An in-process child reports usage through session events; an external
		// one (omp) emits none, so its provider returns accounting on the result.
		// Merge only what the event stream did not already supply.
		const usage = result?.usage;
		if (usage && entry.usage.total === 0) {
			entry.usage.input = Number(usage.input ?? 0) || 0;
			entry.usage.output = Number(usage.output ?? 0) || 0;
			entry.usage.total = Number(usage.total ?? 0) || 0;
		}
		if (entry.stopReason === "" && result?.stopReason) entry.stopReason = String(result.stopReason);
		if (!entry.error && result?.diagnostic) entry.error = String(result.diagnostic);
		// An external child's tool calls arrive as names only; the process
		// boundary carries no argument objects to record paths from.
		if (entry.records.length === 0 && Array.isArray(result?.tools)) {
			for (const name of result.tools) entry.records.push({ name: String(name) });
		}
		const reportedCost = Number(usage?.cost ?? 0) || 0;
		const cost = costOf(cfg, resolved.model, entry.usage.input, entry.usage.output) ?? reportedCost;
		const failed = !output || entry.stopReason === "error" || entry.stopReason === "aborted" || Boolean(entry.error);
		return {
			ok: !failed,
			output,
			cost,
			error: failed ? entry.error || entry.stopReason || "worker produced no reply" : undefined,
			model: resolved.model,
			thinking,
			stopReason: entry.stopReason,
			tokens: { ...entry.usage },
			tools: entry.records,
			session: { id: childId, dir: path.join(opts.cwd, ".plans", "sessions", plan.id), file: undefined, resume: "" },
		};
	};

	const runCli = async (agentName, opts, cfg, resolved, thinking) => {
		const { plan, task, prompt, signal, onLine } = opts;
		const adapter = getAdapter(agentName);
		const session = agentName !== "omp" && cfg.persistSessions && !cfg.dryRun
			? adapter.sessionFor({ cwd: opts.cwd, planId: plan.id, taskId: task.id, attempt: task.attempts })
			: undefined;
		if (session) adapter.retireSession?.(session);
		const readonly = resolveRoleReadonly(cfg, task.role);
		const args = adapter.workerArgs({ model: resolved.model, thinking, tools: cfg.tools, prompt, session, readonly, name: `${plan.id}/${task.id}` });
		const env = { ...process.env, PI_PLAN_DISPATCH_WORKER: "1" };
		delete env.AGENT_VAULT;
		delete env.OPENROUTER_API_KEY;
		if (cfg.workerGuards) env[GUARD_ENV] = JSON.stringify({ files: task.files, bash: true, readonly });
		else delete env[GUARD_ENV];
		const state = { text: "", cost: 0, tokens: { input: 0, output: 0, total: 0 }, stopReason: "", error: "", tools: [], plain: "" };
		const toolById = new Map();
		const tracker = new StallTracker({ stallMs: cfg.stallMinutes * 60_000 });
		const handle = (line) => {
			for (const ev of adapter.parseLine(line)) {
				tracker.touch();
				if (ev.kind === "tool_start") {
					const rec = { name: ev.name, path: ev.args?.path ?? ev.args?.file_path, detail: typeof ev.args?.command === "string" ? ev.args.command.slice(0, 160) : undefined };
					state.tools.push(rec);
					toolById.set(ev.id, rec);
					tracker.toolStart(ev.id);
				} else if (ev.kind === "tool_end") {
					tracker.toolEnd(ev.id);
					const rec = toolById.get(ev.id);
					if (rec) {
						rec.isError = ev.isError;
						rec.result = ev.text.slice(0, 300);
						if (ev.isError && ev.text.startsWith(BLOCKED_MARKER)) rec.blocked = true;
					}
				} else if (ev.kind === "assistant_end") {
					if (ev.text) {
						state.text = ev.text;
						onLine?.(ev.text.split("\n")[0].slice(0, 120));
					}
					state.cost += ev.usage.cost;
					state.tokens.input += ev.usage.input;
					state.tokens.output += ev.usage.output;
					state.tokens.total += ev.usage.total;
					if (ev.stopReason) state.stopReason = ev.stopReason;
					if (ev.errorMessage) state.error = ev.errorMessage;
				} else if (ev.kind === "plain") state.plain += `${ev.text}\n`;
			}
		};
		return new Promise((resolve) => {
			const proc = spawn(adapter.command(cfg), args, { cwd: opts.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], env });
			let buffer = "";
			let stderr = "";
			let settled = false;
			let killReason = "";
			const finish = (result) => {
				if (settled) return;
				settled = true;
				resolve(result);
			};
			const kill = (why) => {
				killReason = killReason || why;
				state.error = why;
				proc.kill("SIGTERM");
				setTimeout(() => proc.kill("SIGKILL"), 5000).unref?.();
			};
			const timeout = setTimeout(() => kill(`timed out after ${cfg.timeoutMinutes} min`), cfg.timeoutMinutes * 60_000);
			signal.addEventListener("abort", () => kill("aborted"), { once: true });
			const stallEvery = cfg.stallMinutes > 0 ? Math.min(10_000, Math.max(100, (cfg.stallMinutes * 60_000) / 4)) : 0;
			const stallTimer = stallEvery
				? setInterval(() => {
						if (tracker.stalled() && !settled) kill(`stalled: no output for ${cfg.stallMinutes} min`);
					}, stallEvery)
				: undefined;
			if (stallTimer?.unref) stallTimer.unref();
			proc.stdout.on("data", (d) => {
				buffer += d.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const l of lines) handle(l);
			});
			proc.stderr.on("data", (d) => {
				stderr += d.toString();
				if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
			});
			proc.on("error", (e) =>
				finish({ ok: false, cost: state.cost, output: state.text, model: resolved.model, thinking, tokens: state.tokens, tools: state.tools, error: `could not start '${adapter.command(cfg)}': ${e.message}`, session }),
			);
			proc.on("close", (code) => {
				clearTimeout(timeout);
				if (stallTimer) clearInterval(stallTimer);
				if (buffer.trim()) handle(buffer);
				const selfFailed = /^STATUS:\s*failed/im.test(state.text);
				const failed = code !== 0 || state.stopReason === "error" || state.stopReason === "aborted" || Boolean(state.error) || selfFailed || !state.text;
				const why = killReason || state.error || (selfFailed ? "worker reported STATUS: failed" : "") || stderr.trim().slice(-2000) || (!state.text ? "worker produced no reply" : `exit code ${code}`);
				if (session) session.file = adapter.findSessionFile?.(session);
				finish({
					ok: !failed,
					cost: state.cost,
					output: state.text,
					error: failed ? why : undefined,
					model: resolved.model,
					thinking,
					stopReason: state.stopReason,
					tokens: state.tokens,
					tools: state.tools,
					session,
				});
			});
		});
	};

	return runner;
}

function resolveRoleReadonly(cfg, roleName) {
	const role = cfg.roles?.[roleName || "implement"] ?? {};
	// The built-in defaults are merged by config; a readonly role is explicit.
	return role.readonly === true;
}
