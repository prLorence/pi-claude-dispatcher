package model

import (
	"encoding/json"
	"reflect"
	"testing"
)

func ptr[T any](v T) *T {
	return &v
}

func wantKeys(t *testing.T, obj map[string]any, keys ...string) {
	t.Helper()
	got := make([]string, 0, len(obj))
	for key := range obj {
		got = append(got, key)
	}
	sortStrings(got)
	sortStrings(keys)
	if !reflect.DeepEqual(got, keys) {
		t.Fatalf("keys = %v, want %v", got, keys)
	}
}

func sortStrings(list []string) {
	for i := 1; i < len(list); i++ {
		for j := i; j > 0 && list[j] < list[j-1]; j-- {
			list[j], list[j-1] = list[j-1], list[j]
		}
	}
}

func object(t *testing.T, value any, name string) map[string]any {
	t.Helper()
	obj, ok := value.(map[string]any)
	if !ok {
		t.Fatalf("%s is %T, want an object", name, value)
	}
	return obj
}

func array(t *testing.T, value any, name string) []any {
	t.Helper()
	list, ok := value.([]any)
	if !ok {
		t.Fatalf("%s is %T, want an array", name, value)
	}
	return list
}

func fullState() MonitorState {
	started := "2026-10-23T10:00:00.000Z"
	last := "2026-10-23T10:05:00.000Z"
	gate := "pass"
	pair := "review"
	modelName := "deepseek-v4"
	thinking := "high"
	lastTool := "edit core.ts"
	reviewText := "looks fine"
	findings := 2
	ran := "high"
	repoMessage := "folder is missing"
	probabilities := map[string]float64{"low": 0.2, "high": 0.8}

	implementerAttempt := Attempt{
		ID:         "session-implement",
		Label:      "a1",
		State:      "done",
		Model:      &modelName,
		Thinking:   &thinking,
		StartedAt:  &started,
		ElapsedS:   ptr(12.5),
		Tokens:     ptr(float64(1500)),
		Cost:       ptr(0.25),
		LastTool:   &lastTool,
		Error:      nil,
		HasSession: true,
		Review:     nil,
	}
	reviewerAttempt := Attempt{
		ID:         "session-review",
		Label:      "r1",
		State:      "done",
		Model:      &modelName,
		Thinking:   &thinking,
		StartedAt:  &started,
		ElapsedS:   ptr(3.5),
		Tokens:     ptr(float64(400)),
		Cost:       ptr(0.05),
		LastTool:   nil,
		Error:      nil,
		HasSession: true,
		Review: &ReviewResult{
			Verdict:  "approve",
			Findings: &findings,
			Failed:   false,
			Text:     &reviewText,
		},
	}

	return MonitorState{
		Repos: []RepoView{
			{
				Name:   "repo",
				Active: true,
				Plan: &PlanView{
					ID:    "plan-1",
					Trace: "trace-1",
					Round: 1,
					State: "running",
					Gate:  &gate,
					Done:  1,
					Total: 2,
					Tasks: []TaskRow{
						{
							ID:        "task-a",
							Role:      "implement",
							Pair:      &pair,
							DependsOn: []string{"task-b"},
							WaitsFor:  []string{},
							Skipped:   false,
							Implementer: Lane{
								State:    "done",
								Attempts: []Attempt{implementerAttempt},
							},
							Reviewer: &Lane{
								State:    "done",
								Attempts: []Attempt{reviewerAttempt},
							},
							Decider: &DeciderTaskView{
								Suggested:     "high",
								Probabilities: probabilities,
								Confidence:    ptr(0.9),
								Complexity:    ptr(0.7),
								Ran:           &ran,
							},
						},
						{
							ID:        "task-b",
							Role:      "implement",
							Pair:      nil,
							DependsOn: []string{},
							WaitsFor:  []string{"task-a"},
							Skipped:   true,
							Implementer: Lane{
								State:    "waiting",
								Attempts: []Attempt{},
							},
							Reviewer: nil,
							Decider:  nil,
						},
					},
					Audit: &DeciderAuditView{
						Proposal:   "approve",
						Aggregate:  0.3,
						Verdict:    "pass",
						AuditRound: 1,
						Findings: []DeciderFinding{
							{ID: "f1", Severity: "major", P: 0.6},
						},
					},
				},
				Message:      nil,
				StartedAt:    &started,
				LastActivity: &last,
			},
			{
				Name:         "idle",
				Active:       false,
				Plan:         nil,
				Message:      &repoMessage,
				StartedAt:    nil,
				LastActivity: nil,
			},
		},
		Message: nil,
		Now:     "2026-10-23T10:05:00.000Z",
	}
}

