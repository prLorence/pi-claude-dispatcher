/**
 * harness-dispatch: the dsh plugin that ports pi-plan-dispatch.
 *
 * One queue per session repository: a session's git root wins, otherwise a
 * registered `harness-projects` repository containing its cwd, otherwise the
 * most recently active managed repository. The fallback queue is the profile's
 * working directory, so headless use still has a place to watch.
 */
import * as path from "node:path";
import { appendEvent } from "./trace.js";
import { ensureDirs, getDirs, loadConfig } from "./config.js";
import { createQueue } from "./queue.js";
import { runVerify } from "./verify.js";
import { createWorkerRunner } from "./worker.js";
import { checkToolCall } from "./guard.js";
import { createCodingSubagentTool } from "./coding-subagent.js";
import { createAuditTool } from "./audit.js";
import { defaultProjectRegistry, ensureProject, findGitRoot, loadProjects, projectsStatus, sessionRoot } from "./projects.js";

export const name = "harness-dispatch";
export const inject = ["tools", "systemPrompt", "subagents", "agents", "workingDirectory"];

const VAULT_TOOLS = new Set([
	"vault_search",
	"vault_note",
	"vault_work",
	"vault_log",
	"vault_sync",
	"vault_restore",
	"vault_config",
	"vault_record_run",
]);

const STATUS_PARAMETERS = {
	type: "object",
	properties: {},
	additionalProperties: false,
};

const STATUS_OUTPUT = { type: "object", additionalProperties: true };

