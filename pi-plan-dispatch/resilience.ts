/**
 * Resilience of worker runs: telling a transient provider or network failure
 * from a real one, the backoff schedule, a plan-level outage gate with a
 * network probe, a stall tracker for a silent JSON stream, and the resume loop
 * that reopens the same Pi session after a transient error.
 *
 * Pure by design: no Pi imports and no local imports, and every clock, sleep,
 * probe and fetch is injected, so the whole module is tested without waiting
 * and without touching the network.
 */

export type ErrorClass = "transient" | "permanent";

/** Last backoff step and the answer of `backoffSeconds` for an unusable list. */
export const DEFAULT_BACKOFF_SECONDS = 15;

/** Default probe timeout: one request must answer within this. */
export const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

/**
 * The prompt of a resumed attempt (spec R2). It is the original conversation,
 * reopened, so the worker is told to carry on rather than to start over.
 */
export const CONTINUE_PROMPT =
	"Your previous request stopped because of a network or provider error before you finished. Carry on from where you stopped; read the files again if you are unsure what is already done.";

/**
 * Permanent markers win over the transient patterns: a verification failure or
 * an exhausted timeout is a real result, never a network blip. `aborted` and
 * `stop reason: aborted` count only as the whole text, because `aborted` sits
 * inside `ECONNABORTED`, which is a transient network error.
 */
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

/**
 * An HTTP status of 429, 502, 503, 504 or 529 counts only as a standalone
 * number: `429: {...}` is the form Pi really reports, while a stack-trace
 * position like `index.ts:502:7` must not classify the run as transient.
 */
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

/** `terminated` is undici's mid-stream drop; only as the whole text it is safe. */
const TRANSIENT_EXACT = ["terminated"];

/**
 * Whether a failure is worth another attempt. Transient means the provider or
 * the network dropped the run; everything else is a real failure and keeps the
 * ordinary retry-or-fail path.
 */
export function classifyError(text: string): ErrorClass {
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

/**
 * Seconds to wait before resume number `resume` (1-based). Past the end of the
 * list the last value repeats, so a long outage backs off at its final step.
 */
export function backoffSeconds(list: number[], resume: number): number {
	const valid = Array.isArray(list) ? list.filter((v) => typeof v === "number" && Number.isFinite(v) && v > 0) : [];
	if (valid.length === 0) return DEFAULT_BACKOFF_SECONDS;
	const step = Number.isFinite(resume) ? Math.floor(resume) : 1;
	const index = Math.min(Math.max(step - 1, 0), valid.length - 1);
	return valid[index];
}

/**
 * The network is up when any probe URL answers with any HTTP status: a 500 from
 * the provider still proves the connection works. A throw, an abort or a
 * timeout counts as no answer.
 */
export async function probeUrls(
	urls: string[],
	timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
	fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
	const list = Array.isArray(urls) ? urls.filter((u) => typeof u === "string" && u.length > 0) : [];
	if (list.length === 0) return false;
	const attempts = list.map((url) => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
		return fetchImpl(url, { method: "GET", signal: controller.signal, redirect: "manual" }).then(
			() => true,
			() => false,
		).finally(() => clearTimeout(timer));
	});
	return new Promise<boolean>((resolve) => {
		let pending = attempts.length;
		for (const attempt of attempts) {
			void attempt.then((answered) => {
				if (answered) resolve(true);
				else if (--pending === 0) resolve(false);
			});
		}
	});
}

export interface OutageGateOptions {
	/** Give up after this long without a healthy probe. */
	pauseMs: number;
	/** Wait this long between probes while the gate is open. */
	probeMs: number;
	/** True when the network answers. */
	probe: () => Promise<boolean>;
	now?: () => number;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	onStart?: (reason: string) => void;
	onEnd?: (durationMs: number, outcome: "healthy" | "gave-up") => void;
}

/** Why a `wait` returned: continue, give up, or the run was stopped. */
export type GateOutcome = "clear" | "gave-up" | "aborted";

