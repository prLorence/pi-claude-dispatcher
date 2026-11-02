package lanes

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"pi-monitor/internal/model"
	"pi-monitor/internal/plans"
	"pi-monitor/internal/sessions"
)

const (
	planID        = "20261023-1458-monitor-r1"
	trace         = "20261023-1458-monitor"
	ts            = "2026-10-23T10:00:10.000Z"
	sessionFileTS = "2026-10-22T18-02-28-549Z"
)

// nowMs is the fixed clock the TypeScript test uses.
var nowMs = func() int64 {
	ms, ok := model.ParseTime("2026-10-23T10:05:00.000Z")
	if !ok {
		panic("fixed clock does not parse")
	}
	return ms
}()

func ptr[T any](value T) *T {
	return &value
}

func pairPlan() *plans.ParsedPlan {
	return &plans.ParsedPlan{
		ID:    planID,
		Trace: trace,
		Round: 1,
		Tasks: []plans.PlanTask{
			{ID: "one", Role: "implement", Pair: ptr("review"), DependsOn: []string{}},
		},
	}
}

// noSession is the summary of a session that does not exist.
func noSession() sessions.SessionSummary {
	return sessions.SessionSummary{}
}

// summary is a finished implementer session, before overrides.
func summary() sessions.SessionSummary {
	return sessions.SessionSummary{
		Exists:     true,
		Ended:      true,
		StopReason: ptr("stop"),
		StartedAt:  ptr("2026-10-23T10:00:00.000Z"),
		LastTs:     ptr("2026-10-23T10:00:30.000Z"),
		MtimeMs:    float64(nowMs - 10000),
		LastTool:   ptr("edit lanes.ts"),
		Tokens:     ptr(float64(1500)),
		Cost:       ptr(0.02),
		LastText:   ptr("the reviewer text"),
		Model:      ptr("opencode-go/beam-free"),
		Thinking:   ptr("high"),
	}
}

// withSummary is summary with the given fields changed.
func withSummary(change func(*sessions.SessionSummary)) sessions.SessionSummary {
	value := summary()
	change(&value)
	return value
}

// summarizeBy fakes the session summaries, keyed by file path.
func summarizeBy(byFile map[string]sessions.SessionSummary) func(string) sessions.SessionSummary {
	return func(file string) sessions.SessionSummary {
		if file == "" {
			return noSession()
		}
		if found, ok := byFile[file]; ok {
			return found
		}
		return noSession()
	}
}

func attemptID(suffix string) string {
	return planID + ".one." + suffix
}

func fileOf(sessionID string) string {
	return "sessions/" + planID + "/" + sessionID + ".jsonl"
}

func filesOf(sessionIDs ...string) []sessions.SessionFile {
	files := make([]sessions.SessionFile, 0, len(sessionIDs))
	for _, id := range sessionIDs {
		files = append(files, sessions.SessionFile{ID: id, File: fileOf(id)})
	}
	return files
}

func startEvent(task string, attempt int, data map[string]any) plans.TraceEvent {
	return plans.TraceEvent{
		Ts:      "2026-10-23T10:00:00.000Z",
		Kind:    "task.start",
		Plan:    ptr(planID),
		Task:    ptr(task),
		Attempt: ptr(attempt),
		Data:    data,
	}
}

func endEvent(task string, attempt int, data map[string]any) plans.TraceEvent {
	return plans.TraceEvent{
		Ts:      "2026-10-23T10:01:00.000Z",
		Kind:    "task.end",
		Plan:    ptr(planID),
		Task:    ptr(task),
		Attempt: ptr(attempt),
		Data:    data,
	}
}

func reviewEvent(task string, data map[string]any) plans.TraceEvent {
	return plans.TraceEvent{
		Ts:      "2026-10-23T10:02:00.000Z",
		Kind:    "task.review",
		Plan:    ptr(planID),
		Task:    ptr(task),
		Attempt: ptr(1),
		Data:    data,
	}
}

func planEndEvent(data map[string]any) plans.TraceEvent {
	return plans.TraceEvent{
		Ts:   "2026-10-23T10:03:00.000Z",
		Kind: "plan.end",
		Plan: ptr(planID),
		Data: data,
	}
}

// makePlansDir is the fixture folder of the monitor tests.
func makePlansDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	for _, name := range []string{"traces", "running", "done", "sessions", "inbox"} {
		if err := os.MkdirAll(filepath.Join(dir, name), 0o700); err != nil {
			t.Fatalf("mkdir %s: %v", name, err)
		}
	}
	return dir
}

