package service

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"pi-monitor/internal/model"
	"pi-monitor/internal/repos"
)

const (
	nowISO = "2026-10-23T10:05:00.000Z"
	t1     = "2026-10-23T10:00:00.000Z"
	t2     = "2026-10-23T10:00:01.000Z"
	t3     = "2026-10-23T10:00:02.000Z"
	t4     = "2026-10-23T10:00:03.000Z"
)

// fixedNow is the clock the tests inject.
func fixedNow(t *testing.T) int64 {
	t.Helper()
	ms, ok := model.ParseTime(nowISO)
	if !ok {
		t.Fatalf("fixed clock %q does not parse", nowISO)
	}
	return ms
}

// makePlansDir builds the folder set of a plans folder, like the monitor
// fixtures do.
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

// finishedSession is a transcript whose last message is a finished assistant
// turn, so the summary reports ended.
func finishedSession() string {
	return `{"type":"session","timestamp":"` + t1 + `","id":"p1.t1.a1"}
{"type":"model_change","timestamp":"` + t2 + `","modelId":"opencode-go/beam-free"}
{"type":"message","timestamp":"` + t3 + `","message":{"role":"user","content":[{"type":"text","text":"do the thing"}]}}
{"type":"message","timestamp":"` + t4 + `","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"stopReason":"stop"}}
`
}

// writeSession writes a session file for plan under sessions/<plan>.
func writeSession(t *testing.T, plansDir, plan, id, text string) string {
	t.Helper()
	folder := filepath.Join(plansDir, "sessions", plan)
	if err := os.MkdirAll(folder, 0o700); err != nil {
		t.Fatalf("mkdir sessions/%s: %v", plan, err)
	}
	file := filepath.Join(folder, "2026-10-23T10-00-00-000Z_"+id+".jsonl")
	if err := os.WriteFile(file, []byte(text), 0o600); err != nil {
		t.Fatalf("write session %s: %v", id, err)
	}
	return file
}

// newService builds a service over the one repo, with a pointer-free message.
func newService(t *testing.T, dir string) *Service {
	t.Helper()
	now := fixedNow(t)
	return New(Options{
		Repos: func() ([]repos.RepoConfig, *string) {
			return []repos.RepoConfig{{Name: "item-a", Dir: dir}}, nil
		},
		Now: func() int64 { return now },
	})
}

func TestStateBuildsTheBoard(t *testing.T) {
	dir := makePlansDir(t)
	message := "2 more repos ignored (limit 24)"
	now := fixedNow(t)
	svc := New(Options{
		Repos: func() ([]repos.RepoConfig, *string) {
			return []repos.RepoConfig{{Name: "item-a", Dir: dir}}, &message
		},
		Now: func() int64 { return now },
	})

	got := svc.State()
	if got.Message == nil || *got.Message != message {
		t.Fatalf("State message = %v, want %q", got.Message, message)
	}
	if len(got.Repos) != 1 || got.Repos[0].Name != "item-a" {
		t.Fatalf("State repos = %+v, want the one configured repo", got.Repos)
	}
	if got.Repos[0].Message == nil || *got.Repos[0].Message != "No plan has run yet" {
		t.Fatalf("repo message = %v, want %q", got.Repos[0].Message, "No plan has run yet")
	}
	if got.Now != "2026-10-23T10:05:00.000Z" {
		t.Fatalf("State now = %q, want the injected clock", got.Now)
	}
}

func TestSessionPageResumesFromAfter(t *testing.T) {
	dir := makePlansDir(t)
	writeSession(t, dir, "p1", "p1.t1.a1", finishedSession())
	svc := newService(t, dir)

	page, err := svc.Session("item-a", "p1", "p1.t1.a1", 0)
	if err != nil {
		t.Fatalf("Session = %v, want a page", err)
	}
	if page.ID != "p1.t1.a1" {
		t.Fatalf("page id = %q, want p1.t1.a1", page.ID)
	}
	if !page.Ended || page.Live {
		t.Fatalf("ended = %v, live = %v, want ended true and live false", page.Ended, page.Live)
	}
	if page.Entries == nil {
		t.Fatalf("entries = nil, want a non-nil slice")
	}
	if len(page.Entries) == 0 {
		t.Fatalf("entries = empty, want the transcript")
	}
	if page.Next <= 0 {
		t.Fatalf("next = %d, want a positive cursor", page.Next)
	}

	rest, err := svc.Session("item-a", "p1", "p1.t1.a1", page.Next)
	if err != nil {
		t.Fatalf("Session after %d = %v, want a page", page.Next, err)
	}
	if rest.Entries == nil {
		t.Fatalf("rest entries = nil, want an empty slice")
	}
	if len(rest.Entries) != 0 {
		t.Fatalf("rest entries = %d, want none after the cursor", len(rest.Entries))
	}
	if rest.Next != page.Next {
		t.Fatalf("rest next = %d, want %d", rest.Next, page.Next)
	}
}