func TestMonitorStateJSON(t *testing.T) {
	state := fullState()

	data, err := json.Marshal(state)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var roundTrip MonitorState
	if err := json.Unmarshal(data, &roundTrip); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !reflect.DeepEqual(state, roundTrip) {
		t.Fatalf("round trip differs:\n got %#v\nwant %#v", roundTrip, state)
	}

	var doc map[string]any
	if err := json.Unmarshal(data, &doc); err != nil {
		t.Fatalf("unmarshal document: %v", err)
	}
	wantKeys(t, doc, "repos", "message", "now")
	if doc["message"] != nil {
		t.Fatalf("message = %v, want null", doc["message"])
	}

	repos := array(t, doc["repos"], "repos")
	if len(repos) != 2 {
		t.Fatalf("repos length = %d, want 2", len(repos))
	}
	repo := object(t, repos[0], "repo")
	wantKeys(t, repo, "name", "active", "plan", "message", "startedAt", "lastActivity")
	if repo["message"] != nil {
		t.Fatalf("repo message = %v, want null", repo["message"])
	}

	plan := object(t, repo["plan"], "plan")
	wantKeys(t, plan, "id", "trace", "round", "state", "gate", "done", "total", "tasks", "audit")
	tasks := array(t, plan["tasks"], "tasks")
	if len(tasks) != 2 {
		t.Fatalf("tasks length = %d, want 2", len(tasks))
	}

	task := object(t, tasks[0], "task")
	wantKeys(t, task, "id", "role", "pair", "dependsOn", "waitsFor", "skipped", "implementer", "reviewer", "decider")

	implementer := object(t, task["implementer"], "implementer")
	wantKeys(t, implementer, "state", "attempts")
	attempt := object(t, array(t, implementer["attempts"], "implementer attempts")[0], "attempt")
	wantKeys(t, attempt, "id", "label", "state", "model", "thinking", "startedAt", "elapsedS", "tokens", "cost", "lastTool", "error", "hasSession", "review")
	if attempt["error"] != nil {
		t.Fatalf("attempt error = %v, want null", attempt["error"])
	}
	if attempt["review"] != nil {
		t.Fatalf("attempt review = %v, want null", attempt["review"])
	}

	reviewer := object(t, task["reviewer"], "reviewer")
	reviewAttempt := object(t, array(t, reviewer["attempts"], "reviewer attempts")[0], "review attempt")
	review := object(t, reviewAttempt["review"], "review")
	wantKeys(t, review, "verdict", "findings", "failed", "text")

	decider := object(t, task["decider"], "decider")
	wantKeys(t, decider, "suggested", "probabilities", "confidence", "complexity", "ran")

	audit := object(t, plan["audit"], "audit")
	wantKeys(t, audit, "proposal", "aggregate", "verdict", "auditRound", "findings")
	finding := object(t, array(t, audit["findings"], "audit findings")[0], "finding")
	wantKeys(t, finding, "id", "severity", "p")

	waiting := object(t, tasks[1], "waiting task")
	if waiting["reviewer"] != nil {
		t.Fatalf("waiting task reviewer = %v, want null", waiting["reviewer"])
	}
	if waiting["decider"] != nil {
		t.Fatalf("waiting task decider = %v, want null", waiting["decider"])
	}
	if dependsOn := array(t, waiting["dependsOn"], "dependsOn"); len(dependsOn) != 0 {
		t.Fatalf("dependsOn = %v, want an empty array", dependsOn)
	}
	waitingLane := object(t, waiting["implementer"], "waiting implementer")
	if attempts := array(t, waitingLane["attempts"], "waiting attempts"); len(attempts) != 0 {
		t.Fatalf("attempts = %v, want an empty array", attempts)
	}

	idle := object(t, repos[1], "idle repo")
	if idle["plan"] != nil {
		t.Fatalf("idle plan = %v, want null", idle["plan"])
	}
	if idle["startedAt"] != nil {
		t.Fatalf("idle startedAt = %v, want null", idle["startedAt"])
	}
	if idle["lastActivity"] != nil {
		t.Fatalf("idle lastActivity = %v, want null", idle["lastActivity"])
	}
}

