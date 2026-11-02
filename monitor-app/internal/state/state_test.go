package state

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"pi-monitor/internal/model"
	"pi-monitor/internal/repos"
)

const (
	t1 = "2026-10-23T10:00:00.000Z"
	t2 = "2026-10-23T10:01:00.000Z"
	t3 = "2026-10-23T10:02:00.000Z"
	t4 = "2026-10-23T10:03:00.000Z"
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

// fixtureTask is one task of a fixture plan.
type fixtureTask struct {
	ID        string
	DependsOn []string
	Pair      *string
	Role      string
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

func planText(id, trace string, tasks []fixtureTask) string {
	lines := []string{"---", "id: " + id, "trace: " + trace, "round: 1", "status: ready", "---", "## Context", "", "Fixture plan for the monitor tests."}
	for _, task := range tasks {
		dependsOn := task.DependsOn
		if dependsOn == nil {
			dependsOn = []string{}
		}
		lines = append(lines, "", "## task: "+task.ID, "files: x.ts",
			"depends_on: ["+joinComma(dependsOn)+"]")
		if task.Role != "" {
			lines = append(lines, "role: "+task.Role)
		}
		if task.Pair != nil {
			lines = append(lines, "pair: "+*task.Pair)
		}
		lines = append(lines, "", "Body line for "+task.ID+".")
	}
	lines = append(lines, "")
	return joinLines(lines)
}

func joinComma(values []string) string {
	out := ""
	for i, value := range values {
		if i > 0 {
			out += ", "
		}
		out += value
	}
	return out
}

func joinLines(lines []string) string {
	out := ""
	for _, line := range lines {
		out += line + "\n"
	}
	return out
}

func writePlan(t *testing.T, dir, where, id string, tasks []fixtureTask, trace string) {
	t.Helper()
	text := planText(id, trace, tasks)
	if where == "running" {
		file := filepath.Join(dir, "running", id+".md")
		if err := os.WriteFile(file, []byte(text), 0o600); err != nil {
			t.Fatalf("write running plan: %v", err)
		}
		return
	}
	folder := filepath.Join(dir, "done", id)
	if err := os.MkdirAll(folder, 0o700); err != nil {
		t.Fatalf("mkdir done plan: %v", err)
	}
	if err := os.WriteFile(filepath.Join(folder, "plan.md"), []byte(text), 0o600); err != nil {
		t.Fatalf("write done plan: %v", err)
	}
}

func ev(kind, plan, ts string, extra map[string]any) map[string]any {
	event := map[string]any{
		"ts":    ts,
		"plan":  plan,
		"kind":  kind,
		"actor": "worker",
		"round": 1,
	}
	for key, value := range extra {
		event[key] = value
	}
	return event
}

func writeEvents(t *testing.T, dir, trace string, events []map[string]any) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(dir, "traces"), 0o700); err != nil {
		t.Fatalf("mkdir traces: %v", err)
	}
	file := filepath.Join(dir, "traces", trace+".jsonl")
	handle, err := os.OpenFile(file, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		t.Fatalf("open trace: %v", err)
	}
	defer handle.Close()
	for _, event := range events {
		event["v"] = 1
		event["trace"] = trace
		line, err := json.Marshal(event)
		if err != nil {
			t.Fatalf("marshal event: %v", err)
		}
		if _, err := handle.Write([]byte(string(line) + "\n")); err != nil {
			t.Fatalf("write event: %v", err)
		}
	}
}

func repo(dir string) repos.RepoConfig {
	return repos.RepoConfig{Name: filepath.Base(dir), Dir: dir}
}

func namesOf(views []model.RepoView) []string {
	out := make([]string, 0, len(views))
	for _, view := range views {
		out = append(out, view.Name)
	}
	return out
}

func TestReadRepoReadsRunningPlanAndItsEventTimes(t *testing.T) {
	dir := makePlansDir(t)
	writePlan(t, dir, "running", "p-r1", []fixtureTask{{ID: "one"}}, "trace-a")
	writeEvents(t, dir, "trace-a", []map[string]any{
		ev("task.start", "p-r1", t1, map[string]any{"task": "one", "attempt": 1}),
		ev("task.end", "p-r1", t2, map[string]any{
			"task": "one", "attempt": 1, "data": map[string]any{"state": "done"},
		}),
	})

	view := ReadRepo(repo(dir), nowMs)
	if !view.Active {
		t.Fatalf("active = false, want true")
	}
	if view.Plan == nil || view.Plan.ID != "p-r1" {
		t.Fatalf("plan = %#v, want id p-r1", view.Plan)
	}
	if view.Message != nil {
		t.Fatalf("message = %v, want nil", *view.Message)
	}
	if !reflect.DeepEqual(view.StartedAt, ptr(t1)) {
		t.Fatalf("startedAt = %v, want %s", view.StartedAt, t1)
	}
	if !reflect.DeepEqual(view.LastActivity, ptr(t2)) {
		t.Fatalf("lastActivity = %v, want %s", view.LastActivity, t2)
	}
	if got := view.Plan.Tasks[0].Implementer.State; got != "done" {
		t.Fatalf("implementer state = %q, want done", got)
	}
}

