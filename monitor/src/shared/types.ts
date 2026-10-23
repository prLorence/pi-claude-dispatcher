export type LaneState = "waiting" | "live" | "done" | "failed" | "stalled";
export type Verdict = "approve" | "changes" | "unknown";
export interface ReviewResult {
  verdict: Verdict;
  findings: number | null;
  failed: boolean; // ok === false or verdict "unknown"
  text: string | null;
}
export interface Attempt {
  id: string; // session id
  label: string; // "a1", "a2" for implementer attempts; "r1", "r2" for review rounds
  state: LaneState;
  model: string | null;
  thinking: string | null;
  startedAt: string | null; // ISO
  elapsedS: number | null;
  tokens: number | null; // input + output
  cost: number | null; // USD
  lastTool: string | null; // "edit core.ts", "bash npm test"
  error: string | null;
  hasSession: boolean; // a session file exists, so the transcript can be opened
  review: ReviewResult | null; // reviewer attempts only
}
export interface Lane {
  state: LaneState; // state of the newest attempt, "waiting" when there is none
  attempts: Attempt[];
}
export interface TaskRow {
  id: string;
  role: string;
  pair: string | null;
  dependsOn: string[];
  waitsFor: string[]; // dependsOn not yet done, [] when skipped
  skipped: boolean; // the plan is not running and the task has no events at all
  implementer: Lane;
  reviewer: Lane | null; // null when pair is null
}
export interface PlanView {
  id: string;
  trace: string;
  round: number;
  state: "running" | "done" | "failed"; // running when in running/; else failed when plan.end gate_pass is false
  gate: "pass" | "fail" | null;
  done: number; // tasks whose latest task.end state is "done"
  total: number;
  tasks: TaskRow[];
}
export interface MonitorState {
  plan: PlanView | null;
  message: string | null;
  now: string;
}
export type EntryKind = "user" | "assistant" | "thinking" | "tool_call" | "tool_result" | "note";
export interface Entry {
  line: number; // 1-based line number in the session file
  ts: string | null;
  kind: EntryKind;
  text: string;
  collapsed: boolean; // the UI shows it folded (user prompt, thinking)
  truncated: boolean;
  tool: { name: string; args: string } | null;
  isError: boolean;
}
export interface SessionPage {
  id: string;
  live: boolean;
  ended: boolean;
  entries: Entry[];
  next: number;
}
