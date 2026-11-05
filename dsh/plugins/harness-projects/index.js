/**
 * harness-projects: git repositories as projects, warm from the agent vault.
 *
 * Two prompt contributions per session, both keyed by the session's repository:
 *   - a stable section (order 940) naming the repo, its root and its vault mode;
 *   - a dynamic context (order 130) carrying the warm block: git state, project
 *     note, open findings, recent runs and the newest vault log line.
 *
 * The warm block is computed in `agent/created` (awaited before the first model
 * call) and refreshed on an interval, so a new session starts warm and a running
 * session never goes cold. Workers get no vault text: the vault is orchestrator-
 * only, exactly as harness-vault enforces for its tools.
 */
import { normalizeConfig } from "./config.js";
import { canonicalPath, defaultRegistryPath, loadRegistry, removeProject, saveRegistry, listProjects, upsertProject } from "./registry.js";
import { registerProjectTools } from "./tools.js";
import { ensurePlanDirs } from "./plans.js";
import { createVaultReader, defaultSkillRoot } from "./vault-read.js";
import { readVaultSync, runVaultSync } from "./vault-sync.js";
import { createWarmCache } from "./warm.js";

export const name = "harness-projects";
export const inject = ["tools", "systemPrompt", "agents", "workingDirectory"];

export const SECTION_NAME = "harness-projects";
export const SECTION_ORDER = 940;
export const CONTEXT_ORDER = 130;

