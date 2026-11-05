/**
 * Resilience of worker runs: transient-error classification, the backoff
 * schedule, a plan-level outage gate with a network probe, a stall tracker,
 * and the same-session resume loop. Every clock, sleep, probe and fetch is
 * injected, so it is testable without waiting or touching the network.
 */

export const DEFAULT_BACKOFF_SECONDS = 15;
export const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

export const CONTINUE_PROMPT =
	"Your previous request stopped because of a network or provider error before you finished. Carry on from where you stopped; read the files again if you are unsure what is already done.";

const PERMANENT_PATTERNS = [
	"verification failed",
	"status: failed",
	"no api key",
	"timed out after",
	"context length",
	"maximum context",
	"content policy",
];
const PERMANENT_EXACT = ["aborted", "stop reason: aborted"];
const STATUS_CODE_RE = /(?<![\w:.])(429|502|503|504|529)(?![\w.]|:\d)/;
const TRANSIENT_PATTERNS = [
	"aborted due to timeout",
	"other side closed",
	"rate limit",
	"too many requests",
	"bad gateway",
	"service unavailable",
	"gateway timeout",
	"overloaded",
	"temporarily unavailable",
	"etimedout",
	"econnreset",
	"econnrefused",
	"econnaborted",
	"eai_again",
	"enotfound",
	"epipe",
	"socket hang up",
	"fetch failed",
	"network is unreachable",
	"stream ended without finish_reason",
	"cannot resolve tunnel destination",
	"acp-proxy failure",
	"stalled: no output",
];
const TRANSIENT_EXACT = ["terminated"];

export function classifyError(text) {
	if (typeof text !== "string") return "permanent";
	const s = text.trim().toLowerCase();
	if (!s) return "permanent";
	if (PERMANENT_EXACT.includes(s)) return "permanent";
	if (PERMANENT_PATTERNS.some((p) => s.includes(p))) return "permanent";
	if (TRANSIENT_EXACT.includes(s)) return "transient";
	if (STATUS_CODE_RE.test(s)) return "transient";
	if (TRANSIENT_PATTERNS.some((p) => s.includes(p))) return "transient";
	return "permanent";
}

export function backoffSeconds(list, resume) {
	const valid = Array.isArray(list) ? list.filter((v) => typeof v === "number" && Number.isFinite(v) && v > 0) : [];
	if (valid.length === 0) return DEFAULT_BACKOFF_SECONDS;
	const step = Number.isFinite(resume) ? Math.floor(resume) : 1;
	const index = Math.min(Math.max(step - 1, 0), valid.length - 1);
	return valid[index];
}

export async function probeUrls(urls, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS, fetchImpl = fetch) {
	const list = Array.isArray(urls) ? urls.filter((u) => typeof u === "string" && u.length > 0) : [];
	if (list.length === 0) return false;
	const attempts = list.map((url) => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
		return fetchImpl(url, { method: "GET", signal: controller.signal, redirect: "manual" })
			.then(() => true, () => false)
			.finally(() => clearTimeout(timer));
	});
	return new Promise((resolve) => {
		let pending = attempts.length;
		for (const attempt of attempts) {
			void attempt.then((answered) => {
				if (answered) resolve(true);
				else if (--pending === 0) resolve(false);
			});
		}
	});
}