// writeSession writes one session file with the given lines and mtime.
func writeSession(
	t *testing.T,
	dir, plan, sessionID string,
	lines []string,
	mtimeMs int64,
) string {
	t.Helper()
	folder := filepath.Join(dir, "sessions", plan)
	if err := os.MkdirAll(folder, 0o700); err != nil {
		t.Fatalf("mkdir sessions: %v", err)
	}
	file := filepath.Join(folder, sessionFileTS+"_"+sessionID+".jsonl")
	text := ""
	for _, line := range lines {
		text += line + "\n"
	}
	if err := os.WriteFile(file, []byte(text), 0o600); err != nil {
		t.Fatalf("write session: %v", err)
	}
	stamp := time.UnixMilli(mtimeMs)
	if err := os.Chtimes(file, stamp, stamp); err != nil {
		t.Fatalf("chtimes: %v", err)
	}
	return file
}

func mustJSON(t *testing.T, value any) string {
	t.Helper()
	line, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal fixture line: %v", err)
	}
	return string(line)
}

// sessionHeader is the first line of a Pi session file.
func sessionHeader(t *testing.T, id string) string {
	t.Helper()
	return mustJSON(t, map[string]any{"type": "session", "version": 3, "id": id})
}

// assistantMsg is an assistant message line with usage.
func assistantMsg(
	t *testing.T,
	timestamp, text, stopReason string,
	input, output, cost float64,
) string {
	t.Helper()
	message := map[string]any{
		"role":       "assistant",
		"content":    []any{map[string]any{"type": "text", "text": text}},
		"stopReason": stopReason,
		"usage": map[string]any{
			"input":  input,
			"output": output,
			"cost":   map[string]any{"total": cost},
		},
	}
	return mustJSON(t, map[string]any{
		"type":      "message",
		"timestamp": timestamp,
		"message":   message,
	})
}

func TestImplementerIsLiveWhileRecentAndStalledWhenTheFileStopsGrowing(t *testing.T) {
	dir := makePlansDir(t)
	sessionID := attemptID("a1")
	writeSession(t, dir, planID, sessionID, []string{
		sessionHeader(t, sessionID),
		assistantMsg(t, ts, "working", "toolUse", 100, 20, 0.5),
	}, nowMs-5000)
	sessionFiles := sessions.ListSessionFiles(dir, planID)
	events := []plans.TraceEvent{
		startEvent("one", 1, map[string]any{
			"session_id": sessionID,
			"model":      "opencode-go/beam-free",
			"thinking":   "high",
		}),
	}

	live := BuildPlanView(pairPlan(), true, events, sessionFiles, nowMs, nil)
	attempt := live.Tasks[0].Implementer.Attempts[0]
	if attempt.State != "live" {
		t.Fatalf("live attempt state = %q, want live", attempt.State)
	}
	if live.Tasks[0].Implementer.State != "live" {
		t.Fatalf("live lane state = %q, want live", live.Tasks[0].Implementer.State)
	}
	if !attempt.HasSession {
		t.Fatal("live attempt has no session")
	}
	if attempt.Label != "a1" {
		t.Fatalf("live attempt label = %q, want a1", attempt.Label)
	}
	if attempt.Model == nil || *attempt.Model != "opencode-go/beam-free" {
		t.Fatalf("live attempt model = %v", attempt.Model)
	}
	if attempt.Thinking == nil || *attempt.Thinking != "high" {
		t.Fatalf("live attempt thinking = %v", attempt.Thinking)
	}
	if attempt.Tokens == nil || *attempt.Tokens != 120 {
		t.Fatalf("live attempt tokens = %v, want 120", attempt.Tokens)
	}
	if attempt.Cost == nil || *attempt.Cost != 0.5 {
		t.Fatalf("live attempt cost = %v, want 0.5", attempt.Cost)
	}
	if attempt.StartedAt == nil || *attempt.StartedAt != ts {
		t.Fatalf("live attempt startedAt = %v, want %q", attempt.StartedAt, ts)
	}
	if attempt.ElapsedS == nil || *attempt.ElapsedS != 0 {
		t.Fatalf("live attempt elapsedS = %v, want 0", attempt.ElapsedS)
	}

	writeSession(t, dir, planID, sessionID, []string{
		sessionHeader(t, sessionID),
		assistantMsg(t, ts, "working", "toolUse", 0, 0, 0),
	}, nowMs-120000)
	stalled := BuildPlanView(pairPlan(), true, events, sessionFiles, nowMs, nil)
	if stalled.Tasks[0].Implementer.State != "stalled" {
		t.Fatalf("stalled lane state = %q, want stalled", stalled.Tasks[0].Implementer.State)
	}

	idle := BuildPlanView(pairPlan(), false, events, sessionFiles, nowMs, nil)
	if idle.Tasks[0].Implementer.State != "stalled" {
		t.Fatalf("idle lane state = %q, want stalled", idle.Tasks[0].Implementer.State)
	}
	if sessions.SummarizeSession(sessionFiles[0].File).Ended {
		t.Fatal("the fixture session ended, want it open")
	}
}

