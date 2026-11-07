/**
 * harness-guard: keeps the Web API honest.
 *
 * A plugin that registers a prefix route over a core API path silently takes
 * over those requests: `/api/session` swallows `/api/session/create`, the app
 * answers 405 read-only, the session list looks empty, and nothing in the log
 * says why. This plugin probes the core routes on a timer, records which named
 * route actually wins for each one, and shouts when a plugin has shadowed them.
 *
 * It never throws: a guard that breaks the host is worse than no guard.
 */
import { request } from "node:http";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";

export const name = "harness-guard";
export const inject = ["webServer"];

const DEFAULT_LOG = join(homedir(), "Library/Logs/dsh-guard.log");
const STATUS_PATH = "/plugins/harness-guard/status";

/** Core routes every composition must reach. `match()` shows who wins. */
const PROBES = [
	{ method: "POST", path: "/api/session/create", what: "session creation" },
	{ method: "GET", path: "/api/sessions", what: "session list" },
];

/** Statuses that prove the request reached the harness API and was handled. */
const REACHED = new Set([200, 201, 202, 204, 400, 401, 403, 409, 415, 422, 429]);

/**
 * Decide whether one probe result means the API is intact.
 * @param {{status?: number, body?: string, error?: string}} result
 * @returns {{ok: boolean, reason: string|null}}
 */
export function classify(result) {
	if (result?.error) return { ok: false, reason: `unreachable: ${result.error}` };
	const status = result?.status ?? 0;
	const body = result?.body ?? "";
	if (status === 405 || /read only/i.test(body)) {
		return { ok: false, reason: "shadowed by a read-only route (405)" };
	}
	if (status === 404) return { ok: false, reason: "core route missing (404)" };
	if (status >= 500) return { ok: false, reason: `server error (${status})` };
	if (REACHED.has(status)) return { ok: true, reason: null };
	return { ok: false, reason: `unexpected status ${status}` };
}

/** One HTTP probe with a hard deadline; never rejects. */
function probe(origin, spec, timeoutMs) {
	return new Promise((resolve) => {
		let settled = false;
		const done = (value) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		let req;
		try {
			const url = new URL(spec.path, origin);
			req = request(
				{
					hostname: url.hostname,
					port: url.port || undefined,
					path: `${url.pathname}${url.search}`,
					method: spec.method,
					headers: { "content-type": "application/json", accept: "application/json" },
					timeout: timeoutMs,
				},
				(res) => {
					let body = "";
					res.setEncoding("utf8");
					res.on("data", (chunk) => {
						if (body.length < 500) body += chunk;
					});
					res.on("end", () => done({ status: res.statusCode ?? 0, body: body.slice(0, 300) }));
					res.on("error", (error) => done({ error: error.message }));
				},
			);
			req.on("timeout", () => req.destroy(new Error("timeout")));
			req.on("error", (error) => done({ error: error.message }));
			req.end(spec.method === "POST" ? "{}" : undefined);
		} catch (error) {
			req?.destroy();
			done({ error: error instanceof Error ? error.message : String(error) });
		}
	});
}

/**
 * @param {{status?: number, body?: string, error?: string}} result
 * @returns {string} one human line for the log
 */
function describe(spec, result) {
	const status = result?.status ?? "ERR";
	const body = result?.body ? ` ${JSON.stringify(result.body).slice(0, 120)}` : "";
	const err = result?.error ? ` ${result.error}` : "";
	return `${spec.method} ${spec.path} (${spec.what}) -> ${status}${err}${body}`;
}

