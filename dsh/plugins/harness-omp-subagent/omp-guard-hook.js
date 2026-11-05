/**
 * omp hook adapter: enforce harness-dispatch's worker guard inside an `omp`
 * child process.
 *
 * The guard is a pure policy (`checkToolCall`) that the dispatcher enforces for
 * in-process children through `ctx.tools.guard`. An `omp` child runs in another
 * process with no access to that scope, so before this file existed the policy
 * was simply not applied: `runCli` exported PI_PLAN_DISPATCH_GUARD into the
 * child's environment and nothing ever read it. Verified by running a read-only
 * role with a writable tool set — the write succeeded.
 *
 * omp loads hook modules with `--hook`, so the policy crosses the process
 * boundary here instead of decaying. The decision logic is not reimplemented:
 * this imports the same `guard.js` the parent uses, so the two cannot drift.
 *
 * Failure is closed. omp blocks a tool call when its hook throws, so a broken
 * or missing policy must not look like "allow everything".
 */
import { checkToolCall } from "../harness-dispatch/guard.js";

const GUARD_ENV = "PI_PLAN_DISPATCH_GUARD";
const VAULT_ENV = "PI_PLAN_DISPATCH_VAULT";

/**
 * Read the policy the parent exported.
 *
 * @returns the policy, `undefined` when the parent set none (an unguarded run),
 *   or `null` when the variable is present but unusable.
 */
function readPolicy() {
	const raw = process.env[GUARD_ENV];
	if (raw === undefined || raw === "") return undefined;
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const files = Array.isArray(parsed.files) ? parsed.files.filter((f) => typeof f === "string") : [];
	const vault = process.env[VAULT_ENV];
	return {
		cwd: process.cwd(),
		files,
		bash: parsed.bash === true,
		readonly: parsed.readonly === true,
		...(vault ? { vault } : {}),
	};
}

export default function harnessGuard(pi) {
	pi.on("tool_call", async (event) => {
		const policy = readPolicy();
		// No policy: the parent did not ask for one, so this run is unguarded.
		if (policy === undefined) return undefined;
		// A policy was requested but cannot be read. Refusing is the only safe
		// reading; allowing would silently downgrade a guarded run.
		if (policy === null) {
			return { block: true, reason: "BLOCKED by harness-dispatch: the worker guard policy in PI_PLAN_DISPATCH_GUARD is not valid JSON." };
		}
		const decision = checkToolCall(policy, event.toolName, event.input);
		return decision.block ? { block: true, reason: decision.reason } : undefined;
	});
}