func TestAttemptWithNoSessionFileIsLiveWhileThePlanRunsAndWaitingOtherwise(t *testing.T) {
	sessionID := attemptID("a1")
	events := []plans.TraceEvent{startEvent("one", 1, map[string]any{"session_id": sessionID})}

	live := BuildPlanView(pairPlan(), true, events, nil, nowMs, summarizeBy(nil))
	attempt := live.Tasks[0].Implementer.Attempts[0]
	if attempt.State != "live" {
		t.Fatalf("attempt state = %q, want live", attempt.State)
	}
	if attempt.HasSession {
		t.Fatal("attempt has a session, want none")
	}
	if attempt.ID != sessionID {
		t.Fatalf("attempt id = %q, want %q", attempt.ID, sessionID)
	}
	if live.Tasks[0].Implementer.State != "live" {
		t.Fatalf("lane state = %q, want live", live.Tasks[0].Implementer.State)
	}

	idle := BuildPlanView(pairPlan(), false, events, nil, nowMs, summarizeBy(nil))
	if idle.Tasks[0].Skipped {
		t.Fatal("task is skipped, want not skipped")
	}
	if idle.Tasks[0].Implementer.State != "waiting" {
		t.Fatalf("idle lane state = %q, want waiting", idle.Tasks[0].Implementer.State)
	}
}

func TestEndedImplementerWithNoTaskEndYetIsDone(t *testing.T) {
	sessionID := attemptID("a1")
	view := BuildPlanView(
		pairPlan(),
		true,
		[]plans.TraceEvent{startEvent("one", 1, nil)},
		filesOf(sessionID),
		nowMs,
		summarizeBy(map[string]sessions.SessionSummary{
			fileOf(sessionID): withSummary(func(s *sessions.SessionSummary) { s.StopReason = ptr("stop") }),
		}),
	)
	lane := view.Tasks[0].Implementer
	if lane.Attempts[0].ID != sessionID {
		t.Fatalf("attempt id = %q, want %q", lane.Attempts[0].ID, sessionID)
	}
	if !lane.Attempts[0].HasSession {
		t.Fatal("attempt has no session, want one")
	}
	if lane.State != "done" {
		t.Fatalf("lane state = %q, want done", lane.State)
	}
}

func TestImplementerIsFailedByFailedEndFailedRetryOrStopReasonError(t *testing.T) {
	sessionID := attemptID("a1")
	file := fileOf(sessionID)
	stopped := withSummary(func(s *sessions.SessionSummary) { s.StopReason = ptr("stop") })

	failedEnd := BuildPlanView(
		pairPlan(),
		true,
		[]plans.TraceEvent{
			startEvent("one", 1, nil),
			endEvent("one", 1, map[string]any{"state": "failed", "ok": false}),
		},
		filesOf(sessionID),
		nowMs,
		summarizeBy(map[string]sessions.SessionSummary{file: stopped}),
	)
	if failedEnd.Tasks[0].Implementer.State != "failed" {
		t.Fatalf("failed end state = %q, want failed", failedEnd.Tasks[0].Implementer.State)
	}

	failedRetry := BuildPlanView(
		pairPlan(),
		true,
		[]plans.TraceEvent{
			startEvent("one", 1, nil),
			endEvent("one", 1, map[string]any{"state": "retry", "ok": false}),
		},
		filesOf(sessionID),
		nowMs,
		summarizeBy(map[string]sessions.SessionSummary{file: stopped}),
	)
	if failedRetry.Tasks[0].Implementer.State != "failed" {
		t.Fatalf("failed retry state = %q, want failed", failedRetry.Tasks[0].Implementer.State)
	}

	stopError := BuildPlanView(
		pairPlan(),
		true,
		[]plans.TraceEvent{startEvent("one", 1, nil)},
		filesOf(sessionID),
		nowMs,
		summarizeBy(map[string]sessions.SessionSummary{
			file: withSummary(func(s *sessions.SessionSummary) {
				s.StopReason = ptr("error")
				s.Error = ptr("boom")
			}),
		}),
	)
	if stopError.Tasks[0].Implementer.State != "failed" {
		t.Fatalf("stop reason error state = %q, want failed", stopError.Tasks[0].Implementer.State)
	}
	errorText := stopError.Tasks[0].Implementer.Attempts[0].Error
	if errorText == nil || *errorText != "boom" {
		t.Fatalf("attempt error = %v, want boom", errorText)
	}
}

