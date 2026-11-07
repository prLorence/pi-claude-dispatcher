/**
 * Read-only node HTTP carrier for the monitor. The same handler serves the dsh
 * web routes and the standalone test server.
 */
import * as fs from "node:fs";
import * as http from "node:http";
import { extname } from "node:path";
import { ID_RE, checkRequest, json, resolveInside, withHeaders } from "./http.js";
import { STALL_MS } from "./lanes.js";
import { listAgentSessions } from "./agents.js";
import { findSessionFile, parseSessionLines, summarizeSession } from "./sessions.js";
import { readState } from "./state.js";
import { signature } from "./watch.js";

const CONTENT_TYPES = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
};
const PING_MS = 15000;

function decodeSegment(value) {
	try {
		return decodeURIComponent(value);
	} catch {
		return null;
	}
}

export function sessionPage(plansDir, planId, sessionId, after, nowMs = Date.now()) {
	const file = findSessionFile(plansDir, planId, sessionId);
	if (file === null) return json({ error: "not found" }, 404);
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return json({ error: "not found" }, 404);
	}
	const parsed = parseSessionLines(text, after);
	const summary = summarizeSession(file);
	const live = !summary.ended && nowMs - summary.mtimeMs <= STALL_MS;
	return json({ id: sessionId, live, ended: summary.ended, entries: parsed.entries, next: parsed.next });
}

function staticFile(staticDir, pathname) {
	let relative;
	if (pathname === "/" || pathname === "") relative = "index.html";
	else {
		const decoded = decodeSegment(pathname);
		if (decoded === null) return json({ error: "not found" }, 404);
		relative = decoded.replace(/^\/+/, "");
	}
	const file = resolveInside(staticDir, relative);
	if (file === null) return json({ error: "not found" }, 404);
	let data;
	try {
		data = fs.readFileSync(file);
	} catch {
		return json({ error: "not found" }, 404);
	}
	return { status: 200, headers: { "content-type": CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream" }, body: data };
}

/**
 * Build the monitor: a request handler plus the SSE poll that tells browsers
 * when the tree changed. It never writes anything.
 */
export function createMonitor({ repos, message = null, staticDir, pollMs = 500, now = Date.now, home, enableAgents = true } = {}) {
	const clients = new Set();
	const byName = new Map(repos.map((repo) => [repo.name, repo]));
	let last = signature(repos);
	let lastPing = now();
	let stopped = false;

	const write = (client, text) => {
		try {
			client.write(text);
		} catch {
			clients.delete(client);
		}
	};
	const broadcast = (text) => {
		for (const client of clients) write(client, text);
	};

	const events = (req, res) => {
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		clients.add(res);
		res.write("event: hello\ndata: {}\n\n");
		req.on("close", () => clients.delete(res));
		return null;
	};

	const route = (url) => {
		const pathname = url.pathname;
		if (pathname === "/api/state") return json(readState(repos, now(), message));
		if (pathname === "/api/events") return { sse: true };
		if (pathname === "/api/agents" && enableAgents) {
			const scope = url.searchParams.get("scope") === "all" ? "all" : "added";
			return json(listAgentSessions({ home, repos, nowMs: now(), scope }));
		}
		if (pathname.startsWith("/api/monitor/session/")) {
			const parts = pathname.split("/");
			if (parts.length !== 7) return json({ error: "not found" }, 404);
			const repoName = decodeSegment(parts[4]);
			const planId = decodeSegment(parts[5]);
			const sessionId = decodeSegment(parts[6]);
			if (repoName === null || planId === null || sessionId === null) return json({ error: "bad id" }, 400);
			const repo = byName.get(repoName);
			if (repo === undefined) return json({ error: "not found" }, 404);
			if (!ID_RE.test(planId) || !ID_RE.test(sessionId)) return json({ error: "bad id" }, 400);
			const rawAfter = url.searchParams.get("after");
			let after = 0;
			if (rawAfter !== null) {
				if (!/^\d+$/.test(rawAfter)) return json({ error: "bad after" }, 400);
				after = Number.parseInt(rawAfter, 10);
			}
			return sessionPage(repo.dir, planId, sessionId, after, now());
		}
		if (pathname.startsWith("/api/")) return json({ error: "not found" }, 404);
		return staticFile(staticDir, pathname);
	};

	const handler = (req, res) => {
		const url = new URL(req.url ?? "/", `http://${req.headers?.host ?? "localhost"}`);
		const api = url.pathname === "/api" || url.pathname.startsWith("/api/");
		const guard = checkRequest(req);
		if (guard !== null) {
			const out = withHeaders(guard, api);
			res.writeHead(out.status, { ...(out.headers ?? {}), ...(out.allow ? { Allow: out.allow } : {}) });
			res.end(req.method === "HEAD" ? undefined : typeof out.body === "string" ? out.body : JSON.stringify(out.body));
			return;
		}
		const result = route(url);
		if (result !== null && result.sse) {
			events(req, res);
			return;
		}
		const out = withHeaders(result, api);
		res.writeHead(out.status, out.headers ?? {});
		res.end(req.method === "HEAD" ? undefined : out.body);
	};

	const poll = setInterval(() => {
		if (stopped) return;
		try {
			const nowMs = now();
			if (nowMs - lastPing >= PING_MS) {
				lastPing = nowMs;
				broadcast(": ping\n\n");
			}
			const current = signature(repos);
			if (current !== last) {
				last = current;
				broadcast("event: change\ndata: {}\n\n");
			}
		} catch {
			// Keep polling: a transient read error must not stop the clock.
		}
	}, pollMs);
	if (poll.unref) poll.unref();

	return {
		handler,
		state: () => readState(repos, now(), message),
		session: (repoName, planId, sessionId, after = 0) => {
			const repo = byName.get(repoName);
			if (repo === undefined) return null;
			return sessionPage(repo.dir, planId, sessionId, after, now());
		},
		stop: () => {
			stopped = true;
			clearInterval(poll);
			for (const client of clients) {
				try {
					client.end();
				} catch {}
			}
			clients.clear();
		},
	};
}

export async function startServer(opts) {
	const monitor = createMonitor(opts);
	const server = http.createServer(monitor.handler);
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", resolve);
	});
	return {
		port: server.address().port,
		monitor,
		async stop() {
			monitor.stop();
			const done = new Promise((resolve) => server.close(resolve));
			server.closeAllConnections?.();
			await done;
		},
	};
}
