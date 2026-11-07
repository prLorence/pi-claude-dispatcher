/**
 * Host half of the Mistral subscription settings surface.
 *
 * Serves four fenced routes to the Client card:
 *
 * - GET  /plugins/mistral-subscription/state    — credential record present,
 *   attempt in flight, outcome/error of the most recent attempt.
 * - POST /plugins/mistral-subscription/sign-in  — starts one authorization
 *   attempt; the response settles when the browser URL is notified, the
 *   attempt settles, or the injected timeout fires.
 * - POST /plugins/mistral-subscription/sign-out — deletes the record.
 * - POST /plugins/mistral-subscription/cancel   — aborts the live attempt.
 *
 * FLOW REGISTRATION LIVES IN lib/index.js (apply): this module registers
 * routes only, so a reload cannot register the flow twice.
 *
 * Every handler starts with the request fence (lib/fence.js) and all three
 * POST routes require `content-type: application/json`, matched on the media
 * type so `; charset=…` passes. The key never crosses these routes: state is
 * boolean, and every answer carries a fixed code without token material.
 */

import { fenceRequest } from "./fence.js";

const STATE_PATH = "/plugins/mistral-subscription/state";
const SIGN_IN_PATH = "/plugins/mistral-subscription/sign-in";
const SIGN_OUT_PATH = "/plugins/mistral-subscription/sign-out";
const CANCEL_PATH = "/plugins/mistral-subscription/cancel";
const FLOW_KEY = "llm-pi-ai/mistral-subscription";
const DEFAULT_SIGN_IN_TIMEOUT_MS = 15_000;
/** The measured console.mistral.ai URL latency is 0.70–0.78 s. */
const POST_ONLY = { status: 405, body: { error: "POST only" } };
const UNSUPPORTED_MEDIA_TYPE = { status: 415, body: { error: "UNSUPPORTED_MEDIA_TYPE" } };

function sendJson(res, status, body) {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}

/**
 * The POST body media type from the raw content-type header. A header this
 * reader does not take (repeated, non-string) reads as undefined and fails
 * closed below — the fence's own unread-header rule, applied to the body.
 */
function mediaTypeOf(req) {
	const value = req.headers["content-type"];
	if (typeof value !== "string") return undefined;
	return value.split(";")[0].trim().toLowerCase();
}

/** Method check + POST body-type check. Returns true when the answer was written. */
function rejectsWriteRequest(req, res) {
	if (req.method !== "POST") {
		sendJson(res, POST_ONLY.status, POST_ONLY.body);
		return true;
	}
	if (mediaTypeOf(req) !== "application/json") {
		sendJson(res, UNSUPPORTED_MEDIA_TYPE.status, UNSUPPORTED_MEDIA_TYPE.body);
		return true;
	}
	return false;
}

/**
 * Drains and parses a request body. Unreadable bodies read as `{}` — the
 * routes do not read the payload, only require the media type.
 */
async function readJsonBody(stream) {
	if (stream === null || typeof stream !== "object" || typeof stream[Symbol.asyncIterator] !== "function") {
		return {};
	}
	const chunks = [];
	for await (const chunk of stream) chunks.push(chunk);
	const raw = Buffer.concat(chunks).toString("utf-8");
	if (raw.length === 0) return {};
	try {
		return JSON.parse(raw);
	} catch {
		return {};
	}
}

/**
 * Registers the four settings routes and returns their combined disposer.
 *
 * The routes share one closure so `/state`, `/sign-in` and `/cancel` see the
 * same attempt lifecycle: the last notified URL is held for a second caller
 * of a live attempt, and outcome/error are recorded PER ATTEMPT against a
 * local attempt counter (`authorized.describe` carries no attempt id).
 *
 * `opts.signInTimeoutMs` (default 15000, well above the measured 0.70–0.78 s
 * URL latency) bounds how long the sign-in caller waits; the attempt itself
 * stays in flight past that answer and `/cancel` can still abort it.
 */
