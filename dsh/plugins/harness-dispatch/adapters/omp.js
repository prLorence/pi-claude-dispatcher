/**
 * oh-my-pi (omp) adapter. omp is a Pi fork and emits the same JSON event
 * shapes (`tool_execution_start`, `message_end`, ...), so parsing is shared.
 *
 * omp has no `--session-id`/`--name` flags; pairing runs are one-shot and
 * read-only by default. The `x-opencode-session` header is added by omp for
 * `opencode-go` (see docs/omp-opencode.md).
 */
import { piAdapter } from "./pi.js";

const READONLY_TOOLS = ["read", "grep", "glob"];

function workerArgs(spec) {
	const args = ["--mode", "json", "-p", "--no-session", "--model", spec.model];
	if (spec.thinking) args.push("--thinking", spec.thinking);
	const tools = spec.readonly ? READONLY_TOOLS : spec.tools?.length ? spec.tools : [];
	if (tools.length) args.push("--tools", tools.join(","));
	args.push(spec.prompt);
	return args;
}

function smokeArgs(spec) {
	const args = ["--mode", "json", "-p", "--no-session", "--model", spec.model];
	if (spec.thinking) args.push("--thinking", spec.thinking);
	args.push("Reply with the single word OK");
	return args;
}

export const ompAdapter = {
	name: "omp",
	command: (cfg) => cfg.ompCommand || "omp",
	workerArgs,
	smokeArgs,
	parseLine: piAdapter.parseLine,
	sessionFor: () => undefined,
	findSessionFile: () => undefined,
	retireSession: () => {},
	resumeCommand: () => "",
};
