/**
 * harness-monitor: the read-only Pi monitor ported to a dsh web plugin.
 *
 * It registers `/api/state`, `/api/events`, `/api/session/...`, `/api/agents`
 * and the built client under `/plugins/harness-monitor/` on `ctx.webServer`.
 * It never writes anything. In a profile with no web server (headless) it is
 * inert; this is not a fallback server.
 */
import * as path from "node:path";
import { createMonitor } from "./server.js";
import { resolveRepos } from "./repos.js";

export const name = "harness-monitor";
export const inject = ["webServer", "workingDirectory"];

export async function apply(ctx, config = {}) {
	const root = config.root || ctx.workingDirectory?.defaultDirectory || process.cwd();
	const plansDir = config.plansDir || path.join(root, ".plans");
	const repos = config.repos?.length ? config.repos : [{ name: config.repoName || "repo", dir: plansDir }];
	const staticDir = config.staticDir || path.join(import.meta.dirname, "dist");
	const monitor = createMonitor({
		repos,
		message: null,
		staticDir,
		pollMs: config.pollMs ?? 500,
		home: config.home,
		enableAgents: config.enableAgents !== false,
	});

	const prefix = config.prefix || "/plugins/harness-monitor";
	const disposers = [];
	disposers.push(ctx.webServer.register({ kind: "exact", path: "/api/state", handler: monitor.handler }));
	disposers.push(ctx.webServer.register({ kind: "exact", path: "/api/events", handler: monitor.handler }));
	disposers.push(ctx.webServer.register({ kind: "prefix", path: "/api/session/", handler: monitor.handler }));
	disposers.push(ctx.webServer.register({ kind: "exact", path: "/api/agents", handler: monitor.handler }));
	disposers.push(ctx.webServer.register({ kind: "prefix", path: `${prefix}/`, handler: (req, res) => serveStatic(monitor, staticDir, prefix, req, res) }));

	return () => {
		for (const dispose of disposers) dispose?.();
		monitor.stop();
	};
}

function serveStatic(monitor, staticDir, prefix, req, res) {
	const url = new URL(req.url ?? "/", `http://${req.headers?.host ?? "127.0.0.1"}`);
	let relative = url.pathname.slice(prefix.length) || "/";
	if (relative === "/") relative = "/index.html";
	const original = req.url;
	// Re-enter the shared handler with a static-only path.
	req.url = relative;
	monitor.handler(req, res);
	req.url = original;
}

export default { name, inject, apply };
export { resolveRepos };
