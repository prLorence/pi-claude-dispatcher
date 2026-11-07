/**
 * harness-monitor: the read-only Pi monitor ported to a dsh web plugin.
 *
 * It registers `/api/state`, `/api/events`, `/api/session/...`, `/api/agents`
 * and the built client under `/plugins/harness-monitor/` on `ctx.webServer`.
 * It never writes anything. In a profile with no web server (headless) it is
 * inert; this is not a fallback server.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createMonitor } from "./server.js";
import { MAX_REPOS, resolveRepos } from "./repos.js";

export const name = "harness-monitor";
export const inject = ["webServer", "workingDirectory"];

/** The `harness-projects` registry file, unless config names another. */
export function defaultRegistryPath(home = os.homedir()) {
	return path.join(home, ".dsh", "harness-projects.json");
}

/** Registered projects; an empty list for a missing or corrupt registry. */
function readRegistryProjects(file) {
	try {
		const raw = JSON.parse(fs.readFileSync(file, "utf8"));
		const projects = raw?.projects && typeof raw.projects === "object" ? Object.values(raw.projects) : [];
		return projects.filter((project) => project && typeof project.path === "string" && project.path.trim() !== "");
	} catch {
		return [];
	}
}

/** Pinned first, then by name; each project as `{ name, dir: <path>/.plans }`. */
export function discoverRepos(file = defaultRegistryPath()) {
	const discovered = [];
	for (const project of readRegistryProjects(file)) {
		const dir = path.join(project.path, ".plans");
		let isDirectory = false;
		try {
			isDirectory = fs.statSync(dir).isDirectory();
		} catch {
			isDirectory = false;
		}
		if (!isDirectory) continue;
		const name = typeof project.name === "string" && project.name.trim() !== "" ? project.name.trim() : path.basename(project.path);
		discovered.push({ name, dir, pinned: Boolean(project.pinned) });
	}
	return discovered
		.sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.name.localeCompare(b.name))
		.slice(0, MAX_REPOS)
		.map(({ name, dir: projectDir }) => ({ name, dir: projectDir }));
}

/** Explicit config wins; else the registry; else the single fallback repo. */
function monitorRepos(config, plansDir) {
	if (config.repos?.length) return { repos: config.repos, discovered: 0 };
	const registryPath = config.registryPath || defaultRegistryPath();
	const discovered = discoverRepos(registryPath);
	if (discovered.length > 0) return { repos: discovered, discovered: discovered.length, registryPath };
	return { repos: [{ name: config.repoName || "repo", dir: plansDir }], discovered: 0 };
}

export async function apply(ctx, config = {}) {
	const root = config.root || ctx.workingDirectory?.defaultDirectory || process.cwd();
	const plansDir = config.plansDir || path.join(root, ".plans");
	const { repos, discovered, registryPath } = monitorRepos(config, plansDir);
	if (discovered > 0) ctx.logger?.info?.(`harness-monitor: watching ${discovered} project${discovered === 1 ? "" : "s"} from ${registryPath}`);
	const staticDir = config.staticDir || path.join(import.meta.dirname, "dist");
	const monitor = createMonitor({
		repos,
		message: null,
		staticDir,
		pollMs: config.pollMs ?? 500,
		home: config.home,
		enableAgents: config.enableAgents !== false,
	});

	const prefix = (config.prefix || "/plugins/harness-monitor").replace(/\/+$/, "");
	const disposers = [];
	disposers.push(ctx.webServer.register({ kind: "exact", path: "/api/state", handler: monitor.handler }));
	disposers.push(ctx.webServer.register({ kind: "exact", path: "/api/events", handler: monitor.handler }));
	disposers.push(ctx.webServer.register({ kind: "prefix", path: "/api/monitor/session", handler: monitor.handler }));
	disposers.push(ctx.webServer.register({ kind: "exact", path: "/api/agents", handler: monitor.handler }));
	disposers.push(ctx.webServer.register({ kind: "prefix", path: prefix, handler: (req, res) => serveStatic(monitor, staticDir, prefix, req, res) }));

	return () => {
		for (const dispose of disposers) dispose?.();
		monitor.stop();
	};
}

/** dsh may hand the handler either the full path or the path below the mount. */
export function relativeStaticPath(prefix, pathname) {
	const value = pathname && pathname.startsWith(prefix) ? pathname.slice(prefix.length) : pathname;
	return !value || value === "/" ? "/index.html" : value;
}

function serveStatic(monitor, staticDir, prefix, req, res) {
	const url = new URL(req.url ?? "/", `http://${req.headers?.host ?? "127.0.0.1"}`);
	const relative = relativeStaticPath(prefix, url.pathname);
	const original = req.url;
	// Re-enter the shared handler with a static-only path.
	req.url = relative + url.search;
	monitor.handler(req, res);
	req.url = original;
}

export default { name, inject, apply };
export { resolveRepos };
