/**
 * An ad-hoc coding subagent tool for the orchestrator. Plan tasks already use
 * the dispatcher's worker runner; this tool is for work outside a plan: one
 * prompt, one child, a model/thinking level and an explicit tool allow-list.
 */

/**
 * The only tools a coding child may be granted.
 *
 * This is an allow list, not a deny list, and that is the point. The previous
 * deny list enumerated the delegation tools that existed when it was written,
 * so every delegation tool added afterwards passed by default — `subagent_omp`
 * did, the moment it was created. An allow list fails closed: a tool nobody
 * thought about is refused, not silently granted.
 *
 * Anything absent stays out. Delegation tools are absent because a coding child
 * must not spawn its own children; `skill` because it executes skill-provided
 * instructions the allow list never reviewed.
 */
export const CODING_TOOL_ALLOW = Object.freeze(["read", "write", "edit", "bash", "glob", "grep", "todo_write"]);

const DEFAULT_TOOLS = CODING_TOOL_ALLOW;

export function splitModel(model) {
	const at = String(model).indexOf("/");
	if (at === -1) return { provider: undefined, model: String(model) };
	return { provider: String(model).slice(0, at), model: String(model).slice(at + 1) };
}

export function buildCodingAgentOptions(cfg, args = {}) {
	const model = args.model || cfg.model;
	const route = splitModel(model);
	const thinking = args.thinking !== undefined ? args.thinking : cfg.thinking;
	return {
		model,
		thinking,
		agentOptions: {
			...route.provider ? { provider: route.provider } : {},
			model: route.model,
			...(thinking ? { reasoningEffort: thinking } : {}),
		},
	};
}

/**
 * Validate the requested allow-list against the tools a child may hold.
 *
 * Unknown names are refused rather than passed through: the child's own scope
 * would reject a name that does not exist, so forwarding it would surface as a
 * confusing restrict() failure halfway through the run instead of a clear
 * refusal at the call.
 */
export function selectCodingTools(requested) {
	const wanted = Array.isArray(requested) && requested.length > 0 ? requested : DEFAULT_TOOLS;
	const clean = wanted.filter((name) => typeof name === "string" && name.trim() !== "");
	if (!clean.length) throw new Error("the tool allow-list is empty");
	const refused = clean.filter((name) => !CODING_TOOL_ALLOW.includes(name));
	if (refused.length) {
		throw new Error(
			`tool${refused.length > 1 ? "s" : ""} cannot be granted to a coding subagent: ${refused.join(", ")} (allowed: ${CODING_TOOL_ALLOW.join(", ")})`,
		);
	}
	return clean;
}

function textOfContent(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((p) => p && typeof p === "object" && p.type === "text" && typeof p.text === "string")
		.map((p) => p.text)
		.join("\n");
}