func TestReadRepoReadsLatestFinishedPlanOfIdleRepo(t *testing.T) {
	dir := makePlansDir(t)
	writePlan(t, dir, "done", "old-r1", []fixtureTask{{ID: "one"}}, "trace-old")
	writePlan(t, dir, "done", "new-r1", []fixtureTask{{ID: "one"}}, "trace-new")
	writeEvents(t, dir, "trace-old", []map[string]any{
		ev("plan.end", "old-r1", t1, map[string]any{"data": map[string]any{"gate_pass": true}}),
	})
	writeEvents(t, dir, "trace-new", []map[string]any{
		ev("plan.end", "new-r1", t3, map[string]any{"data": map[string]any{"gate_pass": false}}),
	})

	view := ReadRepo(repo(dir), nowMs)
	if view.Active {
		t.Fatalf("active = true, want false")
	}
	if view.Plan == nil || view.Plan.ID != "new-r1" {
		t.Fatalf("plan = %#v, want id new-r1", view.Plan)
	}
	if view.Plan.State != "failed" {
		t.Fatalf("state = %q, want failed", view.Plan.State)
	}
	if !reflect.DeepEqual(view.StartedAt, ptr(t3)) {
		t.Fatalf("startedAt = %v, want %s", view.StartedAt, t3)
	}
	if !reflect.DeepEqual(view.LastActivity, ptr(t3)) {
		t.Fatalf("lastActivity = %v, want %s", view.LastActivity, t3)
	}
}

func TestReadRepoReportsEmptyPlansFolder(t *testing.T) {
	dir := makePlansDir(t)
	view := ReadRepo(repo(dir), nowMs)
	if view.Plan != nil {
		t.Fatalf("plan = %#v, want nil", view.Plan)
	}
	if view.Active {
		t.Fatalf("active = true, want false")
	}
	if view.Message == nil || *view.Message != "No plan has run yet" {
		t.Fatalf("message = %v, want \"No plan has run yet\"", view.Message)
	}
	if view.StartedAt != nil || view.LastActivity != nil {
		t.Fatalf("times = %v, %v, want nil, nil", view.StartedAt, view.LastActivity)
	}
}

func TestReadRepoReportsMissingFolderWithoutThrowing(t *testing.T) {
	dir := filepath.Join(makePlansDir(t), "does-not-exist")
	view := ReadRepo(repos.RepoConfig{Name: "gone", Dir: dir}, nowMs)
	if view.Name != "gone" {
		t.Fatalf("name = %q, want gone", view.Name)
	}
	if view.Plan != nil {
		t.Fatalf("plan = %#v, want nil", view.Plan)
	}
	if view.Active {
		t.Fatalf("active = true, want false")
	}
	if view.Message == nil || *view.Message != "No plans folder found" {
		t.Fatalf("message = %v, want \"No plans folder found\"", view.Message)
	}
	if view.StartedAt != nil || view.LastActivity != nil {
		t.Fatalf("times = %v, %v, want nil, nil", view.StartedAt, view.LastActivity)
	}
}

func TestReadRepoAppliesDeciderOverlay(t *testing.T) {
	dir := makePlansDir(t)
	writePlan(t, dir, "running", "p-r1", []fixtureTask{{ID: "one"}}, "trace-a")
	writeEvents(t, dir, "trace-a", []map[string]any{
		ev("decision.effort", "p-r1", t1, map[string]any{
			"task": "one",
			"data": map[string]any{
				"task":          "one",
				"suggested":     "high",
				"probabilities": map[string]any{"high": 0.7},
				"confidence":    0.6,
				"complexity":    4,
				"mode":          "apply",
			},
		}),
		ev("task.start", "p-r1", t2, map[string]any{
			"task": "one", "attempt": 1, "data": map[string]any{"thinking": "low"},
		}),
		ev("decision.audit", "p-r1", t3, map[string]any{
			"data": map[string]any{
				"audit_round": 1,
				"verdict":     "pass",
				"proposal":    "approve",
				"aggregate":   0.25,
				"findings": []any{
					map[string]any{"id": "f1", "severity": "major", "p": 0.3},
				},
			},
		}),
	})

	view := ReadRepo(repo(dir), nowMs)
	if view.Plan == nil || view.Plan.Tasks[0].Decider == nil {
		t.Fatalf("decider view missing: %#v", view.Plan)
	}
	if got := view.Plan.Tasks[0].Decider.Suggested; got != "high" {
		t.Fatalf("suggested = %q, want high", got)
	}
	if view.Plan.Tasks[0].Decider.Ran == nil || *view.Plan.Tasks[0].Decider.Ran != "low" {
		t.Fatalf("ran = %v, want low", view.Plan.Tasks[0].Decider.Ran)
	}
	if view.Plan.Audit == nil || view.Plan.Audit.Proposal != "approve" {
		t.Fatalf("audit = %#v, want proposal approve", view.Plan.Audit)
	}
	if view.Plan.Audit == nil || len(view.Plan.Audit.Findings) != 1 {
		t.Fatalf("audit findings = %v, want 1", view.Plan.Audit)
	}
}

