/**
 * harness-omp-subagent: an out-of-process subagent provider that runs each
 * child as an oh-my-pi (`omp`) process instead of an in-process Agent.
 *
 * DSH ships two in-process backends (`spawn`, `fork`); both build a child Agent
 * on the same cordis context. This one is the seam for a child that lives in
 * another process entirely: it registers a provider on `ctx.subagents`, spawns
 * `omp --mode json`, folds the JSON event stream into one result, and publishes
 * the standard run handle `{ id, result, dispose }`.
 *
 * Nothing here writes to the parent's session. The child's text reaches the
 * model through the delegated prompt and the returned result, exactly like the
 * built-in backends.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

export const name = "harness-omp-subagent";
export const inject = ["subagents"];

const DEFAULT_PROVIDER = "omp";
const DEFAULT_MODEL = "opencode-go/beam-free";

/**
 * Absolute path to the guard adapter that ships beside this file.
 *
 * Resolved from import.meta.url rather than configured, so it follows the
 * plugin wherever it is installed (the profile symlinks into the repo) and a
 * deployment cannot point at a stale copy.
 */
export const GUARD_HOOK_PATH = fileURLToPath(new URL("./omp-guard-hook.js", import.meta.url));
const DEFAULT_TIMEOUT_MS = 600_000;

/** The read-only tool set a reviewer child may use. */
const READONLY_TOOLS = ["read", "grep", "glob"];

/**
 * Terminate a child, tolerating one that never started. `kill()` on a handle
 * whose spawn has not settled yet (pid undefined, exitCode null) blocks the
 * event loop instead of returning false, so the pid check is load-bearing.
 */
function terminate(child) {
	if (!child || child.pid === undefined || child.exitCode !== null) return;
	try {
		child.kill("SIGTERM");
	} catch {
		// The process already exited.
	}
}

/**
 * Flatten the request's ContentBlock[] into the single string omp's `-p` takes.
 *
 * The contract passes blocks, not a string; String() on an array of objects
 * yields "[object Object]". Only text is meaningful to a one-shot CLI child:
 * images and files cannot be attached to `-p`, so they are dropped rather than
 * silently stringified into the prompt.
 */
