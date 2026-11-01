/**
 * The dispatch-time decision (R3, R4, R5, R8): one backend call per task,
 * before its first attempt, turned into a thinking level by the effort rule.
 *
 * The order is fixed: the mode must be `dispatch`, the privacy gate must say
 * the repo is `full`, then a backend must exist (an injected one, else an
 * OpenRouter one built from the key), and only then is anything sent.
 *
 * It never throws and never blocks: every failure is a `{ ok: false, reason }`
 * result, and the caller keeps the existing resolution order. The key never
 * reaches an error message, because every message passes through `redact`.
 */

import * as os from "node:os";
import { BackendError, loadKey, openRouterBackend, redact, type Backend } from "./backend.ts";
import type { DeciderConfig } from "./config.ts";
import { effortRequest, suggestEffort } from "./effort.ts";
import { mayDecide } from "./gate.ts";

export type DecideResult =
	| {
			ok: true;
			suggested: string;
			probabilities: { low: number; high: number; max: number };
			confidence: number | null;
			complexity: number | null;
			model: string | null;
			cost: number;
	  }
	| { ok: false; reason: "off" | "not-full" | "no-key" | "error"; error?: string; status?: number };

function costOf(result: { usage?: { cost?: number } }): number {
	const cost = result.usage?.cost;
	return typeof cost === "number" && Number.isFinite(cost) ? cost : 0;
}

function modelOf(result: { model?: unknown }): string | null {
	return typeof result.model === "string" ? result.model : null;
}

/** The message of an unknown thrown value, as text. */
function messageOf(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

/**
 * One dispatch-time decision for one task (R3). `off`, `apply` and a repo that
 * is not `full` give a reason without any backend call; a missing key gives
 * `no-key`; anything thrown by the backend or by the effort rule gives `error`
 * with the redacted message and, for a `BackendError`, its HTTP status.
 */
export async function decideTaskLevel({
	cfg,
	task,
	root,
	env = process.env,
	home = os.homedir(),
	backend,
}: {
	cfg: DeciderConfig;
	task: { id: string; body: string; files: string[]; role: string };
	root: string;
	env?: NodeJS.ProcessEnv;
	home?: string;
	backend?: Backend;
}): Promise<DecideResult> {
	if (cfg.effort !== "dispatch") return { ok: false, reason: "off" };
	if (!mayDecide(root, env, home)) return { ok: false, reason: "not-full" };

	let key = "";
	let chosen = backend;
	if (chosen === undefined) {
		const found = loadKey(env, home);
		if (found === null) return { ok: false, reason: "no-key" };
		key = found;
		chosen = openRouterBackend({ key, model: cfg.model, timeoutMs: cfg.timeoutMs });
	}

	try {
		const result = await chosen.ask(effortRequest(task));
		const suggestion = suggestEffort(result.answers, cfg.thresholds);
		return {
			ok: true,
			suggested: suggestion.suggested,
			probabilities: suggestion.probabilities,
			confidence: suggestion.confidence,
			complexity: suggestion.complexity,
			model: modelOf(result),
			cost: costOf(result),
		};
	} catch (error) {
		const message = redact(messageOf(error), key);
		const status = error instanceof BackendError ? error.status : undefined;
		return status === undefined
			? { ok: false, reason: "error", error: message }
			: { ok: false, reason: "error", error: message, status };
	}
}