export function registerWebRoutes(ctx, opts = {}) {
	const signInTimeoutMs =
		typeof opts.signInTimeoutMs === "number" && Number.isFinite(opts.signInTimeoutMs) && opts.signInTimeoutMs >= 0
			? opts.signInTimeoutMs
			: DEFAULT_SIGN_IN_TIMEOUT_MS;

	// Outcome/error of the most recent attempt, keyed by a LOCAL counter.
	let attemptCounter = 0;
	let latestAttempt = { seq: 0, outcome: null, error: null };
	// The URL of the live attempt (or the last one), held for late callers.
	let lastUrl = null;
	// Callers of a live attempt waiting for a URL that is not notified yet.
	let urlWaiters = [];

	const connection = () => Reflect.get(ctx, "connection");

	function inFlightNow() {
		try {
			return ctx.authorization.describe(FLOW_KEY)?.inFlight === true;
		} catch {
			return false;
		}
	}

	/** One URL arrived: hold it and wake every caller waiting for a URL. */
	function deliverUrl(url) {
		lastUrl = url;
		const waiters = urlWaiters;
		urlWaiters = [];
		for (const waiter of waiters) {
			try {
				waiter(url);
			} catch {}
		}
	}

	/** The held URL, or a URL the live attempt delivers within the timeout. */
	function waitForUrl(timeoutMs) {
		if (lastUrl !== null) return Promise.resolve(lastUrl);
		return new Promise((resolve) => {
			let entry;
			const timer = setTimeout(() => {
				if (entry) urlWaiters = urlWaiters.filter((waiter) => waiter !== entry);
				resolve(null);
			}, timeoutMs);
			entry = (url) => {
				clearTimeout(timer);
				resolve(url);
			};
			urlWaiters.push(entry);
			timer.unref?.();
		});
	}

	const stateRoute = {
		kind: "exact",
		path: STATE_PATH,
		handler: async (req, res) => {
			if (fenceRequest({ connection: connection() }, req, res)) return;
			let configured = false;
			try {
				const record = await ctx.credentials.readRecord(FLOW_KEY);
				configured = record !== undefined && record !== null;
			} catch {}
			sendJson(res, 200, {
				configured,
				inFlight: inFlightNow(),
				key: FLOW_KEY,
				outcome: latestAttempt.outcome,
				error: latestAttempt.error,
			});
		},
	};

	const signInRoute = {
		kind: "exact",
		path: SIGN_IN_PATH,
		handler: async (req, res) => {
			if (fenceRequest({ connection: connection() }, req, res)) return;
			if (rejectsWriteRequest(req, res)) return;
			await readJsonBody(req).catch(() => ({}));

			if (inFlightNow()) {
				// A second caller cannot begin again: hand over the held URL (or
				// wait briefly for the live attempt's URL) and leave the running
				// attempt untouched — its outcome is not this caller's to claim.
				const held = await waitForUrl(signInTimeoutMs);
				if (held !== null) {
					sendJson(res, 200, { started: true, url: held, alreadyInFlight: true });
				} else {
					sendJson(res, 200, { started: false, error: "NO_URL" });
				}
				return;
			}

			// A fresh attempt: clear its error so /state never shows a stale one.
			const record = { seq: ++attemptCounter, outcome: null, error: null };
			latestAttempt = record;

			let resolveUrl;
			const urlSeen = new Promise((resolve) => {
				resolveUrl = resolve;
			});
			// Attempt settle is a race participant, never a poll.
			const attempt = (async () => {
				try {
					const outcome = await ctx.authorization.begin({
						key: FLOW_KEY,
						interaction: {
							notify: (notification) => {
								if (notification && typeof notification.url === "string") {
									deliverUrl(notification.url);
									if (record.seq === latestAttempt.seq) resolveUrl(notification.url);
								}
							},
							prompt: () => Promise.reject(new Error("UNSUPPORTED")),
						},
					});
					record.outcome = outcome?.status ?? "unknown";
				} catch (error) {
					record.error = String(error?.code ?? error?.name ?? "error");
					record.outcome = "failed";
				}
			})();
			// The attempt keeps running past the answer below; its outcome still
			// lands on /state, and /cancel can still abort it.
			void attempt;

			const timeout = new Promise((resolve) => {
				const timer = setTimeout(() => resolve("timeout"), signInTimeoutMs);
				timer.unref?.();
			});
			const raced = await Promise.race([
				urlSeen.then(() => "url"),
				attempt.then(() => "settled"),
				timeout,
			]);

			if (raced === "timeout") {
				// Distinct error, answered ONLY by this caller. The attempt stays
				// in flight: a later notification still updates /state.
				sendJson(res, 200, { started: false, error: "SIGN_IN_TIMEOUT" });
				return;
			}
			if (raced === "url" || lastUrl !== null) {
				sendJson(res, 200, { started: true, url: lastUrl });
				return;
			}
			// The attempt settled with no URL ever notified and no attempt live:
			// surface its error code, or NO_URL when it ended without one.
			sendJson(res, 200, { started: false, error: record.error ?? "NO_URL" });
		},
	};

	const signOutRoute = {
		kind: "exact",
		path: SIGN_OUT_PATH,
		handler: async (req, res) => {
			if (fenceRequest({ connection: connection() }, req, res)) return;
			if (rejectsWriteRequest(req, res)) return;
			await readJsonBody(req).catch(() => ({}));
			try {
				await ctx.credentials.deleteRecord(FLOW_KEY);
				sendJson(res, 200, { status: "signed-out" });
			} catch (error) {
				sendJson(res, 400, { status: "failed", error: String(error?.code ?? error?.name ?? "error") });
			}
		},
	};

	const cancelRoute = {
		kind: "exact",
		path: CANCEL_PATH,
		handler: async (req, res) => {
			if (fenceRequest({ connection: connection() }, req, res)) return;
			if (rejectsWriteRequest(req, res)) return;
			await readJsonBody(req).catch(() => ({}));
			try {
				const stopped = await ctx.authorization.cancel(FLOW_KEY);
				if (stopped === false) {
					sendJson(res, 200, { cancelled: false, reason: "not_in_flight" });
				} else {
					sendJson(res, 200, { cancelled: true });
				}
			} catch (error) {
				// No key, no raw provider error: a fixed code only.
				sendJson(res, 400, { cancelled: false, error: String(error?.code ?? error?.name ?? "error") });
			}
		},
	};

	const routes = [stateRoute, signInRoute, signOutRoute, cancelRoute];
	const disposers = [];
	const registerAll = () => {
		try {
			for (const route of routes) disposers.push(ctx.webServer.register(route));
		} catch (error) {
			// A failed reload must not leak the routes registered so far.
			for (const dispose of disposers.splice(0)) {
				try {
					dispose();
				} catch {}
			}
			throw error;
		}
	};
	// Effect-scoped so a re-application disposes the routes with the plugin;
	// the fallback keeps registration working on a ctx without `effect`.
	if (typeof ctx.effect === "function") ctx.effect(registerAll);
	else registerAll();
	return () => {
		for (const dispose of disposers.splice(0)) {
			try {
				dispose();
			} catch {}
		}
	};
}
