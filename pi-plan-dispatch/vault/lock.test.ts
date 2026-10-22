/** Run with: cd pi-plan-dispatch && node --test vault/lock.test.ts (Node 24+) */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { LockBusyError, withLock } from "./lock.ts";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const withTmp = async (fn: (dir: string, lock: string) => Promise<void>): Promise<void> => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-vault-lock-"));
	fs.mkdirSync(path.join(dir, ".git"));
	try {
		await fn(dir, path.join(dir, ".git", "agent-vault.lock"));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
};

const writeLock = (lock: string, rec: { pid: number; host?: string; started: number }): void => {
	fs.writeFileSync(lock, JSON.stringify({ pid: rec.pid, host: rec.host ?? os.hostname(), started: rec.started }));
};

const waitFor = async (pred: () => boolean, ms = 2000): Promise<void> => {
	const until = Date.now() + ms;
	while (!pred()) {
		if (Date.now() > until) throw new Error("waitFor timed out");
		await sleep(5);
	}
};

/** A pid that is certainly dead: a child process that already exited. */
const deadPid = (): number => {
	const res = spawnSync(process.execPath, ["-e", "0"]);
	assert.equal(res.status, 0);
	return res.pid;
};

const assertBusy = async (run: () => Promise<unknown>): Promise<number> => {
	const start = Date.now();
	await assert.rejects(run, (err: unknown) => {
		assert.ok(err instanceof LockBusyError, `expected LockBusyError, got ${String(err)}`);
		assert.equal(err.code, "LOCK_BUSY");
		return true;
	});
	return Date.now() - start;
};

test("withLock: returns fn's value and releases the lock", async () => {
	await withTmp(async (dir, lock) => {
		const value = await withLock(dir, () => 42);
		assert.equal(value, 42);
		assert.equal(fs.existsSync(lock), false, "lock is gone after fn");
		assert.equal(fs.existsSync(`${lock}.break`), false);

		const seen = await withLock(dir, () => fs.existsSync(lock));
		assert.equal(seen, true, "the lock exists while fn runs");
	});
});

test("withLock: releases the lock when fn throws", async () => {
	await withTmp(async (dir, lock) => {
		await assert.rejects(
			() =>
				withLock(dir, () => {
					throw new Error("boom");
				}),
			/boom/,
		);
		assert.equal(fs.existsSync(lock), false, "lock is gone after a throw");
		assert.equal(await withLock(dir, () => "after"), "after", "the lock can be taken again");
	});
});

test("withLock: a held lock gives LockBusyError after waitMs", async () => {
	await withTmp(async (dir, lock) => {
		let release!: () => void;
		const holder = withLock(dir, () => new Promise<void>((resolve) => (release = resolve)));
		await waitFor(() => fs.existsSync(lock));

		const waited = await assertBusy(() => withLock(dir, () => "second", { waitMs: 60, pollMs: 5 }));
		assert.ok(waited >= 55, `waited ${waited}ms`);

		release();
		await holder;
		assert.equal(fs.existsSync(lock), false);
	});
});

test("withLock: two concurrent callers run one after the other", async () => {
	await withTmp(async (dir) => {
		const events: string[] = [];
		const first = withLock(dir, async () => {
			events.push("a-start");
			await sleep(60);
			events.push("a-end");
		});
		await sleep(10);
		const second = withLock(
			dir,
			() => {
				events.push("b-start");
				events.push("b-end");
			},
			{ pollMs: 5 },
		);
		await Promise.all([first, second]);
		assert.deepEqual(events, ["a-start", "a-end", "b-start", "b-end"]);
	});
});

test("withLock: a lock with a dead pid is taken over", async () => {
	await withTmp(async (dir, lock) => {
		writeLock(lock, { pid: deadPid(), started: Date.now() });
		const ran = await withLock(dir, () => "took over", { waitMs: 1000, pollMs: 5 });
		assert.equal(ran, "took over");
		assert.equal(fs.existsSync(lock), false);
		assert.equal(fs.existsSync(`${lock}.break`), false, "the break file is gone at the end");
	});
});