export function createCodingSubagentTool({ ctx, cfgOf, root, rootFor }) {
	return {
		name: "coding_subagent",
		description:
			"Start one ad-hoc dsh coding subagent with a self-contained prompt, a model/thinking level and an explicit tool allow-list, then return its final report. Use it for work outside a .plans/ task; plan tasks are started by the dispatcher automatically.",
		parameters: {
			type: "object",
			properties: {
				prompt: { type: "string", description: "Complete, self-contained task prompt" },
				cwd: { type: "string", description: "Working directory; defaults to the session directory" },
				model: { type: "string", description: "provider/model override" },
				thinking: { type: "string", description: "Reasoning effort override; empty means none" },
				agent: { type: "string", description: "Subagent backend: `dsh` (in-process, the default) or `omp` (external process)" },
				timeoutMs: { type: "integer", description: "Wall-clock limit for the child; defaults to the dispatcher's codingTimeoutMinutes" },
				tools: { type: "array", items: { type: "string" }, description: "Tool allow-list; defaults to read/write/edit/bash/glob/grep/todo_write" },
			},
			required: ["prompt"],
			additionalProperties: false,
		},
		output: {
			schema: { type: "object", additionalProperties: true },
			render: (_args, value) => [{ type: "text", text: value.error ? `coding_subagent failed: ${value.error}` : value.text || "(no output)" }],
		},
		isConcurrencySafe: () => false,
		async execute(args, exec) {
			if (!args.prompt || !String(args.prompt).trim()) throw new Error("coding_subagent needs a non-empty prompt");
			const parent = exec.agent;
			if (!parent) throw new Error("coding_subagent requires a calling agent");
			const cwd = args.cwd || rootFor?.(exec?.agent) || root;
			const cfg = cfgOf(cwd);
			const { model, agentOptions } = buildCodingAgentOptions(cfg, args);
			const allow = selectCodingTools(args.tools);
			// `dsh` is the in-process default; `omp` runs the child as an external
			// process through the managed seam. An unknown or unregistered backend
			// is refused here rather than surfacing as a start failure.
			const agent = args.agent === undefined ? "dsh" : String(args.agent);
			const provider = agent === "dsh" ? "spawn" : agent;
			const known = ctx.subagents.getProvider?.(provider);
			if (agent !== "dsh" && known === undefined) {
				return { error: `no subagent provider named "${provider}" is registered`, text: "" };
			}
			// Only a provider that advertises depthLimit will accept maxDepth; the
			// seam throws otherwise. An external one-shot child cannot recurse, so
			// omitting it there loses nothing.
			const depthCapable = known?.capabilities?.depthLimit !== false;
			let activation;
			try {
				activation = await ctx.subagents.startActivation({
					provider,
					label: `coding: ${String(args.prompt).slice(0, 48)}`,
					request: {
						prompt: [{ type: "text", text: String(args.prompt) }],
						parent,
						cwd,
						agentOptions,
						...(depthCapable ? { maxDepth: 1 } : {}),
						// An external child can only honour the allow list through
						// this value (omp turns it into --tools); an in-process child
						// is restricted through its own ctx below.
						tools: allow,
						// An unresponsive external child would otherwise hold the
						// call open until the provider's multi-minute default.
						timeoutMs: args.timeoutMs ?? cfg.codingTimeoutMinutes * 60_000,
					},
					signal: exec.signal,
					delivery: "caller",
				});
			} catch (e) {
				return { error: e instanceof Error ? e.message : String(e), text: "" };
			}
			const childId = activation.childId ?? activation.subagentId;
			// For an in-process child the runtime built an Agent reachable here, so
			// the allow list is enforced by scoping its tools. An external child has
			// no entry in ctx.agents, which makes the same call a silent no-op — the
			// allow list is enforced there by --tools instead. Say which applies
			// rather than letting a reader assume this covers both.
			const child = ctx.agents?.get?.(childId);
			let enforcedBy = agent === "dsh" ? "tool-scope" : "cli-tools";
			if (child?.ctx) {
				try {
					await child.ctx.tools.restrict({ allow });
					enforcedBy = "tool-scope";
				} catch (e) {
					ctx.logger?.warn?.(`coding_subagent: could not restrict ${childId}: ${e instanceof Error ? e.message : String(e)}`);
					enforcedBy = "none";
				}
			}
			// An in-process child reports usage through its session; an external
			// one returns it on the result. Collect from the session here so both
			// backends report the same shape.
			const usage = { input: 0, output: 0, total: 0 };
			const off = child ? ctx.on("session/event", (session, event) => {
				if (session?.id !== childId) return;
				const data = event.data ?? event;
				if (event.type !== "assistant/message") return;
				const u = data.usage ?? {};
				usage.input += Number(u.input ?? u.inputTokens ?? 0) || 0;
				usage.output += Number(u.output ?? u.outputTokens ?? 0) || 0;
				usage.total += Number(u.total ?? u.totalTokens ?? 0) || 0;
			}) : undefined;
			let result;
			try {
				result = await activation.result;
			} catch (e) {
				return { error: e instanceof Error ? e.message : String(e), text: "", childId };
			} finally {
				off?.();
			}
			// Prefer what the provider returned (external backends normalise it
			// there); fall back to what the session reported for an in-process
			// child, which has no usage on its result.
			const reported = result?.usage;
			const finalUsage = reported
				? { input: Number(reported.input ?? 0) || 0, output: Number(reported.output ?? 0) || 0, total: Number(reported.total ?? 0) || 0 }
				: usage;
			return {
				childId,
				model,
				agent,
				// Which mechanism bounded the child's tools, so a reader (or the
				// model reading this result) is not left guessing.
				enforcedBy,
				stopReason: result?.stopReason ?? "",
				text: textOfContent(result?.output).trim(),
				usage: finalUsage,
				...(result?.diagnostic ? { diagnostic: String(result.diagnostic) } : {}),
			};
		},
	};
}
