/**
 * The worker-adapter contract.
 *
 * An adapter hides one CLI agent (today only Pi, later `omp`) behind a small
 * surface: how to build its command line, how to read its event stream, and
 * where its session files live. The dispatcher only talks to this interface,
 * so it never has to know which agent is underneath.
 *
 * This file is types only: no imports, no runtime code.
 */

/** One decoded event from a worker's stdout stream, in a shape all agents share. */
export type AgentEvent =
	/** A tool call started; `args` is the agent's parsed input. */
	| { kind: "tool_start"; id: string; name: string; args: Record<string, unknown> }
	/** A tool call ended; `text` is the readable result, `isError` an agent error. */
	| { kind: "tool_end"; id: string; name: string; isError: boolean; text: string }
	/** The assistant finished a turn; `usage` is tokens and cost, `stopReason` why it stopped. */
	| { kind: "assistant_end"; text: string; usage: { input: number; output: number; total: number; cost: number }; stopReason: string; errorMessage: string }
	/** A line that was not structured output, kept as plain text. */
	| { kind: "plain"; text: string }
	/** Structured output the dispatcher does not track, so the stream is still alive. */
	| { kind: "progress" };

/** A named session a worker can resume later. */
export interface AgentSessionRef { id: string; dir: string; file?: string }

/** Everything needed to start one worker run. */
export interface WorkerRunSpec { model: string; thinking: string; tools: string[]; prompt: string; session?: AgentSessionRef; name: string }

/** The identifying parts a new task attempt turns into a fresh session. */
export interface SessionRequest { cwd: string; planId: string; taskId: string; attempt: number }

/** One agent CLI, reduced to the operations the dispatcher performs. */
export interface AgentAdapter {
	/** Stable adapter name, as written in a role's `agent:` field. */
	readonly name: string;
	/** The executable string to spawn for this agent. */
	command(cfg: { piCommand: string }): string;
	/** Arguments for one worker run, including the prompt. */
	workerArgs(spec: WorkerRunSpec): string[];
	/** Arguments for a no-session connectivity smoke test. */
	smokeArgs(spec: { model: string; thinking: string }): string[];
	/** Decode one stdout line into zero or more events. */
	parseLine(line: string): AgentEvent[];
	/** Build the session reference for a task attempt that has not run yet. */
	sessionFor(req: SessionRequest): AgentSessionRef;
	/** Locate the session file on disk, when the agent writes one. */
	findSessionFile(s: AgentSessionRef): string | undefined;
	/** Move a used session out of the way so it cannot be resumed again. */
	retireSession(s: AgentSessionRef): void;
	/** A shell command that reopens an existing session for a human. */
	resumeCommand(cwd: string, s: AgentSessionRef): string;
}