function defaultSleep(ms, signal) {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, Math.max(0, ms));
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export class OutageGate {
	constructor(opts) {
		this.openState = false;
		this.startedAt = 0;
		this.gen = 0;
		this.loopingFor = undefined;
		this.pauseMs = opts.pauseMs;
		this.probeMs = opts.probeMs;
		this.probe = opts.probe;
		this.now = opts.now ?? Date.now;
		this.sleep = opts.sleep ?? defaultSleep;
		this.onStart = opts.onStart;
		this.onEnd = opts.onEnd;
		this.waiters = new Set();
		this.flipWaiters = new Set();
	}

	get open() {
		return this.openState;
	}

	report(reason) {
		if (this.openState) return;
		this.openState = true;
		this.startedAt = this.now();
		this.gen++;
		this.onStart?.(reason);
		this.resolveFlipWaiters();
		this.startLoop();
	}

	async wait(signal) {
		if (!this.openState) return "clear";
		if (signal?.aborted) return "aborted";
		return new Promise((resolve) => {
			const waiter = (outcome) => {
				cleanup();
				resolve(outcome);
			};
			const onAbort = () => waiter("aborted");
			const cleanup = () => {
				this.waiters.delete(waiter);
				signal?.removeEventListener("abort", onAbort);
			};
			this.waiters.add(waiter);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	async changed() {
		return new Promise((resolve) => {
			this.flipWaiters.add(resolve);
		});
	}

	close() {
		this.openState = false;
		this.gen++;
		this.loopingFor = undefined;
		this.release("aborted");
		this.resolveFlipWaiters();
	}

	startLoop() {
		if (this.loopingFor === this.gen) return;
		const gen = this.gen;
		this.loopingFor = gen;
		void (async () => {
			while (gen === this.gen && this.openState) {
				await this.sleep(this.probeMs);
				if (gen !== this.gen || !this.openState) return;
				let healthy = false;
				try {
					healthy = await this.probe();
				} catch {
					healthy = false;
				}
				if (gen !== this.gen || !this.openState) return;
				if (healthy) {
					this.finish("healthy");
					return;
				}
				if (this.now() - this.startedAt >= this.pauseMs) {
					this.finish("gave-up");
					return;
				}
			}
		})();
	}

	finish(outcome) {
		const durationMs = Math.max(0, this.now() - this.startedAt);
		this.openState = false;
		this.gen++;
		this.loopingFor = undefined;
		this.onEnd?.(durationMs, outcome);
		this.release(outcome === "healthy" ? "clear" : "gave-up");
		this.resolveFlipWaiters();
	}

	release(outcome) {
		for (const waiter of [...this.waiters]) waiter(outcome);
	}

	resolveFlipWaiters() {
		for (const resolve of [...this.flipWaiters]) resolve();
		this.flipWaiters.clear();
	}
}

export class StallTracker {
	constructor(opts) {
		this.stallMs = opts.stallMs;
		this.now = opts.now ?? Date.now;
		this.last = this.now();
		this.inFlight = new Set();
	}

	touch() {
		this.last = this.now();
	}

	toolStart(id) {
		this.inFlight.add(id);
		this.touch();
	}

	toolEnd(id) {
		this.inFlight.delete(id);
		this.touch();
	}

	stalled() {
		return this.stallMs > 0 && this.inFlight.size === 0 && this.idleMs >= this.stallMs;
	}

	get idleMs() {
		return Math.max(0, this.now() - this.last);
	}

	get toolsInFlight() {
		return this.inFlight.size;
	}
}

/**
 * Run once and, while a transient failure repeats, back off, wait for the
 * outage gate and run again with the same session.
 */
export async function runWithResume(o) {
	const sleep = o.sleep ?? defaultSleep;
	let resumes = 0;
	let cost = 0;
	let tokens;
	const tools = [];
	let sawTools = false;

	const tally = (r) => {
		cost += typeof r.cost === "number" ? r.cost : 0;
		if (r.tokens) {
			tokens = {
				input: (tokens?.input ?? 0) + r.tokens.input,
				output: (tokens?.output ?? 0) + r.tokens.output,
				total: (tokens?.total ?? 0) + r.tokens.total,
			};
		}
		if (Array.isArray(r.tools)) {
			sawTools = true;
			tools.push(...r.tools);
		}
	};

	let last = await o.run(null);
	tally(last);
	while (!last.ok && resumes < o.maxResumes && !o.signal.aborted) {
		const error = last.error ?? "";
		if (classifyError(error) !== "transient") break;
		resumes++;
		const waitSec = backoffSeconds(o.backoff, resumes);
		o.onResume?.({ resume: resumes, waitSec, error });
		o.gate.report(error);
		await sleep(waitSec * 1000, o.signal);
		if (o.signal.aborted) break;
		const outcome = await o.gate.wait(o.signal);
		if (outcome !== "clear") break;
		const previous = last;
		last = await o.run({ resume: resumes, continueSession: o.hasSession(previous) });
		tally(last);
	}

	return {
		...last,
		cost,
		...(tokens ? { tokens } : {}),
		...(sawTools ? { tools } : {}),
		resumes,
	};
}
