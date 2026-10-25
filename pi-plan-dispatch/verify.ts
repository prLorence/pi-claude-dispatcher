/**
 * Independent verification of worker claims (G1).
 *
 * The dispatcher, never the worker, runs `verify:` commands. No Pi imports and
 * no local imports, so this module can be tested and reused alone.
 */
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { resolve } from "node:path";

/** Tail of stdout+stderr kept in a result (and shown to the worker on retry). */
export const VERIFY_OUTPUT_TAIL = 4000;

/** Cap on the in-flight buffer, so a chatty command cannot eat memory. */
const BUFFER_CAP = VERIFY_OUTPUT_TAIL * 4;

/** Grace between SIGTERM and SIGKILL when killing the process group. */
const KILL_GRACE_MS = 3000;
/** Last resort: stop waiting for the child this long after SIGKILL. */
const REAP_GRACE_MS = 2000;
/**
 * Grace after the shell's own exit, so output still in the pipes arrives, but a
 * background child cannot keep the verify open by holding them.
 */
const EXIT_GRACE_MS = 1000;

export interface VerifyResult {
	ok: boolean;
	code: number | null;
	timedOut: boolean;
	durationMs: number;
	output: string;
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The environment of the verify child: no AGENT_VAULT, no OPENROUTER_API_KEY,
 * and marked as a worker so the vault CLI refuses every command.
 */
const verifyEnv = (): NodeJS.ProcessEnv => {
	const env = { ...process.env };
	delete env.AGENT_VAULT;
	// A verify child never gets the decision-model key.
	delete env.OPENROUTER_API_KEY;
	env.PI_PLAN_DISPATCH_WORKER = "1";
	return env;
};

const isDirectory = (p: string) => {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
};

/** Run `sh -c <command>` in `cwd`; exit 0 means verified. */
export function runVerify(cwd: string, command: string, timeoutMinutes: number, signal?: AbortSignal): Promise<VerifyResult> {
	const started = Date.now();
	return new Promise((resolvePromise) => {
		let output = "";
		let settled = false;
		let timedOut = false;
		let exited = false;
		let exitCode: number | null = null;
		let escalate: NodeJS.Timeout | undefined;
		let reap: NodeJS.Timeout | undefined;
		let timeout: NodeJS.Timeout | undefined;
		let exitGrace: NodeJS.Timeout | undefined;

		const collect = (chunk: Buffer | string) => {
			output += chunk.toString();
			if (output.length > BUFFER_CAP) output = output.slice(-VERIFY_OUTPUT_TAIL);
		};

		const settle = (code: number | null, timedOut: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			clearTimeout(escalate);
			clearTimeout(reap);
			clearTimeout(exitGrace);
			signal?.removeEventListener("abort", onAbort);
			resolvePromise({
				ok: !timedOut && code === 0,
				code,
				timedOut,
				durationMs: Date.now() - started,
				output: output.slice(-VERIFY_OUTPUT_TAIL),
			});
		};

		// detached puts the child in its own process group, so a kill also takes
		// down whatever `sh -c` started (a backgrounded verify, a shell pipeline).
		const proc = spawn("sh", ["-c", command], {
			cwd,
			env: verifyEnv(),
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});

		const killGroup = (sig: NodeJS.Signals) => {
			if (proc.pid === undefined) return;
			try {
				process.kill(-proc.pid, sig);
			} catch {
				// Already gone (or never started).
			}
		};

		const terminate = (why: "timeout" | "abort") => {
			if (settled) return;
			clearTimeout(timeout);
			killGroup("SIGTERM");
			escalate = setTimeout(() => {
				killGroup("SIGKILL");
				reap = setTimeout(() => settle(null, why === "timeout"), REAP_GRACE_MS);
			}, KILL_GRACE_MS);
		};

		// 0 (or less) means no timeout at all; a timer at 0 would fire at once.
		if (timeoutMinutes > 0) {
			timeout = setTimeout(() => {
				timedOut = true;
				terminate("timeout");
			}, timeoutMinutes * 60_000);
		}

		const onAbort = () => terminate("abort");
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });

		proc.stdout?.on("data", collect);
		proc.stderr?.on("data", collect);
		proc.on("error", (err) => {
			collect(`${err.message}\n`);
			settle(null, timedOut);
		});

		// Settle on the shell's exit, not only on `close`: a background child that
		// keeps the pipes open would otherwise hold the verify for its whole life.
		// Killing the group here also stops that child from outliving the verify.
		proc.on("exit", (code) => {
			if (settled || exited) return;
			exited = true;
			exitCode = code;
			killGroup("SIGTERM");
			exitGrace = setTimeout(() => {
				killGroup("SIGKILL");
				settle(exitCode, timedOut);
			}, EXIT_GRACE_MS);
		});
		proc.on("close", (code) => {
			if (!exited) {
				exited = true;
				exitCode = code;
			}
			settle(exitCode, timedOut);
		});
	});
}

/** Promise-chain mutex: callbacks run one at a time, in call order. */
export function createVerifyLock(): <T>(fn: () => Promise<T>) => Promise<T> {
	let tail: Promise<unknown> = Promise.resolve();
	return <T>(fn: () => Promise<T>): Promise<T> => {
		const run = tail.then(() => fn());
		tail = run.catch(() => undefined);
		return run;
	};
}

/** True when the executable of `command` can be found. */
export function commandExists(cwd: string, command: string): boolean {
	let rest = command.trim();
	let dir = cwd;

	const cd = /^cd\s+("[^"]+"|'[^']+'|\S+)\s*&&\s*/.exec(rest);
	if (cd) {
		const target = resolve(cwd, cd[1].replace(/^["']|["']$/g, ""));
		// Only prelude's effect on relative paths matters; a missing dir is not a
		// reason to call a perfectly good executable missing.
		if (isDirectory(target)) dir = target;
		rest = rest.slice(cd[0].length);
	}

	const words = rest.split(/\s+/).filter(Boolean);
	let i = 0;
	while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
	const exe = words[i];
	if (!exe) return false;

	if (exe.includes("/")) {
		try {
			accessSync(resolve(dir, exe), constants.X_OK);
			return true;
		} catch {
			return false;
		}
	}

	const found = spawnSync("sh", ["-c", `command -v ${quote(exe)}`], { cwd: dir, stdio: "ignore" });
	return found.status === 0;
}

/** Text for the retry prompt: what ran, how it ended, and the output tail. */
export function verifyFeedback(command: string, r: VerifyResult): string {
	const head = r.timedOut
		? `Independent verification timed out: ${command}`
		: `Independent verification failed (exit code ${r.code ?? "none"}): ${command}`;
	const tail = r.output.trim();
	return tail ? `${head}\nOutput (last ${VERIFY_OUTPUT_TAIL} chars):\n${tail}` : `${head}\nIt printed no output.`;
}
