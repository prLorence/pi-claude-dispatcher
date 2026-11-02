// Package model holds the JSON shapes the monitor client consumes.
//
// The JSON names are the TypeScript field names of monitor/src/shared/types.ts,
// so a value of this package encodes field for field to the same JSON the Bun
// server produces. A TypeScript null is a pointer (or an interface) that
// encodes to null, and every field is always encoded (no omitempty). The one
// documented exception is Entry.Code, which is left out of the JSON when
// there is no block, so an entry without a block encodes exactly as it did
// before the field existed and the frozen golden transcripts stay valid.
package model

import "time"

// LaneState is the state of one lane: waiting, live, done, failed or stalled.
type LaneState string

// Verdict is a review verdict: approve, changes or unknown.
type Verdict string

// EntryKind is the kind of one transcript entry.
type EntryKind string

// ReviewResult is the review outcome of a reviewer attempt.
type ReviewResult struct {
	Verdict  Verdict `json:"verdict"`
	Findings *int    `json:"findings"`
	Failed   bool    `json:"failed"`
	Text     *string `json:"text"`
}

// Attempt is one worker or reviewer run of a task.
type Attempt struct {
	ID         string        `json:"id"`
	Label      string        `json:"label"`
	State      LaneState     `json:"state"`
	Model      *string       `json:"model"`
	Thinking   *string       `json:"thinking"`
	StartedAt  *string       `json:"startedAt"`
	ElapsedS   *float64      `json:"elapsedS"`
	Tokens     *float64      `json:"tokens"`
	Cost       *float64      `json:"cost"`
	LastTool   *string       `json:"lastTool"`
	Error      *string       `json:"error"`
	HasSession bool          `json:"hasSession"`
	Review     *ReviewResult `json:"review"`
}

// Lane is one lane of a task: its newest state and every attempt.
type Lane struct {
	State    LaneState `json:"state"`
	Attempts []Attempt `json:"attempts"`
}

// DeciderTaskView is the decider effort view of one task.
type DeciderTaskView struct {
	Suggested     string             `json:"suggested"`
	Probabilities map[string]float64 `json:"probabilities"`
	Confidence    *float64           `json:"confidence"`
	Complexity    *float64           `json:"complexity"`
	Ran           *string            `json:"ran"`
}

// DeciderFinding is one scored plan-audit finding.
type DeciderFinding struct {
	ID       string  `json:"id"`
	Severity string  `json:"severity"`
	P        float64 `json:"p"`
}

// DeciderAuditView is the decider audit view of one plan.
type DeciderAuditView struct {
	Proposal   string           `json:"proposal"`
	Aggregate  float64          `json:"aggregate"`
	Verdict    string           `json:"verdict"`
	AuditRound int              `json:"auditRound"`
	Findings   []DeciderFinding `json:"findings"`
}

// TaskRow is one task row of a plan board.
type TaskRow struct {
	ID          string           `json:"id"`
	Role        string           `json:"role"`
	Pair        *string          `json:"pair"`
	DependsOn   []string         `json:"dependsOn"`
	WaitsFor    []string         `json:"waitsFor"`
	Skipped     bool             `json:"skipped"`
	Implementer Lane             `json:"implementer"`
	Reviewer    *Lane            `json:"reviewer"`
	Decider     *DeciderTaskView `json:"decider"`
}

// PlanView is one plan of a repo.
type PlanView struct {
	ID    string            `json:"id"`
	Trace string            `json:"trace"`
	Round int               `json:"round"`
	State string            `json:"state"`
	Gate  *string           `json:"gate"`
	Done  int               `json:"done"`
	Total int               `json:"total"`
	Tasks []TaskRow         `json:"tasks"`
	Audit *DeciderAuditView `json:"audit"`
}

// RepoView is one repo of the monitor state.
type RepoView struct {
	Name         string    `json:"name"`
	Active       bool      `json:"active"`
	Plan         *PlanView `json:"plan"`
	Message      *string   `json:"message"`
	StartedAt    *string   `json:"startedAt"`
	LastActivity *string   `json:"lastActivity"`
}

// MonitorState is the whole board the client renders.
type MonitorState struct {
	Repos   []RepoView `json:"repos"`
	Message *string    `json:"message"`
	Now     string     `json:"now"`
}

// EntryTool is the tool call attached to a transcript entry.
type EntryTool struct {
	Name string `json:"name"`
	Args string `json:"args"`
}

// CodeBlock is the code a transcript entry shows: a diff, a whole file or a
// shell command.
type CodeBlock struct {
	Kind string  `json:"kind"`
	Path *string `json:"path"`
	Text string  `json:"text"`
}

// Entry is one transcript entry.
type Entry struct {
	Line      int        `json:"line"`
	Ts        *string    `json:"ts"`
	Kind      EntryKind  `json:"kind"`
	Text      string     `json:"text"`
	Collapsed bool       `json:"collapsed"`
	Truncated bool       `json:"truncated"`
	Tool      *EntryTool `json:"tool"`
	IsError   bool       `json:"isError"`
	Code      *CodeBlock `json:"code,omitempty"`
}

// AgentSession is one coding-agent session listed in the Agents view.
type AgentSession struct {
	Agent     string   `json:"agent"`
	ID        string   `json:"id"`
	Title     string   `json:"title"`
	Model     *string  `json:"model"`
	Cwd       string   `json:"cwd"`
	Group     string   `json:"group"`
	StartedAt *string  `json:"startedAt"`
	MtimeMs   float64  `json:"mtimeMs"`
	Live      bool     `json:"live"`
	Ended     bool     `json:"ended"`
	Tokens    *float64 `json:"tokens"`
	Cost      *float64 `json:"cost"`
	LastTool  *string  `json:"lastTool"`
	Thinking  *string  `json:"thinking"`
}

// AgentGroup is a group of agent sessions, usually one repo's.
type AgentGroup struct {
	Name     string         `json:"name"`
	Sessions []AgentSession `json:"sessions"`
}

// SessionPage is one page of a session transcript.
type SessionPage struct {
	ID      string  `json:"id"`
	Live    bool    `json:"live"`
	Ended   bool    `json:"ended"`
	Entries []Entry `json:"entries"`
	Next    int     `json:"next"`
}

// ParseTime converts an ISO-8601 date-time to Unix milliseconds the way
// JavaScript's Date.parse reads it. Only the forms the fixtures and the traces
// write are ported: a date-time with optional milliseconds and a "Z" or numeric
// offset zone. JavaScript reads a date-time without a zone as local time and a
// date-only string as UTC; neither form appears in the fixtures or the traces,
// so neither is accepted and the result never depends on the host zone.
func ParseTime(s string) (int64, bool) {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return 0, false
	}
	return t.UnixMilli(), true
}
