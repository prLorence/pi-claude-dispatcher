package watch

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"pi-monitor/internal/repos"
)

const (
	sessionFileTS = "2026-10-22T18-02-28-549Z"
	t1            = "2026-10-23T10:00:00.000Z"
)

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

func sessionHeader(t *testing.T, id string) map[string]any {
	t.Helper()
	return map[string]any{"type": "session", "version": 3, "id": id}
}

func writeSession(t *testing.T, dir, planID, sessionID string, lines []map[string]any) string {
	t.Helper()
	folder := filepath.Join(dir, "sessions", planID)
	if err := os.MkdirAll(folder, 0o700); err != nil {
		t.Fatalf("mkdir sessions: %v", err)
	}
	file := filepath.Join(folder, sessionFileTS+"_"+sessionID+".jsonl")
	text := ""
	for _, line := range lines {
		raw, err := json.Marshal(line)
		if err != nil {
			t.Fatalf("marshal session line: %v", err)
		}
		text += string(raw) + "\n"
	}
	if err := os.WriteFile(file, []byte(text), 0o600); err != nil {
		t.Fatalf("write session: %v", err)
	}
	return file
}

func repo(name, dir string) repos.RepoConfig {
	return repos.RepoConfig{Name: name, Dir: dir}
}

func runningRepo(t *testing.T) string {
	t.Helper()
	dir := makePlansDir(t)
	writePlan(t, dir, "running", "p-r1", []fixtureTask{{ID: "one"}}, "trace-a")
	writeEvents(t, dir, "trace-a", []map[string]any{
		ev("task.start", "p-r1", t1, map[string]any{"task": "one"}),
	})
	return dir
}

func TestRepoSignatureKeepsItsOldResultsForOnePlansFolder(t *testing.T) {
	dir := makePlansDir(t)
	if got := RepoSignature(dir, nil); got == "" {
		t.Fatalf("RepoSignature(empty folder, nil) = \"\", want non-empty")
	}
	before := RepoSignature(dir, ptr("p-r1"))
	writePlan(t, dir, "running", "p-r1", []fixtureTask{{ID: "one"}}, "trace-a")
	if RepoSignature(dir, ptr("p-r1")) == before {
		t.Fatalf("signature did not change after a plan appeared")
	}
	if got := RepoSignature(filepath.Join(dir, "missing"), nil); got != "" {
		t.Fatalf("RepoSignature(missing) = %q, want \"\"", got)
	}
}

func TestSignatureIsEmptyForNoRepos(t *testing.T) {
	if got := Signature([]repos.RepoConfig{}); got != "" {
		t.Fatalf("signature = %q, want \"\"", got)
	}
}

func TestSignatureIsStableBetweenCallsWithNoChange(t *testing.T) {
	dir := runningRepo(t)
	list := []repos.RepoConfig{repo("one", dir)}
	if first, second := Signature(list), Signature(list); first != second {
		t.Fatalf("signature changed between calls: %q vs %q", first, second)
	}
}

func TestSignatureChangesWhenAFileOfAnyRepoChanges(t *testing.T) {
	a := runningRepo(t)
	b := runningRepo(t)
	list := []repos.RepoConfig{repo("a", a), repo("b", b)}
	before := Signature(list)
	writeEvents(t, b, "trace-a", []map[string]any{
		ev("task.end", "p-r1", t1, map[string]any{"task": "one"}),
	})
	if Signature(list) == before {
		t.Fatalf("signature did not change after a trace file changed")
	}
}

func TestSignatureChangesWhenSessionFileOfShownPlanAppears(t *testing.T) {
	dir := runningRepo(t)
	list := []repos.RepoConfig{repo("one", dir)}
	before := Signature(list)
	writeSession(t, dir, "p-r1", "p-r1.one.a1", []map[string]any{sessionHeader(t, "p-r1.one.a1")})
	if Signature(list) == before {
		t.Fatalf("signature did not change after a session file appeared")
	}
}

func TestSignatureDiffersBetweenReposWithSameContent(t *testing.T) {
	a := runningRepo(t)
	b := runningRepo(t)
	if Signature([]repos.RepoConfig{repo("a", a)}) == Signature([]repos.RepoConfig{repo("b", b)}) {
		t.Fatalf("signatures of two repos with the same content are equal")
	}
	if text := Signature([]repos.RepoConfig{repo("a", a), repo("b", b)}); !strings.Contains(text, "\n") {
		t.Fatalf("two-repo signature %q has no newline", text)
	}
}

func TestSignatureKeepsRepoWithoutPlansFolderInTheList(t *testing.T) {
	dir := runningRepo(t)
	missing := filepath.Join(makePlansDir(t), "nope")
	text := Signature([]repos.RepoConfig{repo("one", dir), repo("gone", missing)})
	if !strings.Contains(text, "gone=") {
		t.Fatalf("signature %q does not contain gone=", text)
	}
	if lines := strings.Split(text, "\n"); len(lines) != 2 {
		t.Fatalf("signature has %d lines, want 2", len(lines))
	}
}

func TestSignatureIgnoresChangeInSessionFolderOfUnshownPlan(t *testing.T) {
	dir := runningRepo(t)
	list := []repos.RepoConfig{repo("one", dir)}
	before := Signature(list)
	writeSession(t, dir, "other-plan", "other-plan.one.a1", []map[string]any{
		sessionHeader(t, "other-plan.one.a1"),
	})
	if got := Signature(list); got != before {
		t.Fatalf("signature changed for a session folder of an unshown plan")
	}
	writePlan(t, dir, "done", "other-plan", []fixtureTask{{ID: "one"}}, "trace-other")
	if Signature(list) == before {
		t.Fatalf("signature did not change after a done plan appeared")
	}
}

func TestSignatureNoticesNewDoneFolderName(t *testing.T) {
	dir := runningRepo(t)
	list := []repos.RepoConfig{repo("one", dir)}
	before := Signature(list)
	if err := os.MkdirAll(filepath.Join(dir, "done", "another"), 0o700); err != nil {
		t.Fatalf("mkdir done/another: %v", err)
	}
	if Signature(list) == before {
		t.Fatalf("signature did not change after a done folder appeared")
	}
}