func TestRetryWithOkTrueIsDone(t *testing.T) {
	sessionID := attemptID("a1")
	view := BuildPlanView(
		pairPlan(),
		true,
		[]plans.TraceEvent{
			startEvent("one", 1, nil),
			endEvent("one", 1, map[string]any{"state": "retry", "ok": true}),
		},
		filesOf(sessionID),
		nowMs,
		summarizeBy(map[string]sessions.SessionSummary{
			fileOf(sessionID): withSummary(func(s *sessions.SessionSummary) { s.StopReason = ptr("stop") }),
		}),
	)
	if view.Tasks[0].Implementer.State != "done" {
		t.Fatalf("lane state = %q, want done", view.Tasks[0].Implementer.State)
	}
}

func TestAttemptWithNoSessionFileTakesItsOutcomeFromTaskEnd(t *testing.T) {
	done := BuildPlanView(
		pairPlan(),
		true,
		[]plans.TraceEvent{endEvent("one", 1, map[string]any{"state": "done", "ok": true})},
		nil,
		nowMs,
		summarizeBy(nil),
	)
	if len(done.Tasks[0].Implementer.Attempts) != 1 {
		t.Fatalf("attempts = %d, want 1", len(done.Tasks[0].Implementer.Attempts))
	}
	if done.Tasks[0].Implementer.Attempts[0].HasSession {
		t.Fatal("attempt has a session, want none")
	}
	if done.Tasks[0].Implementer.Attempts[0].State != "done" {
		t.Fatalf("attempt state = %q, want done", done.Tasks[0].Implementer.Attempts[0].State)
	}
	if done.Tasks[0].Implementer.State != "done" {
		t.Fatalf("lane state = %q, want done", done.Tasks[0].Implementer.State)
	}

	failed := BuildPlanView(
		pairPlan(),
		true,
		[]plans.TraceEvent{endEvent("one", 2, map[string]any{"state": "failed", "ok": false})},
		nil,
		nowMs,
		summarizeBy(nil),
	)
	if failed.Tasks[0].Implementer.Attempts[0].Label != "a2" {
		t.Fatalf("attempt label = %q, want a2", failed.Tasks[0].Implementer.Attempts[0].Label)
	}
	if failed.Tasks[0].Implementer.State != "failed" {
		t.Fatalf("lane state = %q, want failed", failed.Tasks[0].Implementer.State)
	}
}

func TestReviewerWaitsBeforeItsFileExistsAndIsLiveDuringItsRun(t *testing.T) {
	sessionID := planID + ".one.review1.a1"
	waiting := BuildPlanView(
		pairPlan(),
		true,
		[]plans.TraceEvent{startEvent("one", 1, nil)},
		nil,
		nowMs,
		summarizeBy(nil),
	)
	waitingLane := waiting.Tasks[0].Reviewer
	if waitingLane == nil {
		t.Fatal("reviewer lane is nil, want one")
	}
	if waitingLane.State != "waiting" {
		t.Fatalf("waiting reviewer state = %q, want waiting", waitingLane.State)
	}
	if len(waitingLane.Attempts) != 0 {
		t.Fatalf("waiting reviewer attempts = %d, want 0", len(waitingLane.Attempts))
	}

	live := BuildPlanView(
		pairPlan(),
		true,
		[]plans.TraceEvent{startEvent("one", 1, nil)},
		filesOf(sessionID),
		nowMs,
		summarizeBy(map[string]sessions.SessionSummary{
			fileOf(sessionID): withSummary(func(s *sessions.SessionSummary) {
				s.Ended = false
				s.MtimeMs = float64(nowMs - 1000)
			}),
		}),
	)
	liveLane := live.Tasks[0].Reviewer
	if liveLane == nil {
		t.Fatal("reviewer lane is nil, want one")
	}
	if liveLane.State != "live" {
		t.Fatalf("live reviewer state = %q, want live", liveLane.State)
	}
	if liveLane.Attempts[0].Label != "r1" {
		t.Fatalf("reviewer label = %q, want r1", liveLane.Attempts[0].Label)
	}
	if liveLane.Attempts[0].Review != nil {
		t.Fatalf("reviewer review = %v, want nil", liveLane.Attempts[0].Review)
	}
}