export function promptText(prompt) {
	if (typeof prompt === "string") return prompt;
	if (!Array.isArray(prompt)) return "";
	return prompt
		.filter((block) => block && block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

/**
 * omp has no `--session-id`, so the child id is minted here. It must look like a
 * SessionId to the runtime; a UUID is accepted and is what omp itself prints.
 */
function childId() {
	return randomUUID();
}

export function ompArgs({ model, thinking, prompt, tools, readonly, guardHook }) {
	const args = ["--mode", "json", "-p", "--no-session", "--model", model];
	if (thinking) args.push("--thinking", thinking);
	// Loaded before --tools so a reviewer's restricted set and the guard agree.
	if (guardHook) args.push("--hook", guardHook);
	const list = readonly ? READONLY_TOOLS : Array.isArray(tools) ? tools : [];
	if (list.length > 0) args.push("--tools", list.join(","));
	args.push(prompt);
	return args;
}

/**
 * Fold one JSON line of omp output into accumulated state. omp is a Pi fork and
 * emits `message_end` with the finished assistant message, plus tool events.
 * Exported for the tests: parsing is the part worth pinning down.
 */
export function foldOmpLine(state, line) {
	if (!line.trim()) return state;
	let event;
	try {
		event = JSON.parse(line);
	} catch {
		// A partial write at the tail of the stream is not an event.
		return state;
	}
	const type = event?.type;
	// `message_end` and `turn_end` both carry the finished assistant message, so
	// folding both would duplicate the text. Only `message_end` contributes text;
	// `turn_end` is used solely for usage, which it repeats.
	if (type === "message_end") {
		const message = event.message;
		if (message?.role === "assistant" && Array.isArray(message.content)) {
			const text = message.content
				.filter((part) => part?.type === "text" && typeof part.text === "string")
				.map((part) => part.text)
				.join("");
			if (text) state.text = state.text ? `${state.text}\n${text}` : text;
		}
		if (message?.usage && typeof message.usage === "object") state.usage = message.usage;
	}
	if (type === "turn_end") {
		const usage = event.message?.usage;
		if (usage && typeof usage === "object") state.usage = usage;
	}
	if (type === "tool_execution_start" && event.toolName) {
		state.tools.push(String(event.toolName));
	}
	if (type === "error" || type === "agent_end_error") {
		const detail = event.message ?? event.error;
		if (detail) state.errors.push(typeof detail === "string" ? detail : JSON.stringify(detail));
	}
	return state;
}

/**
 * Resolve the single `provider/model` id omp's `--model` takes.
 *
 * The seam splits a route into `agentOptions.provider` and `.model`, but omp
 * wants them joined. Handing it a bare model id makes omp fall back to its
 * default provider, which for an unconfigured profile is openrouter — the run
 * then dies on a missing API key instead of routing where the caller asked.
 */
export function resolveOmpModel(agentOptions, fallback) {
	const provider = agentOptions?.provider;
	const model = agentOptions?.model;
	if (typeof model === "string" && model.includes("/")) return model;
	if (provider && model) return `${provider}/${model}`;
	return model || fallback;
}

export function createOmpProvider(options = {}) {
	const providerName = options.providerName || DEFAULT_PROVIDER;
	const command = options.command || "omp";
	const defaultModel = options.model || DEFAULT_MODEL;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const log = options.log;

	const provider = {
		name: providerName,
		// agentOptions is honest: start() reads request.agentOptions.model and
		// .reasoningEffort per run, so a caller may route each child to a
		// different model without reconfiguring the provider. The rest are not
		// advertised: an external child cannot receive follow-up input, omp has
		// no preset selection, and depth is the provider's own business (a
		// one-shot `-p` child cannot delegate again).
		capabilities: { agentOptions: true, agentPreset: false, outputSchema: false, depthLimit: false },
		inheritsParentContext: false,

		async start(request) {
			const id = childId();
			const prompt = promptText(request?.prompt);
			const cwd = request?.cwd || process.cwd();
			const signal = request?.signal;
			// Rejoined here: the seam splits the route, omp wants it whole.
			const model = resolveOmpModel(request?.agentOptions, defaultModel);
			const thinking = request?.agentOptions?.reasoningEffort ?? request?.agentOptions?.thinking;
			// The dispatcher routes each task to a different role, so the tool set
			// and its read-only-ness have to be per run, not per provider. These
			// ride the request object, which the runtime spreads through to `start`
			// unchanged; an absent value falls back to the configured default.
			const tools = request?.tools ?? options.tools;
			const readonly = request?.readonly ?? options.readonly;
			const runTimeoutMs = Number.isFinite(request?.timeoutMs) ? request.timeoutMs : timeoutMs;
			// A guard policy can only be applied inside the child, and only a hook
			// loaded there can apply it. The policy arrives per run rather than on
			// the parent's environment: two concurrent workers have different
			// policies, and mutating process.env would make them race.
			const guard = request?.guard;
			const guardHook = guard ? (options.guardHook ?? GUARD_HOOK_PATH) : undefined;
			const args = ompArgs({ model, thinking, prompt, tools, readonly, guardHook });

			const state = { text: "", usage: undefined, tools: [], errors: [] };
			// The dispatcher's stall detector needs a liveness signal, and the
			// managed path exposes no event stream for an external child. Calling
			// this on every folded line restores what runCli got from its own
			// stdout reader.
			const onProgress = request?.onProgress;
			let child;
			let settled = false;
			let timer;
			// Hoisted so dispose() can settle the result: a caller that tears a run
			// down must not be left awaiting a promise nothing will ever resolve.
			let finishRun;
			// Tracked so settling removes it. The signal outlives the run, and a
			// listener left behind would keep this closure (and the child handle)
			// alive for every run that ever shared that signal.
			let onAbort;

			const result = new Promise((resolve) => {
				const finish = (stopReason, diagnostic) => {
					if (settled) return;
					settled = true;
					if (timer) clearTimeout(timer);
					if (onAbort) signal?.removeEventListener("abort", onAbort);
					const output = state.text ? [{ type: "text", text: state.text }] : [];
					const note = diagnostic || (state.errors.length > 0 ? state.errors.join("\n") : undefined);
					// The seam spreads an unknown result through unchanged, so the
					// dispatcher can read accounting a bare output block would drop.
					// Normalised here because omp reports input/output/totalTokens
					// and the runtime's ToolUsage-ish shape is input/output/total.
					const u = state.usage ?? {};
					const input = Number(u.input ?? 0) || 0;
					const outputTokens = Number(u.output ?? 0) || 0;
					const usage = {
						input,
						output: outputTokens,
						total: Number(u.totalTokens ?? u.total ?? input + outputTokens) || 0,
						cost: Number(u.cost?.total ?? 0) || 0,
					};
					resolve({
						output,
						stopReason,
						usage,
						tools: [...state.tools],
						...(note ? { diagnostic: note.slice(0, 4096) } : {}),
					});
				};
				finishRun = finish;

				try {
					// The policy rides this child's own environment, so concurrent
					// workers with different policies cannot see each other's.
					const env = { ...process.env };
					if (guard) env.PI_PLAN_DISPATCH_GUARD = JSON.stringify(guard);
					else delete env.PI_PLAN_DISPATCH_GUARD;
					child = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], env });
				} catch (error) {
					finish("error", `omp spawn failed: ${error instanceof Error ? error.message : String(error)}`);
					return;
				}

				let buffer = "";
				let stderr = "";
				child.stdout.setEncoding("utf8");
				child.stdout.on("data", (chunk) => {
					buffer += chunk;
					let index = buffer.indexOf("\n");
					while (index !== -1) {
						foldOmpLine(state, buffer.slice(0, index));
						buffer = buffer.slice(index + 1);
						index = buffer.indexOf("\n");
					}
					// Any output is evidence the child is alive, which is all the
					// stall detector asks. A throwing callback must not tear down
					// the run, so it is isolated.
					try {
						onProgress?.();
					} catch {
						// The observer's failure is not the child's.
					}
				});
				child.stderr.setEncoding("utf8");
				child.stderr.on("data", (chunk) => {
					stderr += chunk;
				});
				child.on("error", (error) => {
					finish("error", `omp failed to start: ${error instanceof Error ? error.message : String(error)}`);
				});
				child.on("close", (code) => {
					if (buffer.trim()) foldOmpLine(state, buffer);
					if (signal?.aborted) return finish("aborted");
					if (code === 0) return finish("completed");
					finish("error", `omp exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
				});

				timer = setTimeout(() => {
					terminate(child);
					finish("error", `omp timed out after ${runTimeoutMs} ms`);
				}, runTimeoutMs);
				timer.unref?.();

				if (signal) {
					onAbort = () => {
						terminate(child);
						finish("aborted");
					};
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}

				log?.(`harness-omp-subagent: started ${id} (${model}) in ${cwd}`);
			});

			return {
				id,
				result,
				async dispose() {
					terminate(child);
					// The runtime awaits this teardown, so the run must be settled even
					// when the child never produced any output.
					finishRun?.("aborted");
				},
			};
		},
	};
	return provider;
}

export async function apply(ctx, config = {}) {
	const provider = createOmpProvider({
		providerName: config.providerName,
		command: config.command,
		model: config.model,
		timeoutMs: config.timeoutMs,
		tools: config.tools,
		readonly: config.readonly === true,
		log: (m) => ctx.logger?.info?.(m),
	});
	return ctx.subagents.registerProvider(provider);
}

export default { name, inject, apply };
