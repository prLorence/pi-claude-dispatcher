/**
 * Vault write lock (R12): one lock file serialises vault writes across
 * processes, with a guarded stale-lock takeover. No Pi imports and no local
 * imports, so this module can be tested and reused alone.
 */
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

const DEFAULT_STALE_MS = 600_000;
const DEFAULT_WAIT_MS = 10_000;
const DEFAULT_POLL_MS = 40;
const LOCK_NAME = "agent-vault.lock";

export class LockBusyError extends Error {
	code = "LOCK_BUSY" as const;

	constructor(message: string) {
		super(message);
		this.name = "LockBusyError";
	}
}

export interface LockOptions {
	staleMs?: number;
	waitMs?: number;
	pollMs?: number;
	now?: () => number;
	pidAlive?: (pid: number, host: string) => boolean;
	hook?: { afterStaleCheck?: () => void | Promise<void> };
}

interface Resolved {
	staleMs: number;
	waitMs: number;
	pollMs: number;
	now: () => number;
	pidAlive: (pid: number, host: string) => boolean;
}

interface LockRecord {
	pid: number;
	host: string;
	started: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const errnoCode = (err: unknown): string | undefined => (err as NodeJS.ErrnoException).code;

const isLockRecord = (v: unknown): v is LockRecord => {
	if (typeof v !== "object" || v === null) return false;
	const r = v as Record<string, unknown>;
	return (
		typeof r.pid === "number" &&
		Number.isInteger(r.pid) &&
		r.pid > 0 &&
		typeof r.host === "string" &&
		typeof r.started === "number"
	);
};

/** A pid on another host cannot be checked here, so it counts as alive. */
const defaultPidAlive = (pid: number, host: string): boolean => {
	if (host !== hostname()) return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return errnoCode(err) === "EPERM";
	}
};

const mtimeOf = (file: string): number | undefined => {
	try {
		return statSync(file).mtimeMs;
	} catch {
		return undefined;
	}
};

/** Create `file` with its full content in one exclusive, synchronous write. */
const createExclusive = (file: string, rec: LockRecord): boolean => {
	try {
		writeFileSync(file, JSON.stringify(rec), { flag: "wx" });
		return true;
	} catch (err) {
		if (errnoCode(err) === "EEXIST") return false;
		throw err;
	}
};

/**
 * Stale or busy, decided from the lock's own record. A file that cannot be read
 * or parsed says nothing, so only its age can make it stale.
 */
const lockState = (lock: string, o: Resolved): "stale" | "busy" => {
	try {
		const rec: unknown = JSON.parse(readFileSync(lock, "utf8"));
		if (isLockRecord(rec)) {
			if (o.now() - rec.started > o.staleMs) return "stale";
			return o.pidAlive(rec.pid, rec.host) ? "busy" : "stale";
		}
	} catch {
		// unreadable or unparseable: fall through to the mtime rule
	}
	const mtime = mtimeOf(lock);
	if (mtime === undefined) return "busy";
	return o.now() - mtime > o.staleMs ? "stale" : "busy";
};

/** A break file left by a process that crashed while holding it. */
const clearStaleBreak = (breakFile: string, o: Resolved): void => {
	const mtime = mtimeOf(breakFile);
	if (mtime !== undefined && o.now() - mtime > o.staleMs) rmSync(breakFile, { force: true });
};

/**
 * Take over a stale lock, guarded by `<lock>.break`: only the process holding
 * the break file may remove the lock, and only after re-checking it is still
 * stale. A fresh lock created by a slower racer is therefore never removed.
 */
const takeOver = (lock: string, breakFile: string, record: () => LockRecord, o: Resolved): boolean => {
	clearStaleBreak(breakFile, o);
	if (!createExclusive(breakFile, record())) return false;
	try {
		if (lockState(lock, o) !== "stale") return false;
		rmSync(lock, { force: true });
		return createExclusive(lock, record());
	} finally {
		rmSync(breakFile, { force: true });
	}
};

const runHeld = async <T>(lock: string, fn: () => T | Promise<T>): Promise<T> => {
	try {
		return await fn();
	} finally {
		rmSync(lock, { force: true });
	}
};

export async function withLock<T>(vaultDir: string, fn: () => T | Promise<T>, opts: LockOptions = {}): Promise<T> {
	const o: Resolved = {
		staleMs: opts.staleMs ?? DEFAULT_STALE_MS,
		waitMs: opts.waitMs ?? DEFAULT_WAIT_MS,
		pollMs: opts.pollMs ?? DEFAULT_POLL_MS,
		now: opts.now ?? Date.now,
		pidAlive: opts.pidAlive ?? defaultPidAlive,
	};
	const lock = join(vaultDir, ".git", LOCK_NAME);
	const breakFile = `${lock}.break`;
	const record = (): LockRecord => ({ pid: process.pid, host: hostname(), started: o.now() });
	// The wait budget is real time; opts.now() only stamps and ages lock records.
	const deadline = Date.now() + o.waitMs;
	let hooked = false;

	for (;;) {
		if (createExclusive(lock, record())) return await runHeld(lock, fn);
		if (lockState(lock, o) === "stale") {
			if (!hooked && opts.hook?.afterStaleCheck) {
				hooked = true;
				await opts.hook.afterStaleCheck();
			}
			if (takeOver(lock, breakFile, record, o)) return await runHeld(lock, fn);
		}
		if (Date.now() >= deadline) throw new LockBusyError(`vault is locked: ${lock}`);
		await sleep(o.pollMs);
	}
}
