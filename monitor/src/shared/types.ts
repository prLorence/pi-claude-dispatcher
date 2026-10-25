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
export interface DeciderTaskView {
  suggested: string; // "low" | "high" | "max"
  probabilities: Record<string, number>;
  confidence: number | null;
  complexity: number | null;
  ran: string | null; // thinking of the task's first task.start, null before it starts
}
export interface DeciderAuditView {
  proposal: string; // "approve" | "hold" | "dismiss" | "fix"
  aggregate: number;
  verdict: string; // "pass" | "fail"
  auditRound: number;
  findings: { id: string; severity: string; p: number }[];
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
  decider: DeciderTaskView | null; // null when the trace has no decision.effort event
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
  audit: DeciderAuditView | null; // null when the trace has no decision.audit event
}
export interface RepoView {
  name: string;
  active: boolean; // the repo has a plan in running/
  plan: PlanView | null; // the running plan, else the latest finished one
  message: string | null; // why there is no plan, or why the folder cannot be read
  startedAt: string | null; // ISO ts of the shown plan's first event (orders active repos)
  lastActivity: string | null; // ISO ts of the shown plan's last event
}
export interface MonitorState {
  repos: RepoView[]; // active first (newest startedAt first), then idle by lastActivity, newest first
  message: string | null; // a note about the configuration, for example repos ignored over the cap
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
