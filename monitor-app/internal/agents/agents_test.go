package agents

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"pi-monitor/internal/repos"
	"pi-monitor/internal/sessions"
	"pi-monitor/internal/settings"
)

// The fixtures are synthetic session files built from the structure in the
// spec. Nothing here reads a real agent folder: Home is always a temporary
// folder, and every working folder and repo root is created so it resolves the
// same way the session header names it (on macOS t.TempDir lives under a
// symlink).

func writeFixture(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func encodeLines(t *testing.T, lines []any) []byte {
	t.Helper()
	builder := strings.Builder{}
	for _, line := range lines {
		data, err := json.Marshal(line)
		if err != nil {
			t.Fatalf("marshal fixture line: %v", err)
		}
		builder.Write(data)
		builder.WriteByte('\n')
	}
	return []byte(builder.String())
}

func headerLine(id, cwd, title string) map[string]any {
	line := map[string]any{
		"type":      "session",
		"version":   3,
		"id":        id,
		"timestamp": "2026-11-02T10:00:00Z",
		"cwd":       cwd,
	}
	if title != "" {
		line["title"] = title
	}
	return line
}

func sessionBody(id string) []any {
	return []any{
		map[string]any{"type": "thinking_level_change", "thinkingLevel": "high", "timestamp": "2026-11-02T10:00:01Z"},
		map[string]any{"type": "model_change", "modelId": "model-change", "timestamp": "2026-11-02T10:00:02Z"},
		map[string]any{
			"type":      "message",
			"timestamp": "2026-11-02T10:00:03Z",
			"message": map[string]any{
				"role":    "user",
				"content": []any{map[string]any{"type": "text", "text": "prompt " + id}},
			},
		},
		map[string]any{
			"type":      "message",
			"timestamp": "2026-11-02T10:00:04Z",
			"message": map[string]any{
				"role":       "assistant",
				"model":      "assistant-model",
				"stopReason": "endTurn",
				"content":    []any{map[string]any{"type": "text", "text": "done"}},
				"usage": map[string]any{
					"input":  10,
					"output": 5,
					"cost":   map[string]any{"total": 0.25},
				},
			},
		},
	}
}

func setMtime(t *testing.T, file string, mtimeMs int64) {
	t.Helper()
	at := time.UnixMilli(mtimeMs)
	if err := os.Chtimes(file, at, at); err != nil {
		t.Fatalf("chtimes %s: %v", file, err)
	}
}

func addSession(t *testing.T, root, folder, id, cwd, title string, mtimeMs int64) string {
	t.Helper()
	file := filepath.Join(root, folder, "2026-11-02T10-00-00-000Z_"+id+".jsonl")
	lines := append([]any{headerLine(id, cwd, title)}, sessionBody(id)...)
	writeFixture(t, file, encodeLines(t, lines))
	setMtime(t, file, mtimeMs)
	return file
}

func addRepo(t *testing.T, home, name, relative string) (repos.RepoConfig, string) {
	t.Helper()
	root := filepath.Join(home, filepath.FromSlash(relative))
	plans := filepath.Join(root, ".plans")
	if err := os.MkdirAll(plans, 0o700); err != nil {
		t.Fatalf("mkdir repo %s: %v", plans, err)
	}
	return repos.RepoConfig{Name: name, Dir: plans}, root
}

func ompSessions(home string) string {
	return filepath.Join(home, ".omp", "agent", "sessions")
}

func piSessions(home string) string {
	return filepath.Join(home, ".pi", "agent", "sessions")
}

func bothOn(home, scope string, list []repos.RepoConfig, nowMs int64) Options {
	return Options{
		Home:     home,
		Settings: settings.Settings{OmpSessions: true, PiSessions: true, Scope: scope},
		Repos:    list,
		NowMs:    nowMs,
	}
}

func TestBothTogglesOffReadsNothing(t *testing.T) {
	home := t.TempDir()
	off := Options{Home: home, Settings: settings.Default(), NowMs: 1_000_000}
	reader := New()

	// The roots do not exist at all: nothing to read and nothing to fail.
	if got := reader.List(off); len(got) != 0 {
		t.Fatalf("List with both toggles off and no roots = %d groups, want 0", len(got))
	}
	if _, ok := reader.Find(off, "omp", "alpha", "omp-one"); ok {
		t.Fatalf("Find with both toggles off = true, want false")
	}
	if got := reader.Signature(off); got != "" {
		t.Fatalf("Signature with both toggles off = %q, want empty", got)
	}

	// Even with a full tree, both toggles off lists nothing.
	_, root := addRepo(t, home, "alpha", "repos/alpha")
	addSession(t, ompSessions(home), "slug", "omp-one", root, "omp title", 1_000_000)
	addSession(t, piSessions(home), "slug", "pi-one", root, "pi title", 2_000_000)
	if got := reader.List(off); len(got) != 0 {
		t.Fatalf("List with both toggles off = %d groups, want 0", len(got))
	}
	if got := reader.Signature(off); got != "" {
		t.Fatalf("Signature with both toggles off = %q, want empty", got)
	}
	if _, ok := reader.Find(off, "pi", "alpha", "pi-one"); ok {
		t.Fatalf("Find with both toggles off = true, want false")
	}
}

func TestListsOmpAndPiSessionsUnderTheirRepo(t *testing.T) {
	home := t.TempDir()
	repo, root := addRepo(t, home, "alpha", "repos/alpha")
	ompFile := addSession(t, ompSessions(home), "omp-slug", "omp-one", root, "omp title", 1_000_000)
	addSession(t, piSessions(home), "pi-slug", "pi-one", root, "pi title", 2_000_000)

	o := bothOn(home, settings.ScopeRepos, []repos.RepoConfig{repo}, 2_000_000)
	groups := New().List(o)
	if len(groups) != 1 {
		t.Fatalf("List = %d groups, want 1", len(groups))
	}
	if groups[0].Name != "alpha" {
		t.Fatalf("group name = %q, want alpha", groups[0].Name)
	}
	if len(groups[0].Sessions) != 2 {
		t.Fatalf("group has %d sessions, want 2", len(groups[0].Sessions))
	}

	newest := groups[0].Sessions[0]
	if newest.Agent != "pi" || newest.ID != "pi-one" {
		t.Fatalf("newest session = %s/%s, want pi/pi-one", newest.Agent, newest.ID)
	}
	oldest := groups[0].Sessions[1]
	if oldest.Agent != "omp" || oldest.ID != "omp-one" {
		t.Fatalf("oldest session = %s/%s, want omp/omp-one", oldest.Agent, oldest.ID)
	}
	if oldest.Title != "omp title" {
		t.Fatalf("title = %q, want omp title", oldest.Title)
	}
	if oldest.Model == nil || *oldest.Model != "model-change" {
		t.Fatalf("model = %v, want model-change", oldest.Model)
	}
	if oldest.Cwd != root {
		t.Fatalf("cwd = %q, want %q", oldest.Cwd, root)
	}
	if oldest.Group != "alpha" {
		t.Fatalf("session group = %q, want alpha", oldest.Group)
	}
	if oldest.StartedAt == nil || *oldest.StartedAt != "2026-11-02T10:00:00Z" {
		t.Fatalf("startedAt = %v, want the session timestamp", oldest.StartedAt)
	}
	if oldest.MtimeMs != 1_000_000 {
		t.Fatalf("mtimeMs = %v, want 1000000", oldest.MtimeMs)
	}
	if oldest.Tokens == nil || *oldest.Tokens != 15 {
		t.Fatalf("tokens = %v, want 15", oldest.Tokens)
	}
	if oldest.Cost == nil || *oldest.Cost != 0.25 {
		t.Fatalf("cost = %v, want 0.25", oldest.Cost)
	}
	if oldest.Thinking == nil || *oldest.Thinking != "high" {
		t.Fatalf("thinking = %v, want high", oldest.Thinking)
	}
	if oldest.LastTool != nil {
		t.Fatalf("lastTool = %v, want nil", oldest.LastTool)
	}
	if !oldest.Ended || oldest.Live {
		t.Fatalf("ended = %v, live = %v, want ended and not live", oldest.Ended, oldest.Live)
	}

	if _, ok := New().Find(o, "omp", "alpha", "omp-one"); !ok {
		t.Fatalf("Find did not find the listed session file %s", ompFile)
	}
}

func TestCwdInsideSubfolderCounts(t *testing.T) {
	home := t.TempDir()
	repo, root := addRepo(t, home, "alpha", "repos/alpha")
	cwd := filepath.Join(root, "code", "sub")
	if err := os.MkdirAll(cwd, 0o700); err != nil {
		t.Fatalf("mkdir cwd: %v", err)
	}
	addSession(t, ompSessions(home), "slug", "omp-one", cwd, "inside subfolder", 1_000_000)

	groups := New().List(bothOn(home, settings.ScopeRepos, []repos.RepoConfig{repo}, 1_000_000))
	if len(groups) != 1 || groups[0].Name != "alpha" || len(groups[0].Sessions) != 1 {
		t.Fatalf("List = %#v, want one alpha session", groups)
	}
}

func TestDeepestRootWins(t *testing.T) {
	home := t.TempDir()
	alpha, _ := addRepo(t, home, "alpha", "repos/alpha")
	deep, deepRoot := addRepo(t, home, "deep", "repos/alpha/deep")
	cwd := filepath.Join(deepRoot, "code")
	if err := os.MkdirAll(cwd, 0o700); err != nil {
		t.Fatalf("mkdir cwd: %v", err)
	}
	addSession(t, ompSessions(home), "slug", "omp-one", cwd, "deep session", 1_000_000)

	for _, list := range [][]repos.RepoConfig{{alpha, deep}, {deep, alpha}} {
		groups := New().List(bothOn(home, settings.ScopeRepos, list, 1_000_000))
		if len(groups) != 1 || groups[0].Name != "deep" {
			t.Fatalf("List with repos %#v = %#v, want only the deep group", list, groups)
		}
	}
}

func TestOutsideEveryRepoHiddenThenListedUnderAll(t *testing.T) {
	home := t.TempDir()
	repo, _ := addRepo(t, home, "alpha", "repos/alpha")
	outside := filepath.Join(home, "outside", "work", "project")
	if err := os.MkdirAll(outside, 0o700); err != nil {
		t.Fatalf("mkdir outside: %v", err)
	}
	addSession(t, ompSessions(home), "slug", "outside-one", outside, "outside title", 5_000_000)

	if got := New().List(bothOn(home, settings.ScopeRepos, []repos.RepoConfig{repo}, 5_000_000)); len(got) != 0 {
		t.Fatalf("scope repos listed an outside session: %#v", got)
	}

	allGroups := New().List(bothOn(home, settings.ScopeAll, []repos.RepoConfig{repo}, 5_000_000))
	if len(allGroups) != 1 || allGroups[0].Name != "work/project" {
		t.Fatalf("scope all groups = %#v, want one work/project group", allGroups)
	}
	if len(allGroups[0].Sessions) != 1 || allGroups[0].Sessions[0].ID != "outside-one" {
		t.Fatalf("scope all sessions = %#v, want outside-one", allGroups[0].Sessions)
	}

	// A one-part working folder that equals an added repo's name gets the
	// not-added suffix, because it is not that repo.
	addSession(t, ompSessions(home), "slug2", "alpha-one", "alpha", "relative cwd", 6_000_000)
	withSuffix := New().List(bothOn(home, settings.ScopeAll, []repos.RepoConfig{repo}, 6_000_000))
	if len(withSuffix) != 2 {
		t.Fatalf("scope all groups = %#v, want 2", withSuffix)
	}
	if withSuffix[0].Name != "alpha (not added)" {
		t.Fatalf("newest group = %q, want the not-added suffix", withSuffix[0].Name)
	}
	if withSuffix[1].Name != "work/project" {
		t.Fatalf("older group = %q, want work/project", withSuffix[1].Name)
	}
}

func TestSymlinkLeavingRootIsSkipped(t *testing.T) {
	home := t.TempDir()
	repo, root := addRepo(t, home, "alpha", "repos/alpha")
	outsideFolder := filepath.Join(home, "outside")
	outsideFile := filepath.Join(outsideFolder, "2026-11-02T10-00-00-000Z_outside-one.jsonl")
	writeFixture(t, outsideFile, encodeLines(t, append([]any{headerLine("outside-one", root, "outside")}, sessionBody("outside-one")...)))
	setMtime(t, outsideFile, 1_000_000)

	slug := filepath.Join(ompSessions(home), "slug")
	if err := os.MkdirAll(slug, 0o700); err != nil {
		t.Fatalf("mkdir slug: %v", err)
	}
	if err := os.Symlink(outsideFile, filepath.Join(slug, "2026-11-02T10-00-00-000Z_link.jsonl")); err != nil {
		t.Fatalf("symlink file: %v", err)
	}
	if err := os.Symlink(outsideFolder, filepath.Join(ompSessions(home), "linked-slug")); err != nil {
		t.Fatalf("symlink folder: %v", err)
	}

	groups := New().List(bothOn(home, settings.ScopeRepos, []repos.RepoConfig{repo}, 1_000_000))
	if len(groups) != 0 {
		t.Fatalf("List followed a symlink out of the root: %#v", groups)
	}
	if got := New().Signature(bothOn(home, settings.ScopeAll, []repos.RepoConfig{repo}, 1_000_000)); got != "" {
		t.Fatalf("Signature followed a symlink out of the root: %q", got)
	}
}

func TestHeaderlessAndOversizeFilesAreSkipped(t *testing.T) {
	home := t.TempDir()
	repo, root := addRepo(t, home, "alpha", "repos/alpha")

	headerless := filepath.Join(ompSessions(home), "slug", "2026-11-02T10-00-00-000Z_nohdr.jsonl")
	writeFixture(t, headerless, encodeLines(t, []any{map[string]any{
		"type":      "message",
		"timestamp": "2026-11-02T10:00:03Z",
		"message":   map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": "no header"}}},
	}}))
	setMtime(t, headerless, 1_000_000)

	addSession(t, ompSessions(home), "slug", "omp-ok", root, "a small session", 2_000_000)

	groups := New().List(bothOn(home, settings.ScopeRepos, []repos.RepoConfig{repo}, 2_000_000))
	if len(groups) != 1 || len(groups[0].Sessions) != 1 || groups[0].Sessions[0].ID != "omp-ok" {
		t.Fatalf("List = %#v, want only omp-ok", groups)
	}

	saved := maxFileBytes
	maxFileBytes = 4096
	defer func() { maxFileBytes = saved }()

	big := filepath.Join(ompSessions(home), "slug", "2026-11-02T10-00-00-000Z_omp-big.jsonl")
	writeFixture(t, big, encodeLines(t, append([]any{headerLine("omp-big", root, "a big session")}, map[string]any{
		"type":      "message",
		"timestamp": "2026-11-02T10:00:05Z",
		"message":   map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": strings.Repeat("x", 5000)}}},
	})))
	setMtime(t, big, 3_000_000)

	groups = New().List(bothOn(home, settings.ScopeRepos, []repos.RepoConfig{repo}, 3_000_000))
	if len(groups) != 1 || len(groups[0].Sessions) != 1 || groups[0].Sessions[0].ID != "omp-ok" {
		t.Fatalf("List with a lowered size cap = %#v, want only omp-ok", groups)
	}
}

func TestAtMostFiftyPerAgentAndGroup(t *testing.T) {
	home := t.TempDir()
	repo, root := addRepo(t, home, "alpha", "repos/alpha")
	for index := 0; index < 60; index++ {
		id := fmt.Sprintf("s%02d", index)
		addSession(t, ompSessions(home), "slug", id, root, "session "+id, int64(1_000_000+index*1000))
	}

	groups := New().List(bothOn(home, settings.ScopeRepos, []repos.RepoConfig{repo}, 2_000_000))
	if len(groups) != 1 {
		t.Fatalf("List = %d groups, want 1", len(groups))
	}
	got := groups[0].Sessions
	if len(got) != MaxPerGroup {
		t.Fatalf("List kept %d sessions, want %d", len(got), MaxPerGroup)
	}
	if got[0].ID != "s59" {
		t.Fatalf("newest session = %q, want s59", got[0].ID)
	}
	if got[len(got)-1].ID != "s10" {
		t.Fatalf("oldest kept session = %q, want s10", got[len(got)-1].ID)
	}
}

func TestGroupAndSessionOrdering(t *testing.T) {
	home := t.TempDir()
	alpha, alphaRoot := addRepo(t, home, "alpha", "repos/alpha")
	beta, betaRoot := addRepo(t, home, "beta", "repos/beta")
	addSession(t, ompSessions(home), "a", "alpha-old", alphaRoot, "alpha old", 1_000_000)
	addSession(t, ompSessions(home), "a", "alpha-new", alphaRoot, "alpha new", 2_000_000)
	addSession(t, piSessions(home), "b", "beta-new", betaRoot, "beta new", 5_000_000)

	groups := New().List(bothOn(home, settings.ScopeRepos, []repos.RepoConfig{alpha, beta}, 5_000_000))
	if len(groups) != 2 {
		t.Fatalf("List = %d groups, want 2", len(groups))
	}
	if groups[0].Name != "alpha" || groups[1].Name != "beta" {
		t.Fatalf("group order = %q, %q, want alpha then beta", groups[0].Name, groups[1].Name)
	}
	if groups[0].Sessions[0].ID != "alpha-new" || groups[0].Sessions[1].ID != "alpha-old" {
		t.Fatalf("alpha session order = %q, %q, want newest first", groups[0].Sessions[0].ID, groups[0].Sessions[1].ID)
	}

	// Under scope all the groups of no added repo come after the repos, by
	// their newest session.
	outside := filepath.Join(home, "outside", "x", "y")
	if err := os.MkdirAll(outside, 0o700); err != nil {
		t.Fatalf("mkdir outside: %v", err)
	}
	addSession(t, ompSessions(home), "c", "outside-new", outside, "outside new", 9_000_000)
	allGroups := New().List(bothOn(home, settings.ScopeAll, []repos.RepoConfig{alpha, beta}, 9_000_000))
	if len(allGroups) != 3 {
		t.Fatalf("scope all groups = %d, want 3", len(allGroups))
	}
	if allGroups[0].Name != "alpha" || allGroups[1].Name != "beta" || allGroups[2].Name != "x/y" {
		t.Fatalf("scope all order = %q, %q, %q, want alpha, beta, x/y",
			allGroups[0].Name, allGroups[1].Name, allGroups[2].Name)
	}
}

func TestLiveUsesTheLaneStallWindow(t *testing.T) {
	home := t.TempDir()
	repo, root := addRepo(t, home, "alpha", "repos/alpha")
	now := int64(10_000_000)

	// A session that is still going: a header and a user prompt, no assistant
	// stop reason.
	file := filepath.Join(ompSessions(home), "slug", "2026-11-02T10-00-00-000Z_omp-live.jsonl")
	writeFixture(t, file, encodeLines(t, []any{
		headerLine("omp-live", root, "live session"),
		map[string]any{
			"type":      "message",
			"timestamp": "2026-11-02T10:00:03Z",
			"message":   map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": "still running"}}},
		},
	}))
	setMtime(t, file, now-1000)

	groups := New().List(bothOn(home, settings.ScopeRepos, []repos.RepoConfig{repo}, now))
	if len(groups) != 1 || !groups[0].Sessions[0].Live || groups[0].Sessions[0].Ended {
		t.Fatalf("recent unfinished session = %#v, want live and not ended", groups)
	}

	setMtime(t, file, now-40000)
	groups = New().List(bothOn(home, settings.ScopeRepos, []repos.RepoConfig{repo}, now))
	if len(groups) != 1 || groups[0].Sessions[0].Live {
		t.Fatalf("stale unfinished session = %#v, want not live", groups)
	}
}

func TestFindRejectsBadArgumentsAndUnlistedSessions(t *testing.T) {
	home := t.TempDir()
	repo, root := addRepo(t, home, "alpha", "repos/alpha")
	ompFile := addSession(t, ompSessions(home), "slug", "omp-one", root, "omp title", 1_000_000)
	addSession(t, piSessions(home), "slug", "pi-one", root, "pi title", 2_000_000)
	reader := New()
	o := bothOn(home, settings.ScopeRepos, []repos.RepoConfig{repo}, 2_000_000)

	got, ok := reader.Find(o, "omp", "alpha", "omp-one")
	if !ok || got != ompFile {
		t.Fatalf("Find(omp, alpha, omp-one) = %q, %v, want %q, true", got, ok, ompFile)
	}
	if _, ok := reader.Find(o, "codex", "alpha", "omp-one"); ok {
		t.Fatalf("Find with an unknown agent = true, want false")
	}
	if _, ok := reader.Find(o, "omp", "alpha", "bad/id"); ok {
		t.Fatalf("Find with a bad id = true, want false")
	}
	if _, ok := reader.Find(o, "omp", "alpha", "not-listed"); ok {
		t.Fatalf("Find with an unlisted id = true, want false")
	}
	if _, ok := reader.Find(o, "omp", "beta", "omp-one"); ok {
		t.Fatalf("Find with the wrong group = true, want false")
	}

	// pi-one is listed only while the Pi toggle is on.
	ompOnly := bothOn(home, settings.ScopeRepos, []repos.RepoConfig{repo}, 2_000_000)
	ompOnly.Settings.PiSessions = false
	if _, ok := reader.Find(ompOnly, "pi", "alpha", "pi-one"); ok {
		t.Fatalf("Find on a session of a disabled agent = true, want false")
	}
	if got := reader.List(ompOnly); len(got) != 1 || len(got[0].Sessions) != 1 || got[0].Sessions[0].Agent != "omp" {
		t.Fatalf("List with the Pi toggle off = %#v, want only the omp session", got)
	}
	if _, ok := reader.Find(o, "pi", "alpha", "pi-one"); !ok {
		t.Fatalf("Find on a listed Pi session = false, want true")
	}
}

func TestCacheReusesAnUnchangedFileAndReReadsAChangedOne(t *testing.T) {
	home := t.TempDir()
	repo, root := addRepo(t, home, "alpha", "repos/alpha")
	file := addSession(t, ompSessions(home), "slug", "omp-one", root, "cached", 1_000_000)

	infoCalls, summaryCalls := 0, 0
	originalInfo, originalSummary := readAgentInfo, summarize
	readAgentInfo = func(name string) (sessions.AgentInfo, bool) {
		infoCalls++
		return originalInfo(name)
	}
	summarize = func(name string) sessions.SessionSummary {
		summaryCalls++
		return originalSummary(name)
	}
	defer func() {
		readAgentInfo, summarize = originalInfo, originalSummary
	}()

	o := bothOn(home, settings.ScopeRepos, []repos.RepoConfig{repo}, 1_000_000)
	reader := New()
	first := reader.List(o)
	second := reader.List(o)
	if len(first) != 1 || len(second) != 1 {
		t.Fatalf("List = %#v then %#v, want one group each", first, second)
	}
	if infoCalls != 1 || summaryCalls != 1 {
		t.Fatalf("unchanged file read %d info and %d summary times, want 1 each", infoCalls, summaryCalls)
	}
	if first[0].Sessions[0].Cost == nil || second[0].Sessions[0].Cost == nil ||
		*first[0].Sessions[0].Cost != 0.25 || *second[0].Sessions[0].Cost != 0.25 {
		t.Fatalf("cached cost = %v then %v, want 0.25 each", first[0].Sessions[0].Cost, second[0].Sessions[0].Cost)
	}

	appendData, err := os.OpenFile(file, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatalf("open session for append: %v", err)
	}
	extra := encodeLines(t, []any{map[string]any{
		"type":      "message",
		"timestamp": "2026-11-02T10:00:06Z",
		"message": map[string]any{
			"role":       "assistant",
			"model":      "assistant-model",
			"stopReason": "endTurn",
			"content":    []any{map[string]any{"type": "text", "text": "more"}},
			"usage":      map[string]any{"input": 20, "output": 2, "cost": map[string]any{"total": 0.5}},
		},
	}})
	if _, err := appendData.Write(extra); err != nil {
		appendData.Close()
		t.Fatalf("append session: %v", err)
	}
	if err := appendData.Close(); err != nil {
		t.Fatalf("close session: %v", err)
	}
	setMtime(t, file, 2_000_000)

	third := reader.List(bothOn(home, settings.ScopeRepos, []repos.RepoConfig{repo}, 2_000_000))
	if len(third) != 1 || len(third[0].Sessions) != 1 {
		t.Fatalf("List after a change = %#v, want one group with one session", third)
	}
	if summaryCalls != 2 || infoCalls != 2 {
		t.Fatalf("changed file read %d info and %d summary times, want 2 each", infoCalls, summaryCalls)
	}
	if third[0].Sessions[0].Cost == nil || *third[0].Sessions[0].Cost != 0.75 {
		t.Fatalf("cost after the change = %v, want 0.75", third[0].Sessions[0].Cost)
	}
	if third[0].Sessions[0].Tokens == nil || *third[0].Sessions[0].Tokens != 37 {
		t.Fatalf("tokens after the change = %v, want 37", third[0].Sessions[0].Tokens)
	}
}

func TestSignatureEmptyWhenOffAndChangesWithMtime(t *testing.T) {
	home := t.TempDir()
	repo, root := addRepo(t, home, "alpha", "repos/alpha")
	off := Options{Home: home, Settings: settings.Default(), Repos: []repos.RepoConfig{repo}, NowMs: 5_000_000}
	reader := New()
	if got := reader.Signature(off); got != "" {
		t.Fatalf("Signature with both toggles off = %q, want empty", got)
	}

	file := addSession(t, ompSessions(home), "slug", "omp-one", root, "signature", 5_000_000)
	o := bothOn(home, settings.ScopeRepos, []repos.RepoConfig{repo}, 5_000_000)
	first := reader.Signature(o)
	if first == "" {
		t.Fatalf("Signature with a session = empty, want a line")
	}
	if !strings.HasPrefix(first, "omp|slug/2026-11-02T10-00-00-000Z_omp-one.jsonl|") {
		t.Fatalf("Signature line = %q, want the agent, folder and file prefix", first)
	}
	if strings.Count(first, "\n") != 0 {
		t.Fatalf("Signature with one file = %q, want one line", first)
	}

	setMtime(t, file, 6_000_000)
	if second := reader.Signature(o); second == first {
		t.Fatalf("Signature did not change with the mtime: %q", second)
	}
}

func TestOutsideRepoSessionIsReadForItsFirstLineOnly(t *testing.T) {
	home := t.TempDir()
	repo, _ := addRepo(t, home, "alpha", "repos/alpha")
	outside := filepath.Join(home, "outside", "work", "project")
	if err := os.MkdirAll(outside, 0o700); err != nil {
		t.Fatalf("mkdir outside: %v", err)
	}

	file := filepath.Join(ompSessions(home), "slug", "2026-11-02T10-00-00-000Z_outside-one.jsonl")
	data := encodeLines(t, []any{headerLine("outside-one", outside, "outside")})
	data = append(data, []byte(`{"broken":`+"\n")...)
	data = append(data, []byte(strings.Repeat("x", 1<<20)+"\n")...)
	writeFixture(t, file, data)
	setMtime(t, file, 3_000_000)

	infoCalls, summaryCalls := 0, 0
	originalInfo, originalSummary := readAgentInfo, summarize
	readAgentInfo = func(string) (sessions.AgentInfo, bool) {
		infoCalls++
		return sessions.AgentInfo{}, false
	}
	summarize = func(string) sessions.SessionSummary {
		summaryCalls++
		return sessions.SessionSummary{}
	}
	defer func() {
		readAgentInfo, summarize = originalInfo, originalSummary
	}()

	reader := New()
	o := bothOn(home, settings.ScopeRepos, []repos.RepoConfig{repo}, 3_000_000)
	if groups := reader.List(o); len(groups) != 0 {
		t.Fatalf("List = %#v, want no group for a session outside every repo", groups)
	}
	if infoCalls != 0 || summaryCalls != 0 {
		t.Fatalf("outside session read %d info and %d summary times, want 0 each", infoCalls, summaryCalls)
	}
	if _, ok := reader.Find(o, "omp", "work/project", "outside-one"); ok {
		t.Fatalf("Find on an unlisted outside session = true, want false")
	}
}
