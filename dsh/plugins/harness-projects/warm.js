/**
 * The warm-context cache: one entry per session directory, refreshed at most
 * once per TTL, with in-flight deduplication so a burst of prompt assemblies
 * runs one git read and one vault read, not one per request.
 */
import { inspectRepo } from "./git.js";

export function createWarmCache({ reader, budget = 1200, ttlMs = 20_000, inspect = inspectRepo, onError } = {}) {
	const entries = new Map();
	const inflight = new Map();

	const load = async (dir, force) => {
		const key = String(dir ?? "");
		const now = Date.now();
		const cached = entries.get(key);
		if (!force && cached && now - cached.at < ttlMs) return cached.value;
		if (inflight.has(key)) return inflight.get(key);
		const promise = (async () => {
			try {
				const repo = await inspect(key);
				const text = repo.root ? await reader.warmFor(repo, { budget }) : "";
				return { repo, text };
			} catch (error) {
				onError?.(error);
				return { repo: { path: key, root: null, error: "warm context unavailable", git: null }, text: "" };
			}
		})()
			.then((value) => {
				entries.set(key, { at: Date.now(), value });
				return value;
			})
			.finally(() => inflight.delete(key));
		inflight.set(key, promise);
		return promise;
	};

	return {
		/** {repo, text}; never throws. */
		get(dir, { force = false } = {}) {
			return load(dir, force);
		},
		invalidate(dir) {
			if (dir === undefined) entries.clear();
			else entries.delete(String(dir));
		},
		entries() {
			return entries;
		},
	};
}