func TestReadStateOrdersActiveByStartThenIdleByLastActivity(t *testing.T) {
	old := makePlansDir(t)
	young := makePlansDir(t)
	idle := makePlansDir(t)

	writePlan(t, old, "running", "old-r1", []fixtureTask{{ID: "one"}}, "trace-old")
	writeEvents(t, old, "trace-old", []map[string]any{
		ev("task.start", "old-r1", t1, map[string]any{"task": "one"}),
	})
	writePlan(t, young, "running", "young-r1", []fixtureTask{{ID: "one"}}, "trace-young")
	writeEvents(t, young, "trace-young", []map[string]any{
		ev("task.start", "young-r1", t4, map[string]any{"task": "one"}),
	})
	writePlan(t, idle, "done", "idle-r1", []fixtureTask{{ID: "one"}}, "trace-idle")
	writeEvents(t, idle, "trace-idle", []map[string]any{
		ev("plan.end", "idle-r1", t3, map[string]any{"data": map[string]any{"gate_pass": true}}),
	})

	state := ReadState([]repos.RepoConfig{
		{Name: "idle", Dir: idle},
		{Name: "old", Dir: old},
		{Name: "young", Dir: young},
	}, nowMs, ptr("a note"))

	want := []string{"young", "old", "idle"}
	if got := namesOf(state.Repos); !reflect.DeepEqual(got, want) {
		t.Fatalf("repo order = %v, want %v", got, want)
	}
	if state.Message == nil || *state.Message != "a note" {
		t.Fatalf("message = %v, want a note", state.Message)
	}
	if wantNow := "2026-10-23T10:05:00.000Z"; state.Now != wantNow {
		t.Fatalf("now = %q, want %q", state.Now, wantNow)
	}
}

func TestReadStatePutsRepoWithoutPlanLastAndKeepsConfiguredOrderOnTies(t *testing.T) {
	first := makePlansDir(t)
	second := makePlansDir(t)
	empty := filepath.Join(makePlansDir(t), "missing")

	writePlan(t, first, "done", "a-r1", []fixtureTask{{ID: "one"}}, "trace-a")
	writeEvents(t, first, "trace-a", []map[string]any{
		ev("plan.end", "a-r1", t2, map[string]any{"data": map[string]any{}}),
	})
	writePlan(t, second, "done", "b-r1", []fixtureTask{{ID: "one"}}, "trace-b")
	writeEvents(t, second, "trace-b", []map[string]any{
		ev("plan.end", "b-r1", t2, map[string]any{"data": map[string]any{}}),
	})

	state := ReadState([]repos.RepoConfig{
		{Name: "first", Dir: first},
		{Name: "second", Dir: second},
		{Name: "empty", Dir: empty},
	}, nowMs, nil)

	want := []string{"first", "second", "empty"}
	if got := namesOf(state.Repos); !reflect.DeepEqual(got, want) {
		t.Fatalf("repo order = %v, want %v", got, want)
	}
	if state.Message != nil {
		t.Fatalf("message = %v, want nil", *state.Message)
	}
}

func TestReadStateReturnsNoReposForEmptyConfiguration(t *testing.T) {
	state := ReadState([]repos.RepoConfig{}, nowMs, nil)
	if state.Repos == nil {
		t.Fatalf("repos is nil, want []")
	}
	if len(state.Repos) != 0 {
		t.Fatalf("repos = %v, want []", state.Repos)
	}
	if state.Message != nil {
		t.Fatalf("message = %v, want nil", *state.Message)
	}
}

func TestReadRepoKeepsReadingWhenSessionFileIsUnreadable(t *testing.T) {
	dir := makePlansDir(t)
	writePlan(t, dir, "running", "p-r1", []fixtureTask{{ID: "one"}}, "trace-a")
	writeEvents(t, dir, "trace-a", []map[string]any{
		ev("task.start", "p-r1", t1, map[string]any{"task": "one"}),
	})
	if err := os.MkdirAll(filepath.Join(dir, "sessions", "p-r1"), 0o700); err != nil {
		t.Fatalf("mkdir sessions: %v", err)
	}

	view := ReadRepo(repo(dir), nowMs)
	if view.Plan == nil || view.Plan.ID != "p-r1" {
		t.Fatalf("plan = %#v, want id p-r1", view.Plan)
	}
	if !view.Active {
		t.Fatalf("active = false, want true")
	}
}