export async function apply(ctx, config = {}) {
	const intervalMs = Number(config.intervalMs ?? 60_000);
	const timeoutMs = Number(config.timeoutMs ?? 2_000);
	const notify = config.notify !== false;
	const logFile = config.logFile ?? DEFAULT_LOG;

	const startedAt = Date.now();
	const state = { last: null, history: [], failures: 0, alertedAt: 0, lastError: null };

	const record = (level, message) => {
		const line = `${new Date().toISOString()} [${level}] ${message}`;
		state.history.push(line);
		if (state.history.length > 50) state.history.shift();
		try {
			mkdirSync(dirname(logFile), { recursive: true });
			appendFileSync(logFile, `${line}\n`);
		} catch {
			/* logging must never break the host */
		}
		if (level === "error") ctx.logger?.error?.(message);
		else if (level === "warn") ctx.logger?.warn?.(message);
		else ctx.logger?.info?.(message);
	};

	const notifyDesktop = (title, message) => {
		if (!notify || process.platform !== "darwin") return;
		try {
			const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`;
			const child = execFile("/usr/bin/osascript", ["-e", script], () => {});
			child.unref?.();
		} catch {
			/* notifications are best effort */
		}
	};

	const routeFor = (path) => {
		try {
			const route = ctx.webServer.match?.(path);
			return route ? { kind: route.kind, path: route.path } : null;
		} catch {
			return null;
		}
	};

	const check = async () => {
		let origin;
		try {
			origin = ctx.webServer.getOrigin();
		} catch (error) {
			state.last = { ok: false, at: Date.now(), reason: `no origin: ${error?.message ?? error}`, checks: [] };
			return state.last;
		}

		const checks = [];
		for (const spec of PROBES) {
			const result = await probe(origin, spec, timeoutMs);
			const verdict = classify(result);
			checks.push({
				...spec,
				...verdict,
				status: result.status ?? null,
				body: result.body?.slice(0, 120) ?? null,
				route: routeFor(spec.path),
				line: describe(spec, result),
			});
		}

		const failed = checks.filter((c) => !c.ok);
		const ok = failed.length === 0;
		const previous = state.last?.ok;

		if (!ok) {
			state.failures += 1;
			for (const bad of failed) {
				record("error", `API degraded: ${bad.reason} — ${bad.line}`);
				if (bad.route) {
					record(
						"error",
						`resolved by ${bad.route.kind} route "${bad.route.path}" — a plugin is shadowing the core path`,
					);
				}
			}
			// Alert on the healthy -> broken edge, then at most once per hour.
			if (previous !== false || Date.now() - state.alertedAt > 3_600_000) {
				state.alertedAt = Date.now();
				notifyDesktop("DeepSeek Harness API shadowed", failed.map((f) => `${f.path}: ${f.reason}`).join("; "));
			}
		} else if (previous === false) {
			record("info", "API healthy again");
			state.failures = 0;
		}

		state.last = { ok, at: Date.now(), origin, checks };
		return state.last;
	};

	// A status route so the UI (or a human with curl) can ask what is wrong.
	let disposeRoute;
	try {
		disposeRoute = ctx.webServer.register({
			kind: "exact",
			path: STATUS_PATH,
			handler: (req, res) => {
				if (req.method !== "GET" && req.method !== "HEAD") {
					res.writeHead(405, { allow: "GET, HEAD", "content-type": "application/json" });
					res.end(JSON.stringify({ error: "read only" }));
					return;
				}
				const payload = {
					ok: state.last?.ok ?? null,
					uptimeMs: Date.now() - startedAt,
					failures: state.failures,
					last: state.last,
					log: state.history.slice(-20),
				};
				res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
				res.end(JSON.stringify(payload));
			},
		});
	} catch (error) {
		record("warn", `could not register ${STATUS_PATH}: ${error?.message ?? error}`);
	}

	let timer;
	let kick;
	try {
		timer = setInterval(() => {
			check().catch((error) => record("warn", `probe failed: ${error?.message ?? error}`));
		}, intervalMs);
		timer.unref?.();
		// Let the composition finish mounting before the first verdict.
		kick = setTimeout(() => {
			check().catch((error) => record("warn", `first probe failed: ${error?.message ?? error}`));
		}, 1_500);
		kick.unref?.();
	} catch (error) {
		record("warn", `could not start probe timer: ${error?.message ?? error}`);
	}

	record("info", `harness-guard watching ${PROBES.map((p) => p.path).join(", ")} every ${Math.round(intervalMs / 1000)}s`);

	return () => {
		if (timer) clearInterval(timer);
		if (kick) clearTimeout(kick);
		disposeRoute?.();
	};
}

export default { name, inject, apply };
