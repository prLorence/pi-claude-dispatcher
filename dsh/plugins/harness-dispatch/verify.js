/** G1: the dispatcher, never the worker, runs verify: commands. */
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { resolve } from "node:path";

export const VERIFY_OUTPUT_TAIL = 4000;
const BUFFER_CAP = VERIFY_OUTPUT_TAIL * 4;
const KILL_GRACE_MS = 3000;
const REAP_GRACE_MS = 2000;
const EXIT_GRACE_MS = 1000;

const quote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

/** No vault, no decision-model key, and marked as a worker so the vault CLI refuses. */
const verifyEnv = () => {
	const env = { ...process.env };
	delete env.AGENT_VAULT;
	delete env.OPENROUTER_API_KEY;
	env.PI_PLAN_DISPATCH_WORKER = "1";
	return env;
};

const isDirectory = (p) => {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
};

/** Run `sh -c <command>` in `cwd`; exit 0 means verified. */
export function runVerify(cwd, command, timeoutMinutes, signal) {
	const started = Date.now();
	return new Promise((resolvePromise) => {
		let output = "";
		let settled = false;
		let timedOut = false;
		let exited = false;
		let exitCode = null;
		let escalate;
		let reap;
		let timeout;
		let exitGrace;

		const collect = (chunk) => {
			output += chunk.toString();
			if (output.length > BUFFER_CAP) output = output.slice(-VERIFY_OUTPUT_TAIL);
		};

		const settle = (code, timedOutFlag) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			clearTimeout(escalate);
			clearTimeout(reap);
			clearTimeout(exitGrace);
			signal?.removeEventListener("abort", onAbort);
			resolvePromise({
				ok: !timedOutFlag && code === 0,
				code,
				timedOut: timedOutFlag,
				durationMs: Date.now() - started,
				output: output.slice(-VERIFY_OUTPUT_TAIL),
			});
		};

		const proc = spawn("sh", ["-c", command], {
			cwd,
			env: verifyEnv(),
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});

		const killGroup = (sig) => {
			if (proc.pid === undefined) return;
			try {
				process.kill(-proc.pid, sig);
			} catch {
				// Already gone.
			}
		};

		const terminate = () => {
			if (settled) return;
			clearTimeout(timeout);
			killGroup("SIGTERM");
			escalate = setTimeout(() => {
				killGroup("SIGKILL");
				reap = setTimeout(() => settle(null, true), REAP_GRACE_MS);
			}, KILL_GRACE_MS);
		};

		if (timeoutMinutes > 0) {
			timeout = setTimeout(() => {
				timedOut = true;
				terminate();
			}, timeoutMinutes * 60_000);
		}

		const onAbort = () => terminate();
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });

		proc.stdout?.on("data", collect);
		proc.stderr?.on("data", collect);
		proc.on("error", (err) => {
			collect(`${err.message}\n`);
			settle(null, timedOut);
		});
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
export function createVerifyLock() {
	let tail = Promise.resolve();
	return (fn) => {
		const run = tail.then(() => fn());
		tail = run.catch(() => undefined);
		return run;
	};
}

/** True when the executable of `command` can be found. */
export function commandExists(cwd, command) {
	let rest = command.trim();
	let dir = cwd;

	const cd = /^cd\s+("[^"]+"|'[^']+'|\S+)\s*&&\s*/.exec(rest);
	if (cd) {
		const target = resolve(cwd, cd[1].replace(/^["']|["']$/g, ""));
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

export function verifyFeedback(command, r) {
	const head = r.timedOut
		? `Independent verification timed out: ${command}`
		: `Independent verification failed (exit code ${r.code ?? "none"}): ${command}`;
	const tail = r.output.trim();
	return tail ? `${head}\nOutput (last ${VERIFY_OUTPUT_TAIL} chars):\n${tail}` : `${head}\nIt printed no output.`;
}