func TestFinishedReviewerPinsItsVerdictAndFindingsCount(t *testing.T) {
	sessionID := planID + ".one.review1.a1"
	view := BuildPlanView(
		pairPlan(),
		true,
		[]plans.TraceEvent{
			startEvent("one", 1, nil),
			reviewEvent("one", map[string]any{
				"round":      float64(1),
				"session_id": sessionID,
				"verdict":    "approve",
				"findings":   float64(0),
				"ok":         true,
				"model":      "opencode-go/beam-free",
			}),
		},
		filesOf(sessionID),
		nowMs,
		summarizeBy(map[string]sessions.SessionSummary{
			fileOf(sessionID): withSummary(func(s *sessions.SessionSummary) { s.LastText = ptr("all good") }),
		}),
	)
	lane := view.Tasks[0].Reviewer
	if lane == nil {
		t.Fatal("reviewer lane is nil, want one")
	}
	if lane.State != "done" {
		t.Fatalf("reviewer state = %q, want done", lane.State)
	}
	want := model.ReviewResult{
		Verdict:  "approve",
		Findings: ptr(0),
		Failed:   false,
		Text:     ptr("all good"),
	}
	if !reflect.DeepEqual(lane.Attempts[0].Review, &want) {
		t.Fatalf("review = %+v, want %+v", lane.Attempts[0].Review, want)
	}

	changes := BuildPlanView(
		pairPlan(),
		true,
		[]plans.TraceEvent{
			startEvent("one", 1, nil),
			reviewEvent("one", map[string]any{
				"round":      float64(1),
				"session_id": sessionID,
				"verdict":    "changes",
				"findings":   float64(2),
				"ok":         true,
			}),
		},
		filesOf(sessionID),
		nowMs,
		summarizeBy(map[string]sessions.SessionSummary{fileOf(sessionID): summary()}),
	)
	changesReview := changes.Tasks[0].Reviewer.Attempts[0].Review
	if changesReview == nil {
		t.Fatal("changes review is nil, want one")
	}
	if changesReview.Verdict != "changes" {
		t.Fatalf("changes verdict = %q, want changes", changesReview.Verdict)
	}
	if changesReview.Findings == nil || *changesReview.Findings != 2 {
		t.Fatalf("changes findings = %v, want 2", changesReview.Findings)
	}
	if changesReview.Failed {
		t.Fatal("changes review is failed, want not failed")
	}
}

func TestFailedReviewerIsFailedAndNeverAPass(t *testing.T) {
	sessionID := planID + ".one.review1.a1"
	failed := BuildPlanView(
		pairPlan(),
		true,
		[]plans.TraceEvent{
			startEvent("one", 1, nil),
			reviewEvent("one", map[string]any{
				"round":      float64(1),
				"session_id": sessionID,
				"verdict":    "changes",
				"findings":   float64(1),
				"ok":         false,
			}),
		},
		nil,
		nowMs,
		summarizeBy(nil),
	)
	failedLane := failed.Tasks[0].Reviewer
	if failedLane == nil {
		t.Fatal("reviewer lane is nil, want one")
	}
	if failedLane.State != "failed" {
		t.Fatalf("failed reviewer state = %q, want failed", failedLane.State)
	}
	if failedLane.Attempts[0].HasSession {
		t.Fatal("failed reviewer has a session, want none")
	}
	if failedLane.Attempts[0].Review == nil || !failedLane.Attempts[0].Review.Failed {
		t.Fatalf("failed reviewer review = %+v, want failed", failedLane.Attempts[0].Review)
	}
	if failedLane.Attempts[0].Review.Text != nil {
		t.Fatalf("failed reviewer text = %v, want nil", failedLane.Attempts[0].Review.Text)
	}

	unknown := BuildPlanView(
		pairPlan(),
		true,
		[]plans.TraceEvent{
			startEvent("one", 1, nil),
			reviewEvent("one", map[string]any{
				"round":      float64(1),
				"session_id": sessionID,
				"verdict":    "clean",
				"findings":   float64(0),
				"ok":         true,
			}),
		},
		nil,
		nowMs,
		summarizeBy(nil),
	)
	unknownLane := unknown.Tasks[0].Reviewer
	if unknownLane == nil {
		t.Fatal("reviewer lane is nil, want one")
	}
	if unknownLane.State != "failed" {
		t.Fatalf("unknown reviewer state = %q, want failed", unknownLane.State)
	}
	if unknownLane.Attempts[0].Review.Verdict != "unknown" {
		t.Fatalf("unknown verdict = %q, want unknown", unknownLane.Attempts[0].Review.Verdict)
	}
	if !unknownLane.Attempts[0].Review.Failed {
		t.Fatal("unknown review is not failed, want failed")
	}
}

