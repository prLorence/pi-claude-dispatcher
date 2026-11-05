/** Role resolution, ported from core.ts. The decider config is read but not used. */

const REVIEW_PROMPT = [
	"You review another engineer's change for one task. You are read-only: inspect with the read tools and `git diff -- <files>`, and never edit anything.",
	"The checkout may contain unrelated uncommitted edits, so judge only the task's files and instructions.",
	"Look for wrong behaviour, missed requirements, unhandled edge cases, broken interfaces and invented APIs.",
	"Do not praise, and do not nitpick style. Reply in the review format: `VERDICT: approve | changes`, then `FINDINGS:` with `- <path>:<line>: <problem>. <fix>.` or `none`.",
].join("\n");


export const DEFAULT_ROLES = {
	implement: {
		prompt: [
			"You implement exactly one task, in the files you own.",
			"Read every file before you edit it, then change only what the task asks for, run the checks it names, and report what you actually did.",
			"Do not refactor nearby code, do not add features nobody asked for, and do not touch files outside your list.",
		].join("\n"),
	},
	review: {
		model: "opencode-go/minimax-m3.1-flash-free",
		thinking: "low",
		readonly: true,
		prompt: REVIEW_PROMPT,
	},
	"pair-omp": {
		agent: "omp",
		model: "opencode-go/beam-free",
		thinking: "low",
		readonly: true,
		prompt: REVIEW_PROMPT,
	},
	/**
	 * The omp coding role: the same implementer contract as `implement`, run by
	 * oh-my-pi instead of dsh. Pair it with `pair-omp` for an omp-only loop.
	 */
	"implement-omp": {
		agent: "omp",
		model: "opencode-go/beam-free",
		thinking: "low",
		prompt: [
			"You implement exactly one task, in the files you own.",
			"Read every file before you edit it, then change only what the task asks for, run the checks it names, and report what you actually did.",
			"Do not refactor nearby code, do not add features nobody asked for, and do not touch files outside your list.",
		].join("\n"),
	},
	/** A second omp reviewer on a different model, for an independent second opinion. */
	"pair-omp-contributor": {
		agent: "omp",
		model: "opencode-go/muse-spark-1.3-contributor",
		thinking: "low",
		readonly: true,
		prompt: REVIEW_PROMPT,
	},
	security: {
		model: "opencode-go/glm-5.3-flash",
		thinking: "high",
		readonly: true,
		prompt: [
			"You are a security reviewer, and you are read-only.",
			"Look for injection, unsafe deserialisation, path traversal, authn/authz gaps, secrets in code, unsafe shell use, missing input validation, SSRF and insecure defaults.",
			"Give every finding a severity, and say `clean` only if you actually read the files.",
			"Reply in the security format: `VERDICT: clean | issues`, then `FINDINGS:` with `- [high|medium|low] <path>:<line>: <problem>. <fix>.` or `none`.",
		].join("\n"),
	},
	qa: {
		model: "opencode-go/mimo-v2.6-flash",
		thinking: "",
		prompt: [
			"You write and run tests for the behaviour this task describes, in the files you own (test files unless the task says otherwise).",
			"Read the code under test first, cover the real behaviour and the edge cases, and put any bug you find under NEEDS prefixed `BUG:`.",
			"Do not change production code, and report the command output you actually saw.",
		].join("\n"),
	},
};

export const DEFAULT_PAIR_ROUNDS = 2;
export const DEFAULT_AGENT = "dsh";

function cloneRoles(roles) {
	return Object.fromEntries(Object.entries(roles).map(([name, role]) => [name, { ...role }]));
}

function roleFrom(value) {
	const o = value && typeof value === "object" && !Array.isArray(value) ? value : {};
	const role = {};
	if (typeof o.model === "string") role.model = o.model;
	if (typeof o.thinking === "string") role.thinking = o.thinking;
	if (typeof o.readonly === "boolean") role.readonly = o.readonly;
	if (typeof o.prompt === "string") role.prompt = o.prompt;
	if (typeof o.agent === "string" && o.agent.trim() !== "") role.agent = o.agent.trim();
	return role;
}

export function mergeRoles(over) {
	const merged = cloneRoles(DEFAULT_ROLES);
	const o = over && typeof over === "object" && !Array.isArray(over) ? over : {};
	for (const [name, value] of Object.entries(o)) merged[name] = { ...(merged[name] ?? {}), ...roleFrom(value) };
	return merged;
}

/** Every role name the config knows: the built-ins plus any the user added. */
export function knownRoles(cfg) {
	return [...new Set([...Object.keys(DEFAULT_ROLES), ...Object.keys(cfg?.roles ?? {})])];
}

export function resolveRole(cfg, name) {
	return { ...(DEFAULT_ROLES[name] ?? {}), ...(cfg?.roles?.[name] ?? {}) };
}

/**
 * The worker agent a role resolves to. `pi` and `dsh` are known; anything else
 * is refused at preflight with the same text as the Pi version.
 */
export function resolveAgent(cfg, roleName) {
	return resolveRole(cfg, roleName).agent || DEFAULT_AGENT;
}

export function knownAgents() {
	return ["dsh", "pi", "omp"];
}

export function agentProblem(cfg, roleName) {
	const agent = resolveAgent(cfg, roleName);
	if (knownAgents().includes(agent)) return undefined;
	return `role "${roleName}" names agent "${agent}", which is not available (known agents: ${knownAgents().join(", ")})`;
}

export function pairDefaultProblem(cfg) {
	const value = cfg.pairDefault;
	if (value === "") return undefined;
	if (value.toLowerCase() === "none") return `pairDefault cannot be "none"; none is the pair: opt-out word`;
	const names = knownRoles(cfg).join(", ");
	if (!knownRoles(cfg).includes(value)) return `pairDefault names unknown role "${value}" (known roles: ${names})`;
	if (!resolveRole(cfg, value).readonly) {
		return `pairDefault role "${value}" is not read-only; a pair reviewer must be a read-only role`;
	}
	return undefined;
}

export function applyPairDefault(plan, cfg) {
	const problem = cfg.pairDefault === "" ? undefined : pairDefaultProblem(cfg);
	for (const task of plan.tasks) {
		if (task.pairSource !== undefined) continue;
		if (task.pair) {
			task.pairSource = "task";
			continue;
		}
		if (cfg.pairDefault === "" || problem !== undefined) continue;
		const roleName = task.role || "implement";
		if (resolveRole(cfg, roleName).readonly === true) continue;
		task.pair = cfg.pairDefault;
		task.pairSource = "default";
		task.pairRounds = task.pairRounds ?? DEFAULT_PAIR_ROUNDS;
	}
}

/**
 * Pick the model, thinking level and role for a task, highest first: the
 * task's own lines, its role, the plan frontmatter, then the config defaults.
 */
export function resolveModel(cfg, plan, task) {
	const role = task.role || "implement";
	const rc = resolveRole(cfg, role);
	return {
		model: task.model || rc.model || plan.model || cfg.model,
		thinking: task.thinking ?? rc.thinking ?? plan.thinking ?? cfg.thinking ?? "",
		role,
	};
}