func TestSessionLiveUsesTheInjectedClock(t *testing.T) {
	dir := makePlansDir(t)
	// A transcript with no finished assistant turn does not count as ended.
	file := writeSession(t, dir, "p1", "p1.t1.a1", `{"type":"session","timestamp":"`+t1+`"}
{"type":"message","timestamp":"`+t3+`","message":{"role":"user","content":"go"}}
`)
	base, ok := model.ParseTime(t1)
	if !ok {
		t.Fatalf("time %q does not parse", t1)
	}
	if err := os.Chtimes(file, time.UnixMilli(base), time.UnixMilli(base)); err != nil {
		t.Fatalf("chtimes: %v", err)
	}

	liveAt := func(offsetMs int64) bool {
		svc := New(Options{
			Repos: func() ([]repos.RepoConfig, *string) {
				return []repos.RepoConfig{{Name: "item-a", Dir: dir}}, nil
			},
			Now: func() int64 { return base + offsetMs },
		})
		page, err := svc.Session("item-a", "p1", "p1.t1.a1", 0)
		if err != nil {
			t.Fatalf("Session = %v, want a page", err)
		}
		if page.Ended {
			t.Fatalf("ended = true, want a running session")
		}
		return page.Live
	}

	if !liveAt(0) {
		t.Fatalf("live at the mtime = false, want true")
	}
	if !liveAt(30000) {
		t.Fatalf("live 30s after the mtime = false, want true (the boundary is inclusive)")
	}
	if liveAt(30001) {
		t.Fatalf("live 30.001s after the mtime = true, want false")
	}
}

func TestSessionRefusals(t *testing.T) {
	dir := makePlansDir(t)
	writeSession(t, dir, "p1", "p1.t1.a1", finishedSession())
	svc := newService(t, dir)

	cases := []struct {
		name  string
		repo  string
		plan  string
		id    string
		after int
		want  error
	}{
		{name: "unknown repo", repo: "nope", plan: "p1", id: "p1.t1.a1", want: ErrNotFound},
		{name: "bad plan id", repo: "item-a", plan: "bad plan", id: "p1.t1.a1", want: ErrBadRequest},
		{name: "bad session id", repo: "item-a", plan: "p1", id: "bad id", want: ErrBadRequest},
		{name: "negative after", repo: "item-a", plan: "p1", id: "p1.t1.a1", after: -1, want: ErrBadRequest},
		{name: "missing session", repo: "item-a", plan: "p1", id: "p1.t1.a9", want: ErrNotFound},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			_, err := svc.Session(testCase.repo, testCase.plan, testCase.id, testCase.after)
			if !errors.Is(err, testCase.want) {
				t.Fatalf("Session(%q, %q, %q, %d) error = %v, want %v",
					testCase.repo, testCase.plan, testCase.id, testCase.after, err, testCase.want)
			}
		})
	}
}

func TestSessionSymlinkOutsideIsNotFound(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "plans")
	if err := os.MkdirAll(filepath.Join(dir, "sessions", "p1"), 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	outside := filepath.Join(root, "outside.jsonl")
	if err := os.WriteFile(outside, []byte(finishedSession()), 0o600); err != nil {
		t.Fatalf("write outside: %v", err)
	}
	link := filepath.Join(dir, "sessions", "p1", "2026-10-23T10-00-00-000Z_p1.t1.a1.jsonl")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	svc := newService(t, dir)
	if _, err := svc.Session("item-a", "p1", "p1.t1.a1", 0); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Session through an escaping symlink = %v, want ErrNotFound", err)
	}
}

func TestPollEmitsAtStartThenOnChangeAndStops(t *testing.T) {
	dir := makePlansDir(t)
	trace := filepath.Join(dir, "traces", "p1.jsonl")
	if err := os.WriteFile(trace, []byte("{\"kind\":\"plan.drafted\"}\n"), 0o600); err != nil {
		t.Fatalf("write trace: %v", err)
	}
	svc := newService(t, dir)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	emits := make(chan struct{}, 16)
	done := make(chan struct{})
	go func() {
		defer close(done)
		svc.Poll(ctx, 5*time.Millisecond, func() { emits <- struct{}{} })
	}()

	waitEmit := func(what string) {
		t.Helper()
		select {
		case <-emits:
		case <-time.After(2 * time.Second):
			t.Fatalf("no emit for %s", what)
		}
	}
	waitEmit("the start")

	// A different size changes the signature regardless of the mtime
	// resolution.
	if err := os.WriteFile(trace, []byte("{\"kind\":\"plan.drafted\",\"data\":{}}\n"), 0o600); err != nil {
		t.Fatalf("change trace: %v", err)
	}
	waitEmit("the trace change")

	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatalf("Poll did not stop after the context was cancelled")
	}

	select {
	case <-emits:
		t.Fatalf("Poll emitted after the context was cancelled")
	default:
	}
}