test("withLock: a lock older than staleMs is taken over", async () => {
	await withTmp(async (dir, lock) => {
		const base = 1_000_000;
		writeLock(lock, { pid: process.pid, started: base });
		const ran = await withLock(dir, () => "fresh", {
			now: () => base + 600_001,
			staleMs: 600_000,
			waitMs: 1000,
			pollMs: 5,
		});
		assert.equal(ran, "fresh");
		assert.equal(fs.existsSync(lock), false);
		assert.equal(fs.existsSync(`${lock}.break`), false, "the break file is gone at the end");
	});
});

test("withLock: a fresh lock held by a live pid is not taken over", async () => {
	await withTmp(async (dir, lock) => {
		const content = JSON.stringify({ pid: process.pid, host: os.hostname(), started: Date.now() });
		fs.writeFileSync(lock, content);
		await assertBusy(() => withLock(dir, () => "should not run", { waitMs: 80, pollMs: 5 }));
		assert.equal(fs.readFileSync(lock, "utf8"), content, "the fresh lock is untouched");
		assert.equal(fs.existsSync(`${lock}.break`), false);

		// A pid on another host cannot be checked here, so it counts as alive.
		const remote = JSON.stringify({ pid: 999_999, host: "another-host", started: Date.now() });
		fs.writeFileSync(lock, remote);
		await assertBusy(() => withLock(dir, () => "should not run", { waitMs: 80, pollMs: 5 }));
		assert.equal(fs.readFileSync(lock, "utf8"), remote);
	});
});

test("withLock: an old break file does not block a stale takeover", async () => {
	await withTmp(async (dir, lock) => {
		const staleMs = 1000;
		const old = Date.now() - staleMs * 2;
		writeLock(lock, { pid: deadPid(), started: old });
		fs.writeFileSync(`${lock}.break`, "{}");
		fs.utimesSync(`${lock}.break`, new Date(old), new Date(old));

		const ran = await withLock(dir, () => "took over", { staleMs, waitMs: 1000, pollMs: 5 });
		assert.equal(ran, "took over");
		assert.equal(fs.existsSync(lock), false);
		assert.equal(fs.existsSync(`${lock}.break`), false, "the break file is gone at the end");
	});
});

test("withLock: a racer delayed past the takeover does not touch the fresh lock", async () => {
	await withTmp(async (dir, lock) => {
		const staleMs = 5000;
		writeLock(lock, { pid: process.pid, started: Date.now() - staleMs * 2 });

		let atHook!: () => void;
		const reachedHook = new Promise<void>((resolve) => (atHook = resolve));
		let releaseDelayed!: () => void;
		const delayedMayProceed = new Promise<void>((resolve) => (releaseDelayed = resolve));
		let holding!: () => void;
		const racerHolding = new Promise<void>((resolve) => (holding = resolve));

		let delayedStart: number | undefined;
		let racerEnd = 0;
		let lockIntactWhileHeld = false;

		// Racer B sees the stale lock first and is parked in the hook...
		const delayed = withLock(
			dir,
			() => {
				delayedStart = Date.now();
			},
			{
				staleMs,
				waitMs: 5000,
				pollMs: 5,
				hook: {
					afterStaleCheck: async () => {
						atHook();
						await delayedMayProceed;
					},
				},
			},
		);
		await reachedHook;

		// ...while racer A takes over and holds the lock.
		const racer = withLock(
			dir,
			async () => {
				holding();
				await sleep(150);
				lockIntactWhileHeld = fs.existsSync(lock);
			},
			{ staleMs, waitMs: 5000, pollMs: 5 },
		);
		await racerHolding;
		releaseDelayed();
		await racer;
		racerEnd = Date.now();
		await delayed;

		assert.equal(lockIntactWhileHeld, true, "A's lock stayed intact until A ended");
		assert.ok(delayedStart !== undefined, "the delayed racer ran");
		assert.ok(delayedStart >= racerEnd, `delayed racer started at ${delayedStart}, A ended at ${racerEnd}`);
		assert.equal(fs.existsSync(lock), false);
		assert.equal(fs.existsSync(`${lock}.break`), false, "the break file is gone at the end");
	});
});
