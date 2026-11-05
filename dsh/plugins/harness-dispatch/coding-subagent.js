/**
 * An ad-hoc coding subagent tool for the orchestrator. Plan tasks already use
 * the dispatcher's worker runner; this tool is for work outside a plan: one
 * prompt, one child, a model/thinking level and an explicit tool allow-list.
 */
const DEFAULT_TOOLS = ["read", "write", "edit", "bash", "glob", "grep", "todo_write"];
export const CODING_TOOL_DENY = ["subagent", "subagent_fork", "subagent_claude_code", "workflow", "coding_subagent", "dispatch_status", "skill"];

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

/** Validate the requested allow-list; the child's own scope rejects unknown names. */
export function selectCodingTools(requested) {
	const wanted = Array.isArray(requested) && requested.length > 0 ? requested : DEFAULT_TOOLS;
	const clean = wanted.filter((name) => typeof name === "string" && name.trim() !== "");
	if (!clean.length) throw new Error("the tool allow-list is empty");
	const forbidden = clean.filter((name) => CODING_TOOL_DENY.includes(name));
	if (forbidden.length) throw new Error(`tool${forbidden.length > 1 ? "s" : ""} cannot be granted to a coding subagent: ${forbidden.join(", ")}`);
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
			let activation;
			try {
				activation = await ctx.subagents.startActivation({
					provider: "spawn",
					label: `coding: ${String(args.prompt).slice(0, 48)}`,
					request: {
						prompt: [{ type: "text", text: String(args.prompt) }],
						parent,
						cwd,
						agentOptions,
						maxDepth: 1,
					},
					signal: exec.signal,
					delivery: "caller",
				});
			} catch (e) {
				return { error: e instanceof Error ? e.message : String(e), text: "" };
			}
			const childId = activation.childId ?? activation.subagentId;
			const child = ctx.agents?.get?.(childId);
			if (child?.ctx) {
				try {
					await child.ctx.tools.restrict({ allow });
				} catch (e) {
					ctx.logger?.warn?.(`coding_subagent: could not restrict ${childId}: ${e instanceof Error ? e.message : String(e)}`);
				}
			}
			let result;
			try {
				result = await activation.result;
			} catch (e) {
				return { error: e instanceof Error ? e.message : String(e), text: "", childId };
			}
			return {
				childId,
				model,
				stopReason: result?.stopReason ?? "",
				text: textOfContent(result?.output).trim(),
			};
		},
	};
}