func TestTwoImplementerAttemptsKeepTheirOrderAndTheNewestSetsTheLane(t *testing.T) {
	first := attemptID("a1")
	second := attemptID("a2")
	view := BuildPlanView(
		pairPlan(),
		true,
		[]plans.TraceEvent{
			startEvent("one", 1, nil),
			endEvent("one", 1, map[string]any{"state": "failed", "ok": false}),
			startEvent("one", 2, nil),
		},
		filesOf(first, second),
		nowMs,
		summarizeBy(map[string]sessions.SessionSummary{
			fileOf(first): withSummary(func(s *sessions.SessionSummary) { s.StopReason = ptr("stop") }),
			fileOf(second): withSummary(func(s *sessions.SessionSummary) {
				s.Ended = false
				s.MtimeMs = float64(nowMs - 2000)
			}),
		}),
	)
	lane := view.Tasks[0].Implementer
	labels := []string{lane.Attempts[0].Label, lane.Attempts[1].Label}
	if !reflect.DeepEqual(labels, []string{"a1", "a2"}) {
		t.Fatalf("labels = %v, want [a1 a2]", labels)
	}
	if lane.Attempts[0].State != "failed" {
		t.Fatalf("first attempt state = %q, want failed", lane.Attempts[0].State)
	}
	if lane.Attempts[1].State != "live" {
		t.Fatalf("second attempt state = %q, want live", lane.Attempts[1].State)
	}
	if lane.State != "live" {
		t.Fatalf("lane state = %q, want live", lane.State)
	}
}

func TestAttemptsNamedOnlyBySessionFilesArePickedUp(t *testing.T) {
	first := attemptID("a1")
	second := attemptID("a2")
	view := BuildPlanView(
		pairPlan(),
		true,
		nil,
		filesOf(second, first),
		nowMs,
		summarizeBy(map[string]sessions.SessionSummary{
			fileOf(first): withSummary(func(s *sessions.SessionSummary) { s.StopReason = ptr("stop") }),
			fileOf(second): withSummary(func(s *sessions.SessionSummary) {
				s.Ended = false
				s.MtimeMs = float64(nowMs - 1000)
			}),
		}),
	)
	lane := view.Tasks[0].Implementer
	labels := []string{lane.Attempts[0].Label, lane.Attempts[1].Label}
	if !reflect.DeepEqual(labels, []string{"a1", "a2"}) {
		t.Fatalf("labels = %v, want [a1 a2]", labels)
	}
	hasSession := []bool{lane.Attempts[0].HasSession, lane.Attempts[1].HasSession}
	if !reflect.DeepEqual(hasSession, []bool{true, true}) {
		t.Fatalf("hasSession = %v, want [true true]", hasSession)
	}
	if lane.State != "live" {
		t.Fatalf("lane state = %q, want live", lane.State)
	}
}