export async function apply(ctx, config = {}) {
	const options = normalizeConfig(config);
	if (!options.enabled) return undefined;

	const log = (message) => ctx.logger?.info?.(message);
	const registryFile = options.registryPath || defaultRegistryPath();
	let registry = loadRegistry(registryFile);
	for (const project of listProjects(registry)) {
		try {
			ensurePlanDirs(project.path);
		} catch (error) {
			ctx.logger?.warn?.(`harness-projects: could not ensure .plans for ${project.path}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	const reader = createVaultReader({
		skillRoot: options.skillRoot || defaultSkillRoot(),
		ttlMs: options.refreshSeconds * 1000,
		log,
	});
	const cache = createWarmCache({
		reader,
		budget: options.budget,
		ttlMs: options.refreshSeconds * 1000,
		onError: (error) => ctx.logger?.warn?.(`harness-projects: warm context failed: ${error instanceof Error ? error.message : String(error)}`),
	});

	/** agentId → stable identity text; deleted with the agent. */
	const identities = new Map();
	/** directory → last warm text handed to a prompt provider (sync read). */
	const warmTexts = new Map();

	const isRoot = (agent) => {
		if (!agent) return true;
		const roots = ctx.agents?.roots?.() ?? [];
		return roots.length === 0 || roots.includes(agent);
	};

	const directoryOf = (agent) => {
		try {
			const session = agent?.session;
			if (session && ctx.workingDirectory?.get) return ctx.workingDirectory.get(session);
		} catch {
			// Fall through to the deployment default.
		}
		return ctx.workingDirectory?.defaultDirectory || options.cwd || process.cwd();
	};

	const persist = () => {
		try {
			saveRegistry(registryFile, registry);
		} catch (error) {
			ctx.logger?.warn?.(`harness-projects: could not save ${registryFile}: ${error instanceof Error ? error.message : String(error)}`);
		}
	};

	/** Compute everything one session needs; safe to call repeatedly. */
	const prime = async (agent) => {
		const dir = directoryOf(agent);
		const { repo, text } = await cache.get(dir, { force: true });
		warmTexts.set(dir, text);
		if (repo?.root) {
			try {
				ensurePlanDirs(repo.root);
			} catch (error) {
				ctx.logger?.warn?.(`harness-projects: could not ensure .plans for ${repo.root}: ${error instanceof Error ? error.message : String(error)}`);
			}
			const key = canonicalPath(repo.root);
			const known = registry.projects[key];
			upsertProject(registry, { path: repo.root, name: known?.name || repo.name, slug: known?.slug || repo.slug, pinned: known?.pinned });
			persist();
		}
		const mode = repo?.slug ? await reader.modeOf(repo.slug) : "none";
		identities.set(agent.id, identityText(repo, mode, isRoot(agent)));
		return { repo, text };
	};

	const identityText = (repo, mode, root) => {
		if (!repo?.root) return "";
		const lines = [`## Project (${SECTION_NAME})`, `Repo: ${repo.slug ?? repo.name} at ${repo.root}; vault mode ${mode}.`];
		if (root) lines.push("project_status shows git state, open findings and recent runs; project_list lists every managed repository.");
		else lines.push("Workers do not read the agent vault; use the task prompt and the repository itself.");
		return lines.join("\n");
	};

	const warmProvider = (agent) => {
		if (!agent) return "";
		if (!isRoot(agent) && !options.warmForSubagents) return "";
		return warmTexts.get(directoryOf(agent)) ?? "";
	};

	const identityProvider = (agent) => (agent ? identities.get(agent.id) ?? "" : "");

	const disposeTools = registerProjectTools(ctx, {
		getState: () => ({ registry, reader, save: persist, ensurePlans: ensurePlanDirs }),
		warmText: (dir) => warmTexts.get(dir) ?? "",
		warmFor: (dir, { force } = {}) => cache.get(dir, { force }),
		isRoot,
		defaultDir: (agent) => directoryOf(agent),
		maxRepos: options.maxRepos,
	});

	const disposeSection = ctx.systemPrompt?.section?.({
		name: SECTION_NAME,
		order: SECTION_ORDER,
		interpolate: false,
		text: (context) => identityProvider(context?.agent),
	});
	const disposeContext = ctx.systemPrompt?.context?.({
		name: SECTION_NAME,
		order: CONTEXT_ORDER,
		interpolate: false,
		text: (context) => warmProvider(context?.agent),
	});

	const onCreated = async ({ agent } = {}) => {
		if (!agent) return;
		try {
			await prime(agent);
		} catch (error) {
			ctx.logger?.warn?.(`harness-projects: prime failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	};
	const onDisposed = ({ agent } = {}) => {
		if (agent) identities.delete(agent.id);
	};

	ctx.on?.("agent/created", onCreated);
	ctx.on?.("agent/disposed", onDisposed);

	// Sessions that already exist when the plugin loads stay warm too.
	for (const agent of ctx.agents?.list?.() ?? []) {
		void onCreated({ agent });
	}

	// Keep the cached text fresh for running sessions; a sync provider can only
	// read the cache, so the refresh happens here and not in the prompt path.
	const timer = setInterval(() => {
		for (const dir of new Set([...warmTexts.keys(), ...(ctx.agents?.list?.() ?? []).map(directoryOf)])) {
			void cache
				.get(dir)
				.then(({ text }) => warmTexts.set(dir, text))
				.catch((error) => ctx.logger?.warn?.(`harness-projects: refresh failed: ${error instanceof Error ? error.message : String(error)}`));
		}
	}, Math.max(5, options.refreshSeconds) * 1000);
	timer.unref?.();

	// Host routes for the Client half. `webServer` is optional, so it must not be
	// in `inject`: that would make the tools and the warm context inert in a
	// headless profile. It also cannot be read eagerly with `ctx.get`: the web
	// server's fiber is still loading (its `Service.init` awaits `listen`) when
	// this plugin applies, so `ctx.get` correctly reports it as unavailable and
	// the routes would never be registered. A scoped `ctx.inject` fiber waits for
	// the service and registers the routes exactly once it is active.
	const httpDisposers = [];
	ctx.inject?.(["webServer"], (scoped) => {
		const webServer = scoped.webServer;
		const sendJson = (res, status, value, head) => {
			res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
			res.end(head ? undefined : JSON.stringify(value));
		};
		const readBody = (req, limit = 65_536) =>
			new Promise((resolve, reject) => {
				let size = 0;
				const chunks = [];
				req.on("data", (chunk) => {
					size += chunk.length;
					if (size > limit) {
						reject(new Error("body too large"));
						req.destroy();
						return;
					}
					chunks.push(chunk);
				});
				req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
				req.on("error", reject);
			});
		const buildState = async (directory) => {
			const sessionDir = directory || ctx.workingDirectory?.defaultDirectory || process.cwd();
			const session = await cache.get(sessionDir);
			const projects = [];
			for (const project of listProjects(registry).slice(0, 40)) {
				const { repo } = await cache.get(project.path);
				projects.push({
					path: project.path,
					name: project.name,
					slug: project.slug ?? repo?.slug,
					pinned: Boolean(project.pinned),
					mode: repo?.slug ? await reader.modeOf(repo.slug) : "none",
					git: repo?.git ?? null,
					error: repo?.error,
				});
			}
			const snapshot = await reader.snapshot();
			const vaultPath = snapshot.vaultPath;
			const vault = vaultPath ? await readVaultSync(vaultPath) : { ok: false, reason: "no vault resolved" };
			if (vault.lastCommit) {
				// Trim at the boundary: the wire carries git's own spacing, the panel should not.
				vault.lastCommit = {
					...vault.lastCommit,
					hash: String(vault.lastCommit.hash ?? "").trim(),
					subject: String(vault.lastCommit.subject ?? "").trim(),
					when: String(vault.lastCommit.when ?? "").trim(),
				};
			}
			return {
				projects,
				session: { directory: sessionDir, repo: session.repo, warm: session.text },
				registryPath: registryFile,
				vaultReady: Boolean(vaultPath),
				vault,
			};
		};

		httpDisposers.push(
			webServer.register({
				kind: "exact",
				path: "/plugins/harness-projects/state",
				handler: async (req, res) => {
					if (req.method !== "GET" && req.method !== "HEAD") {
						res.writeHead(405, { allow: "GET, HEAD" });
						res.end();
						return;
					}
					const url = new URL(req.url ?? "/", "http://localhost");
					const dir = url.searchParams.get("dir") ?? undefined;
					sendJson(res, 200, await buildState(dir), req.method === "HEAD");
				},
			}),
		);

		httpDisposers.push(
			webServer.register({
				kind: "exact",
				path: "/plugins/harness-projects/action",
				handler: async (req, res) => {
					if (req.method !== "POST") {
						res.writeHead(405, { allow: "POST" });
						res.end();
						return;
					}
					let action;
					try {
						action = JSON.parse((await readBody(req)) || "{}");
					} catch (error) {
						sendJson(res, 400, { error: error instanceof Error ? error.message : "invalid JSON" });
						return;
					}
					const target = action.path || ctx.workingDirectory?.defaultDirectory || process.cwd();
					try {
						if (action.action === "add") {
							const { repo } = await cache.get(target, { force: true });
							if (!repo?.root) throw new Error(`${target} is not inside a git repository`);
							upsertProject(registry, { path: repo.root, name: action.name, slug: action.slug || repo.slug, pinned: action.pinned });
							persist();
						} else if (action.action === "remove") {
							if (!removeProject(registry, target)) throw new Error(`${target} is not in the registry`);
							persist();
						} else if (action.action === "pin") {
							const project = registry.projects[canonicalPath(target)];
							if (!project) throw new Error(`${target} is not in the registry`);
							project.pinned = !project.pinned;
							persist();
						} else if (action.action === "refresh") {
							cache.invalidate(target);
							await cache.get(target, { force: true });
						} else if (action.action === "sync") {
							const snapshot = await reader.snapshot();
							if (!snapshot.vaultPath) throw new Error("no vault resolved; run vault.mjs setup");
							const result = await runVaultSync({
								skillRoot: options.skillRoot || defaultSkillRoot(),
								action: action.direction === "push" ? "push" : "pull",
								summary: action.summary,
								cwd: snapshot.vaultPath,
							});
							reader.invalidate();
							if (result.code !== 0) throw new Error((result.stderr || result.stdout || `sync exited ${result.code ?? "timeout"}`).trim().split("\n").slice(-3).join("\n"));
						} else {
							throw new Error(`unknown action: ${action.action}`);
						}
						sendJson(res, 200, await buildState(target));
					} catch (error) {
						sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
					}
				},
			}),
		);
		return () => {
			for (const dispose of httpDisposers.splice(0)) dispose?.();
		};
	});

	return () => {
		for (const dispose of httpDisposers.splice(0)) dispose?.();
		clearInterval(timer);
		ctx.off?.("agent/created", onCreated);
		ctx.off?.("agent/disposed", onDisposed);
		disposeTools?.();
		disposeSection?.();
		disposeContext?.();
	};
}

export default { name, inject, apply };
