package plans

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

type fixtureTask struct {
	id        string
	dependsOn []string
	pair      string
	role      string
}

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

func fixturePlanText(id, trace string, tasks []fixtureTask) string {
	lines := []string{
		"---",
		"id: " + id,
		"trace: " + trace,
		"round: 1",
		"status: ready",
		"---",
		"## Context",
		"",
		"Fixture plan for the monitor tests.",
	}
	for _, task := range tasks {
		dependsOn := task.dependsOn
		if dependsOn == nil {
			dependsOn = []string{}
		}
		list, err := json.Marshal(dependsOn)
		if err != nil {
			panic(err)
		}
		lines = append(lines, "", "## task: "+task.id, "files: x.ts", "depends_on: "+string(list))
		if task.role != "" {
			lines = append(lines, "role: "+task.role)
		}
		if task.pair != "" {
			lines = append(lines, "pair: "+task.pair)
		}
		lines = append(lines, "", "Body line for "+task.id+".")
	}
	lines = append(lines, "")
	return joinLines(lines)
}

func joinLines(lines []string) string {
	text := ""
	for i, line := range lines {
		if i > 0 {
			text += "\n"
		}
		text += line
	}
	return text
}

func writePlan(t *testing.T, dir, where, id string, tasks []fixtureTask, trace string) {
	t.Helper()
	text := fixturePlanText(id, trace, tasks)
	if where == "running" {
		if err := os.WriteFile(filepath.Join(dir, "running", id+".md"), []byte(text), 0o600); err != nil {
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

// ev builds one trace event as the TypeScript fixture does.
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
	file := filepath.Join(dir, "traces", trace+".jsonl")
	handle, err := os.OpenFile(file, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatalf("open trace file: %v", err)
	}
	defer handle.Close()
	for _, event := range events {
		event["v"] = 1
		event["trace"] = trace
		data, err := json.Marshal(event)
		if err != nil {
			t.Fatalf("marshal event: %v", err)
		}
		if _, err := handle.WriteString(string(data) + "\n"); err != nil {
			t.Fatalf("write event: %v", err)
		}
	}
}

func setMTimes(t *testing.T, path string, when time.Time) {
	t.Helper()
	if err := os.Chtimes(path, when, when); err != nil {
		t.Fatalf("chtimes %s: %v", path, err)
	}
}

func requirePair(t *testing.T, got *string, want string) {
	t.Helper()
	if got == nil {
		t.Fatalf("pair = nil, want %q", want)
	}
	if *got != want {
		t.Fatalf("pair = %q, want %q", *got, want)
	}
}

func requireStringList(t *testing.T, got, want []string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("list = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("list = %v, want %v", got, want)
		}
	}
}

func TestParsePlanReadsFrontmatterAndBothDependsOnForms(t *testing.T) {
	tasks := joinLines([]string{
		"",
		"## task: one",
		"files: a.ts",
		"depends_on: [two, three]",
		"pair: reviewer",
		"role: implement",
		"",
		"Body.",
		"",
		"## task: two",
		"files: b.ts",
		"depends_on: []",
		"",
		"Body.",
		"",
		"## task: three",
		"files: c.ts",
		"depends_on: one, two",
		"",
		"Body.",
	})
	parsed := ParsePlan(planText("", tasks))
	if parsed == nil {
		t.Fatal("ParsePlan returned nil")
	}
	if parsed.ID != "20261023-monitor-r1" {
		t.Fatalf("id = %q", parsed.ID)
	}
	if parsed.Trace != "20261023-monitor" {
		t.Fatalf("trace = %q", parsed.Trace)
	}
	if parsed.Round != 2 {
		t.Fatalf("round = %d, want 2", parsed.Round)
	}
	if len(parsed.Tasks) != 3 {
		t.Fatalf("tasks length = %d, want 3", len(parsed.Tasks))
	}
	first := parsed.Tasks[0]
	if first.ID != "one" || first.Role != "implement" {
		t.Fatalf("first task = %#v", first)
	}
	requirePair(t, first.Pair, "reviewer")
	requireStringList(t, first.DependsOn, []string{"two", "three"})
	if len(parsed.Tasks[1].DependsOn) != 0 {
		t.Fatalf("second dependsOn = %v, want []", parsed.Tasks[1].DependsOn)
	}
	if parsed.Tasks[1].Pair != nil {
		t.Fatalf("second pair = %q, want nil", *parsed.Tasks[1].Pair)
	}
	requireStringList(t, parsed.Tasks[2].DependsOn, []string{"one", "two"})
}

// planText is the body of the TypeScript test helper: the same frontmatter and
// Context section, with the caller's extra text and tasks appended.
func planText(extra, tasks string) string {
	return joinLines([]string{
		"---",
		"id: 20261023-monitor-r1",
		"trace: 20261023-monitor",
		"round: 2",
		"status: ready",
		"---",
		"## Context",
		"",
		"Body text.",
		extra,
		tasks,
		"",
	})
}

func TestParsePlanDefaultsRoleTraceAndRound(t *testing.T) {
	text := joinLines([]string{
		"---",
		"id: p1",
		"---",
		"## task: t1",
		"files: a.ts",
		"",
		"Body.",
	})
	parsed := ParsePlan(text)
	if parsed == nil {
		t.Fatal("ParsePlan returned nil")
	}
	if parsed.Trace != "p1" {
		t.Fatalf("trace = %q, want p1", parsed.Trace)
	}
	if parsed.Round != 1 {
		t.Fatalf("round = %d, want 1", parsed.Round)
	}
	if parsed.Tasks[0].Role != "implement" {
		t.Fatalf("role = %q, want implement", parsed.Tasks[0].Role)
	}
	if parsed.Tasks[0].Pair != nil {
		t.Fatalf("pair = %q, want nil", *parsed.Tasks[0].Pair)
	}
	if len(parsed.Tasks[0].DependsOn) != 0 {
		t.Fatalf("dependsOn = %v, want []", parsed.Tasks[0].DependsOn)
	}
}

func TestParsePlanStripsTrailingCommentAndEmptyPair(t *testing.T) {
	text := joinLines([]string{
		"---",
		"id: p1",
		"---",
		"## task: t1",
		"pair: review # the pair role",
		"",
		"Body.",
		"## task: t2",
		"pair:",
		"",
		"Body.",
	})
	parsed := ParsePlan(text)
	if parsed == nil {
		t.Fatal("ParsePlan returned nil")
	}
	requirePair(t, parsed.Tasks[0].Pair, "review")
	if parsed.Tasks[1].Pair != nil {
		t.Fatalf("second pair = %q, want nil", *parsed.Tasks[1].Pair)
	}
}

func TestParsePlanStopsMetadataAtFirstNonKeyLine(t *testing.T) {
	text := joinLines([]string{
		"---",
		"id: p1",
		"---",
		"## task: t1",
		"depends_on: [a]",
		"This is prose, not metadata.",
		"role: qa",
		"",
		"Body.",
	})
	parsed := ParsePlan(text)
	if parsed == nil {
		t.Fatal("ParsePlan returned nil")
	}
	requireStringList(t, parsed.Tasks[0].DependsOn, []string{"a"})
	if parsed.Tasks[0].Role != "implement" {
		t.Fatalf("role = %q, want implement", parsed.Tasks[0].Role)
	}
}

func TestParsePlanReturnsNilWithoutIDAndHandlesNoTasks(t *testing.T) {
	if parsed := ParsePlan("---\ntrace: t\n---\n## task: a\n"); parsed != nil {
		t.Fatalf("ParsePlan without id = %#v, want nil", parsed)
	}
	if parsed := ParsePlan("no frontmatter at all"); parsed != nil {
		t.Fatalf("ParsePlan without frontmatter = %#v, want nil", parsed)
	}
	parsed := ParsePlan("---\nid: p1\n---\n## Context\n\nNothing.\n")
	if parsed == nil {
		t.Fatal("ParsePlan with no tasks returned nil")
	}
	if parsed.Tasks == nil {
		t.Fatal("tasks = nil, want a non-nil empty slice")
	}
	if len(parsed.Tasks) != 0 {
		t.Fatalf("tasks = %#v, want []", parsed.Tasks)
	}
}

func TestReadTraceEventsKeepsOnlyPlansEventsAndSkipsBadLines(t *testing.T) {
	dir := makePlansDir(t)
	trace := "tr"
	content := joinLines([]string{
		mustJSON(t, ev("task.start", "p1", "2026-10-22T10:00:00.000Z", map[string]any{"task": "a"})),
		"not json at all",
		mustJSON(t, ev("task.end", "p2", "2026-10-22T10:01:00.000Z", map[string]any{"task": "a"})),
		"[1,2,3]",
		`"just a string"`,
		"null",
		mustJSON(t, ev("task.end", "p1", "2026-10-22T10:02:00.000Z", map[string]any{"task": "a"})),
		"",
	})
	if err := os.WriteFile(filepath.Join(dir, "traces", trace+".jsonl"), []byte(content), 0o600); err != nil {
		t.Fatalf("write trace: %v", err)
	}
	events := ReadTraceEvents(dir, trace, "p1")
	if len(events) != 2 {
		t.Fatalf("events length = %d, want 2", len(events))
	}
	if events[0].Kind != "task.start" {
		t.Fatalf("first kind = %q, want task.start", events[0].Kind)
	}
	if events[1].Kind != "task.end" {
		t.Fatalf("second kind = %q, want task.end", events[1].Kind)
	}
	if events[1].Ts != "2026-10-22T10:02:00.000Z" {
		t.Fatalf("second ts = %q", events[1].Ts)
	}
}

func mustJSON(t *testing.T, event map[string]any) string {
	t.Helper()
	data, err := json.Marshal(event)
	if err != nil {
		t.Fatalf("marshal event: %v", err)
	}
	return string(data)
}

func TestReadTraceEventsReturnsEmptyListForMissingTraceFile(t *testing.T) {
	dir := makePlansDir(t)
	events := ReadTraceEvents(dir, "nope", "p1")
	if events == nil {
		t.Fatal("events = nil, want an empty slice")
	}
	if len(events) != 0 {
		t.Fatalf("events = %#v, want []", events)
	}
}

func TestReadTraceEventsKeepsEventsWithUnexpectedFieldTypes(t *testing.T) {
	dir := makePlansDir(t)
	writeEvents(t, dir, "tr", []map[string]any{
		ev("task.start", "p1", "2026-10-22T10:00:00.000Z", map[string]any{
			"attempt": "3",
			"data":    map[string]any{"ok": true},
		}),
		ev("task.end", "p1", "2026-10-22T10:01:00.000Z", map[string]any{
			"data": []any{1, 2, 3},
		}),
		ev("task.review", "p1", "2026-10-22T10:02:00.000Z", map[string]any{
			"attempt": 2,
			"data":    map[string]any{"verdict": "approve"},
		}),
	})

	events := ReadTraceEvents(dir, "tr", "p1")
	if len(events) != 3 {
		t.Fatalf("events length = %d, want 3", len(events))
	}
	if events[0].Attempt != nil {
		t.Fatalf("string attempt = %d, want nil", *events[0].Attempt)
	}
	if events[0].Data == nil || events[0].Data["ok"] != true {
		t.Fatalf("first data = %#v, want the object kept", events[0].Data)
	}
	if events[1].Data != nil {
		t.Fatalf("array data = %#v, want nil", events[1].Data)
	}
	if events[1].Kind != "task.end" {
		t.Fatalf("array data event kind = %q, want task.end", events[1].Kind)
	}
	if events[2].Attempt == nil || *events[2].Attempt != 2 {
		t.Fatalf("numeric attempt = %v, want 2", events[2].Attempt)
	}
}

func TestSelectPlanPrefersRunningPlanOverFinishedOne(t *testing.T) {
	dir := makePlansDir(t)
	writePlan(t, dir, "done", "old-plan", []fixtureTask{{id: "a"}}, "old-trace")
	writePlan(t, dir, "running", "live-plan", []fixtureTask{{id: "a"}}, "live-trace")
	if err := os.WriteFile(filepath.Join(dir, "running", "broken.md"), []byte("not a plan"), 0o600); err != nil {
		t.Fatalf("write broken plan: %v", err)
	}
	selected := SelectPlan(dir)
	if selected.Message != nil {
		t.Fatalf("message = %q, want nil", *selected.Message)
	}
	if !selected.Running {
		t.Fatal("running = false, want true")
	}
	if selected.Plan == nil || selected.Plan.ID != "live-plan" {
		t.Fatalf("plan = %#v, want live-plan", selected.Plan)
	}
}

func TestSelectPlanPicksNewestFinishedPlanByPlanEndTimestamp(t *testing.T) {
	dir := makePlansDir(t)
	writePlan(t, dir, "done", "first-plan", []fixtureTask{{id: "a"}}, "first-trace")
	writePlan(t, dir, "done", "second-plan", []fixtureTask{{id: "a"}}, "second-trace")
	writeEvents(t, dir, "first-trace", []map[string]any{
		ev("plan.end", "first-plan", "2026-10-22T20:00:00.000Z", map[string]any{"data": map[string]any{"gate_pass": true}}),
	})
	writeEvents(t, dir, "second-trace", []map[string]any{
		ev("plan.end", "second-plan", "2026-10-22T21:00:00.000Z", map[string]any{"data": map[string]any{"gate_pass": true}}),
	})
	setMTimes(t, filepath.Join(dir, "done", "first-plan"), time.Date(2026, 10, 22, 20, 30, 0, 0, time.UTC))
	setMTimes(t, filepath.Join(dir, "done", "second-plan"), time.Date(2026, 10, 22, 19, 0, 0, 0, time.UTC))

	selected := SelectPlan(dir)
	if selected.Running {
		t.Fatal("running = true, want false")
	}
	if selected.Message != nil {
		t.Fatalf("message = %q, want nil", *selected.Message)
	}
	if selected.Plan == nil || selected.Plan.ID != "second-plan" {
		t.Fatalf("plan = %#v, want second-plan", selected.Plan)
	}
}

func TestSelectPlanFallsBackToFolderMtimeWithoutPlanEndEvent(t *testing.T) {
	dir := makePlansDir(t)
	writePlan(t, dir, "done", "mtime-old", []fixtureTask{{id: "a"}}, "trace-old")
	writePlan(t, dir, "done", "mtime-new", []fixtureTask{{id: "b"}}, "trace-new")
	setMTimes(t, filepath.Join(dir, "done", "mtime-old"), time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC))
	setMTimes(t, filepath.Join(dir, "done", "mtime-new"), time.Date(2026, 10, 22, 10, 0, 0, 0, time.UTC))

	selected := SelectPlan(dir)
	if selected.Plan == nil || selected.Plan.ID != "mtime-old" {
		t.Fatalf("plan = %#v, want mtime-old", selected.Plan)
	}
}

func TestSelectPlanReportsBothMessages(t *testing.T) {
	dir := makePlansDir(t)
	empty := SelectPlan(dir)
	if empty.Plan != nil || empty.Running {
		t.Fatalf("empty = %#v, want no plan and not running", empty)
	}
	if empty.Message == nil || *empty.Message != "No plan has run yet" {
		t.Fatalf("empty message = %v, want No plan has run yet", empty.Message)
	}

	missing := filepath.Join(dir, "does-not-exist")
	absent := SelectPlan(missing)
	if absent.Plan != nil || absent.Running {
		t.Fatalf("absent = %#v, want no plan and not running", absent)
	}
	if absent.Message == nil || *absent.Message != "No plans folder found" {
		t.Fatalf("absent message = %v, want No plans folder found", absent.Message)
	}
}