func TestTwoReviewRoundsKeepTheirOrderAndTheNewestRoundSetsTheLane(t *testing.T) {
	first := planID + ".one.review1.a1"
	second := planID + ".one.review2.a1"
	view := BuildPlanView(
		pairPlan(),
		true,
		[]plans.TraceEvent{
			startEvent("one", 1, nil),
			reviewEvent("one", map[string]any{
				"round":      float64(1),
				"session_id": first,
				"verdict":    "approve",
				"findings":   float64(0),
				"ok":         true,
			}),
		},
		filesOf(first, second),
		nowMs,
		summarizeBy(map[string]sessions.SessionSummary{
			fileOf(first): withSummary(func(s *sessions.SessionSummary) { s.StopReason = ptr("stop") }),
			fileOf(second): withSummary(func(s *sessions.SessionSummary) {
				s.Ended = false
				s.MtimeMs = float64(nowMs - 1000)
			}),
		}),
	)
	lane := view.Tasks[0].Reviewer
	if lane == nil {
		t.Fatal("reviewer lane is nil, want one")
	}
	labels := []string{lane.Attempts[0].Label, lane.Attempts[1].Label}
	if !reflect.DeepEqual(labels, []string{"r1", "r2"}) {
		t.Fatalf("labels = %v, want [r1 r2]", labels)
	}
	if lane.Attempts[0].Review == nil || lane.Attempts[0].Review.Verdict != "approve" {
		t.Fatalf("first review = %+v, want approve", lane.Attempts[0].Review)
	}
	if lane.Attempts[1].Review != nil {
		t.Fatalf("second review = %+v, want nil", lane.Attempts[1].Review)
	}
	if lane.State != "live" {
		t.Fatalf("lane state = %q, want live", lane.State)
	}
}

func TestWaitsForListsTheDependenciesThatAreNotDoneYet(t *testing.T) {
	plan := &plans.ParsedPlan{
		ID:    planID,
		Trace: trace,
		Round: 1,
		Tasks: []plans.PlanTask{
			{ID: "one", Role: "implement", Pair: nil, DependsOn: []string{}},
			{ID: "two", Role: "implement", Pair: nil, DependsOn: []string{"one"}},
			{ID: "three", Role: "qa", Pair: ptr("review"), DependsOn: []string{"one", "two"}},
		},
	}
	view := BuildPlanView(
		plan,
		true,
		[]plans.TraceEvent{
			startEvent("one", 1, nil),
			endEvent("one", 1, map[string]any{"state": "done", "ok": true}),
			startEvent("two", 1, nil),
		},
		nil,
		nowMs,
		summarizeBy(nil),
	)
	if !reflect.DeepEqual(view.Tasks[0].WaitsFor, []string{}) {
		t.Fatalf("task one waitsFor = %v, want []", view.Tasks[0].WaitsFor)
	}
	if !reflect.DeepEqual(view.Tasks[1].WaitsFor, []string{}) {
		t.Fatalf("task two waitsFor = %v, want []", view.Tasks[1].WaitsFor)
	}
	if !reflect.DeepEqual(view.Tasks[2].WaitsFor, []string{"two"}) {
		t.Fatalf("task three waitsFor = %v, want [two]", view.Tasks[2].WaitsFor)
	}
	if view.Tasks[2].Role != "qa" {
		t.Fatalf("task three role = %q, want qa", view.Tasks[2].Role)
	}
	if !reflect.DeepEqual(view.Tasks[2].DependsOn, []string{"one", "two"}) {
		t.Fatalf("task three dependsOn = %v, want [one two]", view.Tasks[2].DependsOn)
	}
}

func TestTaskOfAFinishedPlanWithNoEventsIsSkippedAndWaitsForNothing(t *testing.T) {
	plan := &plans.ParsedPlan{
		ID:    planID,
		Trace: trace,
		Round: 1,
		Tasks: []plans.PlanTask{
			{ID: "one", Role: "implement", Pair: ptr("review"), DependsOn: []string{}},
			{ID: "two", Role: "implement", Pair: ptr("review"), DependsOn: []string{"one"}},
		},
	}
	view := BuildPlanView(
		plan,
		false,
		[]plans.TraceEvent{
			startEvent("one", 1, nil),
			endEvent("one", 1, map[string]any{"state": "done", "ok": true}),
		},
		nil,
		nowMs,
		summarizeBy(nil),
	)
	skipped := view.Tasks[1]
	if !skipped.Skipped {
		t.Fatal("task two is not skipped, want skipped")
	}
	if !reflect.DeepEqual(skipped.WaitsFor, []string{}) {
		t.Fatalf("skipped waitsFor = %v, want []", skipped.WaitsFor)
	}
	if skipped.Implementer.State != "waiting" {
		t.Fatalf("skipped implementer state = %q, want waiting", skipped.Implementer.State)
	}
	if skipped.Reviewer == nil || skipped.Reviewer.State != "waiting" {
		t.Fatalf("skipped reviewer = %+v, want waiting", skipped.Reviewer)
	}
	if view.Tasks[0].Skipped {
		t.Fatal("task one is skipped, want not skipped")
	}
}