export async function apply(ctx, config = {}) {
	const projectRegistry = config.projectRegistry || defaultProjectRegistry();
	const log = (message) => {
		try {
			ctx.logger?.info?.(message);
		} catch {
			// Logging must never break dispatch.
		}
	};
	const projects = loadProjects(projectRegistry);
	const fallbackRoot = config.root || ctx.workingDirectory?.defaultDirectory || process.cwd();
	for (const project of projects) {
		try {
			ensureProject(project.path);
		} catch (error) {
			ctx.logger?.warn?.(`harness-dispatch: could not ensure .plans for ${project.path}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	const active = new Map();
	/** session id → repository root explicitly selected with dispatch_project. */
	const sessionRoots = new Map();
	/** root path → { root, dirs, queue, currentPlan } */
	const entries = new Map();

	const rootOf = (agent) => {
		if (config.root) return config.root;
		const sessionId = agent?.session?.id ?? agent?.id;
		if (sessionId !== undefined && sessionRoots.has(sessionId)) return sessionRoots.get(sessionId);
		let cwd = ctx.workingDirectory?.defaultDirectory || fallbackRoot;
		try {
			if (agent?.session && ctx.workingDirectory?.get) cwd = ctx.workingDirectory.get(agent.session) || cwd;
		} catch {
			// A disposed agent or an unbound session falls back to the profile root.
		}
		return sessionRoot(cwd, loadProjects(projectRegistry), fallbackRoot);
	};

	const entryFor = (root) => {
		const key = path.resolve(root);
		const existing = entries.get(key);
		if (existing) return existing;
		const dirs = getDirs(root);
		ensureDirs(dirs);
		const entry = { root, dirs, currentPlan: null, queue: undefined };
		const runWorker = createWorkerRunner({ ctx, root, cfgOf: () => loadConfig(dirs), active, log });
		entry.queue = createQueue({
			cwd: root,
			runtime: {
				dirs,
				appendEvent,
				runVerify,
				runWorker,
				onPlan: (plan) => {
					entry.currentPlan = plan;
				},
				// Loose coupling: the vault plugin observes this and writes the run
				// record, so dispatch does not import it and still works without it.
				onFinish: (result) => {
					try {
						const slug = projects.find((p) => path.resolve(p.path) === path.resolve(root))?.slug;
						ctx.emit("dispatch/plan-finished", { root, slug, ...result });
					} catch (error) {
						log(`harness-dispatch: plan-finished notify failed: ${error instanceof Error ? error.message : String(error)}`);
					}
				},
			},
			log,
			pollMs: config.pollMs ?? 500,
		});
		entries.set(key, entry);
		entry.queue.start();
		return entry;
	};

	const entryForAgent = (agent) => entryFor(rootOf(agent));

	// One global guard for defence in depth; each worker also gets a scoped one.
	ctx.tools.guard((exec) => {
		const id = exec.agent?.session?.id ?? exec.agent?.id;
		if (id !== undefined && VAULT_TOOLS.has(exec.name)) {
			const entry = active.get(id);
			if (entry) return `BLOCKED by harness-dispatch: ${exec.name} is not available to a worker; list the vault need under NEEDS instead.`;
		}
		const entry = id === undefined ? undefined : active.get(id);
		if (!entry) return undefined;
		const decision = checkToolCall(entry.policy, exec.name, exec.arguments);
		if (!decision.block) return undefined;
		entry.blocked++;
		return decision.reason;
	});

	ctx.tools.register({
		name: "dispatch_project",
		description:
			"Select the repository this session dispatches from, and start its plan queue. Use it when the session's working directory is not the git repository you mean.",
		parameters: {
			type: "object",
			properties: { path: { type: "string", description: "Directory inside the target repository" } },
			required: ["path"],
			additionalProperties: false,
		},
		output: {
			schema: STATUS_OUTPUT,
			render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
		},
		async execute(args, exec) {
			const cwd = ctx.workingDirectory?.get?.(exec?.agent?.session) || fallbackRoot;
			const target = path.resolve(cwd, args.path);
			const root = findGitRoot(target) || target;
			const sid = exec?.agent?.session?.id ?? exec?.agent?.id;
			if (sid !== undefined) sessionRoots.set(sid, root);
			const entry = entryFor(root);
			const status = entry.queue.status();
			status.plans = entry.dirs.root;
			status.projects = projectsStatus(projectRegistry);
			return JSON.parse(JSON.stringify(status));
		},
	});

	ctx.tools.register({
		name: "dispatch_status",
		description:
			"Read the plan dispatcher for the calling session's repository: the ready queue, the running plan and task states, and the last gate. This is the orchestrator's view; workers cannot call it.",
		parameters: STATUS_PARAMETERS,
		output: {
			schema: STATUS_OUTPUT,
			render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
		},
		async execute(_args, exec) {
			const entry = entryForAgent(exec?.agent);
			const status = entry.queue.status();
			status.plans = entry.dirs.root;
			status.projects = projectsStatus(projectRegistry);
			status.tasks = entry.currentPlan
				? entry.currentPlan.tasks.map((t) => ({
						id: t.id,
						state: t.state,
						attempts: t.attempts,
						role: t.role || "implement",
						summary: t.summary ? String(t.summary).split("\n")[0].slice(0, 200) : undefined,
					}))
				: [];
			// Drop undefined fields: the Agent tool output validator requires lossless JSON.
			return JSON.parse(JSON.stringify(status));
		},
	});

	ctx.tools.register(
		createAuditTool({
			ctx,
			root: fallbackRoot,
			rootFor: (agent) => rootOf(agent),
			cfgOf: (root) => loadConfig(getDirs(root || fallbackRoot)),
		}),
	);

	ctx.tools.register(
		createCodingSubagentTool({
			ctx,
			root: fallbackRoot,
			rootFor: (agent) => rootOf(agent),
			cfgOf: (root) => loadConfig(getDirs(root || fallbackRoot)),
		}),
	);

	ctx.systemPrompt.section({
		name: "harness-dispatch",
		order: 900,
		text: [
			"## Plan dispatcher (harness-dispatch)",
			"Plans are `.plans/inbox/<id>.md` files with frontmatter `status: ready`; the dispatcher watches the calling session's repository and runs one plan at a time.",
			"Use the `dispatch_status` tool for the queue, the running task states and the last gate. Wait with `trace.mjs wait --plan <id>` and read the gate with `trace.mjs gate --plan <id>`.",
			"Workers are dsh subagents (or `agent: \"pi\"` / `agent: \"omp\"` workers): your own edit and write tools are not the worker's; the dispatcher starts them.",
		].join("\n"),
	});

	const entry = entryForAgent(undefined);
	const offCreated = ctx.on("agent/created", ({ agent } = {}) => {
		if (!agent) return;
		try {
			entryForAgent(agent);
		} catch (error) {
			log(`harness-dispatch: could not start a queue for a session: ${error instanceof Error ? error.message : String(error)}`);
		}
	});

	return () => {
		offCreated?.();
		for (const item of entries.values()) item.queue.stop();
	};
}

export default { name, inject, apply };