func TestSessionPageJSON(t *testing.T) {
	started := "2026-10-23T10:00:00.000Z"
	page := SessionPage{
		ID:    "session-1",
		Live:  true,
		Ended: false,
		Entries: []Entry{
			{
				Line:      1,
				Ts:        &started,
				Kind:      "user",
				Text:      "fix the build",
				Collapsed: true,
				Truncated: false,
				Tool:      nil,
				IsError:   false,
			},
			{
				Line:      2,
				Ts:        nil,
				Kind:      "tool_call",
				Text:      "bash npm test",
				Collapsed: false,
				Truncated: true,
				Tool:      &EntryTool{Name: "bash", Args: `{"command":"npm test"}`},
				IsError:   true,
			},
		},
		Next: 3,
	}

	data, err := json.Marshal(page)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var roundTrip SessionPage
	if err := json.Unmarshal(data, &roundTrip); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !reflect.DeepEqual(page, roundTrip) {
		t.Fatalf("round trip differs:\n got %#v\nwant %#v", roundTrip, page)
	}

	var doc map[string]any
	if err := json.Unmarshal(data, &doc); err != nil {
		t.Fatalf("unmarshal document: %v", err)
	}
	wantKeys(t, doc, "id", "live", "ended", "entries", "next")

	entries := array(t, doc["entries"], "entries")
	if len(entries) != 2 {
		t.Fatalf("entries length = %d, want 2", len(entries))
	}
	first := object(t, entries[0], "entry")
	wantKeys(t, first, "line", "ts", "kind", "text", "collapsed", "truncated", "tool", "isError")
	if first["tool"] != nil {
		t.Fatalf("first tool = %v, want null", first["tool"])
	}

	second := object(t, entries[1], "entry")
	if second["ts"] != nil {
		t.Fatalf("second ts = %v, want null", second["ts"])
	}
	tool := object(t, second["tool"], "tool")
	wantKeys(t, tool, "name", "args")
}

func TestZeroValuesEncodeAsNullAndEmpty(t *testing.T) {
	data, err := json.Marshal(RepoView{Name: "repo"})
	if err != nil {
		t.Fatalf("marshal repo: %v", err)
	}
	want := `{"name":"repo","active":false,"plan":null,"message":null,"startedAt":null,"lastActivity":null}`
	if string(data) != want {
		t.Fatalf("repo JSON = %s, want %s", data, want)
	}

	data, err = json.Marshal(Lane{Attempts: []Attempt{}})
	if err != nil {
		t.Fatalf("marshal lane: %v", err)
	}
	want = `{"state":"","attempts":[]}`
	if string(data) != want {
		t.Fatalf("lane JSON = %s, want %s", data, want)
	}

	data, err = json.Marshal(ReviewResult{})
	if err != nil {
		t.Fatalf("marshal review: %v", err)
	}
	want = `{"verdict":"","findings":null,"failed":false,"text":null}`
	if string(data) != want {
		t.Fatalf("review JSON = %s, want %s", data, want)
	}
}

func TestParseTime(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want int64
		ok   bool
	}{
		{name: "Z without milliseconds", in: "2026-10-23T10:05:00Z", want: 1792749900000, ok: true},
		{name: "Z with milliseconds", in: "2026-10-23T10:05:00.123Z", want: 1792749900123, ok: true},
		{name: "offset zone", in: "2026-10-23T18:05:00+08:00", want: 1792749900000, ok: true},
		{name: "invalid", in: "not a timestamp", want: 0, ok: false},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got, ok := ParseTime(testCase.in)
			if ok != testCase.ok {
				t.Fatalf("ParseTime(%q) ok = %v, want %v", testCase.in, ok, testCase.ok)
			}
			if got != testCase.want {
				t.Fatalf("ParseTime(%q) = %d, want %d", testCase.in, got, testCase.want)
			}
		})
	}
}