func TestTaskWithoutAPairHasNoReviewerLane(t *testing.T) {
	plan := &plans.ParsedPlan{
		ID:    planID,
		Trace: trace,
		Round: 1,
		Tasks: []plans.PlanTask{
			{ID: "one", Role: "implement", Pair: nil, DependsOn: []string{}},
		},
	}
	view := BuildPlanView(
		plan,
		true,
		[]plans.TraceEvent{startEvent("one", 1, nil)},
		nil,
		nowMs,
		summarizeBy(nil),
	)
	if view.Tasks[0].Reviewer != nil {
		t.Fatalf("reviewer = %+v, want nil", view.Tasks[0].Reviewer)
	}
	if view.Tasks[0].Pair != nil {
		t.Fatalf("pair = %v, want nil", view.Tasks[0].Pair)
	}
}

func TestDoneCountsTheTasksWhoseLatestTaskEndIsDone(t *testing.T) {
	plan := &plans.ParsedPlan{
		ID:    planID,
		Trace: trace,
		Round: 1,
		Tasks: []plans.PlanTask{
			{ID: "one", Role: "implement", Pair: nil, DependsOn: []string{}},
			{ID: "two", Role: "implement", Pair: nil, DependsOn: []string{}},
		},
	}
	view := BuildPlanView(
		plan,
		false,
		[]plans.TraceEvent{
			startEvent("one", 1, nil),
			endEvent("one", 1, map[string]any{"state": "done", "ok": true}),
			startEvent("two", 1, nil),
			endEvent("two", 1, map[string]any{"state": "done", "ok": true}),
			endEvent("two", 2, map[string]any{"state": "failed", "ok": false}),
		},
		nil,
		nowMs,
		summarizeBy(nil),
	)
	if view.Done != 1 {
		t.Fatalf("done = %d, want 1", view.Done)
	}
	if view.Total != 2 {
		t.Fatalf("total = %d, want 2", view.Total)
	}
	if view.State != "done" {
		t.Fatalf("state = %q, want done", view.State)
	}
	if view.Gate != nil {
		t.Fatalf("gate = %v, want nil", view.Gate)
	}
}

func TestPlanStateAndGateFollowRunningAndThePlanEndEvent(t *testing.T) {
	pass := BuildPlanView(
		pairPlan(),
		false,
		[]plans.TraceEvent{planEndEvent(map[string]any{"gate_pass": true})},
		nil,
		nowMs,
		summarizeBy(nil),
	)
	if pass.State != "done" {
		t.Fatalf("pass state = %q, want done", pass.State)
	}
	if pass.Gate == nil || *pass.Gate != "pass" {
		t.Fatalf("pass gate = %v, want pass", pass.Gate)
	}

	fail := BuildPlanView(
		pairPlan(),
		false,
		[]plans.TraceEvent{planEndEvent(map[string]any{"gate_pass": false})},
		nil,
		nowMs,
		summarizeBy(nil),
	)
	if fail.State != "failed" {
		t.Fatalf("fail state = %q, want failed", fail.State)
	}
	if fail.Gate == nil || *fail.Gate != "fail" {
		t.Fatalf("fail gate = %v, want fail", fail.Gate)
	}

	running := BuildPlanView(
		pairPlan(),
		true,
		[]plans.TraceEvent{planEndEvent(map[string]any{"gate_pass": true})},
		nil,
		nowMs,
		summarizeBy(nil),
	)
	if running.State != "running" {
		t.Fatalf("running state = %q, want running", running.State)
	}
	if running.Gate == nil || *running.Gate != "pass" {
		t.Fatalf("running gate = %v, want pass", running.Gate)
	}

	noEnd := BuildPlanView(pairPlan(), false, nil, nil, nowMs, summarizeBy(nil))
	if noEnd.State != "done" {
		t.Fatalf("no end state = %q, want done", noEnd.State)
	}
	if noEnd.Gate != nil {
		t.Fatalf("no end gate = %v, want nil", noEnd.Gate)
	}

	if pass.ID != planID {
		t.Fatalf("plan id = %q, want %q", pass.ID, planID)
	}
	if pass.Trace != trace {
		t.Fatalf("plan trace = %q, want %q", pass.Trace, trace)
	}
	if pass.Round != 1 {
		t.Fatalf("plan round = %d, want 1", pass.Round)
	}
}