type Waiter = (outcome: GateOutcome) => void;

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise<void>((resolve) => {
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

/**
 * A plan-level gate for a network outage: the first transient error opens it,
 * a probe runs every `probeMs`, a healthy probe closes it and everything
 * continues, and `pauseMs` without one gives up so the waiting tasks fail
 * through the ordinary path. All time comes from `now` and `sleep`.
 */
export class OutageGate {
	private openState = false;
	private startedAt = 0;
	/** Bumped whenever the state flips, so a stale probe loop stops itself. */
	private gen = 0;
	private loopingFor: number | undefined = undefined;
	private readonly pauseMs: number;
	private readonly probeMs: number;
	private readonly probe: () => Promise<boolean>;
	private readonly now: () => number;
	private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
	private readonly onStart: ((reason: string) => void) | undefined;
	private readonly onEnd: ((durationMs: number, outcome: "healthy" | "gave-up") => void) | undefined;
	private readonly waiters = new Set<Waiter>();
	private readonly flipWaiters = new Set<() => void>();

	constructor(opts: OutageGateOptions) {
		this.pauseMs = opts.pauseMs;
		this.probeMs = opts.probeMs;
		this.probe = opts.probe;
		this.now = opts.now ?? Date.now;
		this.sleep = opts.sleep ?? defaultSleep;
		this.onStart = opts.onStart;
		this.onEnd = opts.onEnd;
	}

	get open(): boolean {
		return this.openState;
	}

	/** Note a transient failure: opens the gate if closed and starts probing. */
	report(reason: string): void {
		if (this.openState) return;
		this.openState = true;
		this.startedAt = this.now();
		this.gen++;
		this.onStart?.(reason);
		this.resolveFlipWaiters();
		this.startLoop();
	}

	/**
	 * Resolves at once when the gate is closed, otherwise when a probe is
	 * healthy (`"clear"`), when the outage outlives `pauseMs` (`"gave-up"`) or
	 * when the run is stopped (`"aborted"`).
	 */
	async wait(signal?: AbortSignal): Promise<GateOutcome> {
		if (!this.openState) return "clear";
		if (signal?.aborted) return "aborted";
		return new Promise<GateOutcome>((resolve) => {
			const waiter: Waiter = (outcome) => {
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

	/** Resolves the next time `open` flips. */
	async changed(): Promise<void> {
		return new Promise<void>((resolve) => {
			this.flipWaiters.add(resolve);
		});
	}

	/** Stop probing and let every waiter go; used at plan end and on stop. */
	close(): void {
		this.openState = false;
		this.gen++;
		this.loopingFor = undefined;
		this.release("aborted");
		this.resolveFlipWaiters();
	}

	private startLoop(): void {
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

	/** Close the gate with an outcome and tell the callers and the waiters. */
	private finish(outcome: "healthy" | "gave-up"): void {
		const durationMs = Math.max(0, this.now() - this.startedAt);
		this.openState = false;
		this.gen++;
		this.loopingFor = undefined;
		this.onEnd?.(durationMs, outcome);
		this.release(outcome === "healthy" ? "clear" : "gave-up");
		this.resolveFlipWaiters();
	}

	private release(outcome: GateOutcome): void {
		for (const waiter of [...this.waiters]) waiter(outcome);
	}

	private resolveFlipWaiters(): void {
		for (const resolve of [...this.flipWaiters]) resolve();
		this.flipWaiters.clear();
	}
}

/**
 * Did the worker go silent? Every event of Pi's JSON stream touches the
 * tracker, and a tool call in flight never counts as a stall: a long build or a
 * `npm test` must not be killed.
 */
export class StallTracker {
	private readonly stallMs: number;
	private readonly now: () => number;
	private last: number;
	private readonly inFlight = new Set<string>();

	constructor(opts: { stallMs: number; now?: () => number }) {
		this.stallMs = opts.stallMs;
		this.now = opts.now ?? Date.now;
		this.last = this.now();
	}

	touch(): void {
		this.last = this.now();
	}

	toolStart(id: string): void {
		this.inFlight.add(id);
		this.touch();
	}

	/** An unknown id is ignored: the end of a tool we never saw start. */
	toolEnd(id: string): void {
		this.inFlight.delete(id);
		this.touch();
	}

	stalled(): boolean {
		return this.stallMs > 0 && this.inFlight.size === 0 && this.idleMs >= this.stallMs;
	}

	get idleMs(): number {
		return Math.max(0, this.now() - this.last);
	}

	get toolsInFlight(): number {
		return this.inFlight.size;
	}
}

/** The least a run has to report to be resumed. */
export interface ResumableResult {
	ok: boolean;
	error?: string;
	cost: number;
	tokens?: { input: number; output: number; total: number };
	tools?: unknown[];
}

export interface ResumeOptions<R extends ResumableResult> {
	/** One worker run; `null` for the first, `resume` 1-based afterwards. */
	run: (info: { resume: number; continueSession: boolean } | null) => Promise<R>;
	/** Is there a session file on disk to reopen (`r.session?.file`)? */
	hasSession: (r: R) => boolean;
	gate: OutageGate;
	/** A per-call limit: one attempt, or one reviewer run. */
	maxResumes: number;
	backoff: number[];
	signal: AbortSignal;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	onResume?: (i: { resume: number; waitSec: number; error: string }) => void;
}

/**
 * Run once and, while a transient failure repeats, back off, wait for the
 * outage gate and run again with the same session. The returned result is the
 * last run's, with cost, tokens and tools summed over all runs of this call.
 */
export async function runWithResume<R extends ResumableResult>(
	o: ResumeOptions<R>,
): Promise<R & { resumes: number }> {
	const sleep = o.sleep ?? defaultSleep;
	let resumes = 0;
	let cost = 0;
	let tokens: { input: number; output: number; total: number } | undefined;
	const tools: unknown[] = [];
	let sawTools = false;

	const tally = (r: R) => {
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
