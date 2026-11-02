// Package service is the in-process replacement for the Bun HTTP server: it
// turns the configured repos into the monitor state, pages a session
// transcript, and polls the repos for changes.
//
// It is a port of the route handling of monitor/src/server/server.ts and its
// sessionPage helper. The Bun status code of a refusal is an error value here:
// ErrNotFound for a 404 and ErrBadRequest for a 400. The package binds no
// port: the Wails shell calls the methods directly and Poll emits the change
// event of spec R7.
package service

import (
	"context"
	"errors"
	"os"
	"regexp"
	"time"

	"pi-monitor/internal/fsx"
	"pi-monitor/internal/lanes"
	"pi-monitor/internal/model"
	"pi-monitor/internal/repos"
	"pi-monitor/internal/sessions"
	"pi-monitor/internal/state"
	"pi-monitor/internal/watch"
)

// ErrNotFound is the Bun server's 404: an unknown repo, a missing session file
// or a session file whose real path leaves the plans folder.
var ErrNotFound = errors.New("not found")

// ErrBadRequest is the Bun server's 400: a plan or session id outside the id
// rule, or a negative after cursor.
var ErrBadRequest = errors.New("bad request")

// idRe is the Bun server's ID_RE.
var idRe = regexp.MustCompile(`^[\w.-]+$`)

// defaultPoll is the Bun server's poll interval, kept as the fallback when
// Poll is given a non-positive interval.
const defaultPoll = 500 * time.Millisecond

// Options is the service configuration. Both callbacks are injected so the
// service reads no clock and no global repo list of its own: the shell maps
// Repos to the repo Manager and Now to time.Now, and tests supply fixed
// values.
type Options struct {
	Repos func() ([]repos.RepoConfig, *string)
	Now   func() int64
}

// Service answers the client bindings of spec R8.
type Service struct {
	repos func() ([]repos.RepoConfig, *string)
	now   func() int64
}

// New builds a service. A missing callback gets a safe default: no repos and
// the wall clock, which only the shell uses.
func New(o Options) *Service {
	service := &Service{repos: o.Repos, now: o.Now}
	if service.repos == nil {
		service.repos = func() ([]repos.RepoConfig, *string) { return []repos.RepoConfig{}, nil }
	}
	if service.now == nil {
		service.now = func() int64 { return time.Now().UnixMilli() }
	}
	return service
}

// State builds the board for the configured repos, with the configuration
// message when the repo list was cut.
func (s *Service) State() model.MonitorState {
	list, message := s.repos()
	return state.ReadState(list, s.now(), message)
}

// Session returns one page of a plan's session transcript. The repo name is
// looked up in the configured names, the plan and session ids must match the
// id rule and after must not be negative; every path is built from the
// configured folder with fsx.ResolveInside, never from an argument.
func (s *Service) Session(repo, plan, id string, after int) (model.SessionPage, error) {
	list, _ := s.repos()
	var config *repos.RepoConfig
	for index := range list {
		if list[index].Name == repo {
			config = &list[index]
			break
		}
	}
	if config == nil {
		return model.SessionPage{}, ErrNotFound
	}

	if !idRe.MatchString(plan) || !idRe.MatchString(id) {
		return model.SessionPage{}, ErrBadRequest
	}
	if after < 0 {
		return model.SessionPage{}, ErrBadRequest
	}

	plansDir, ok := fsx.ResolveInside(config.Dir)
	if !ok {
		return model.SessionPage{}, ErrNotFound
	}
	file, ok := sessions.FindSessionFile(plansDir, plan, id)
	if !ok {
		return model.SessionPage{}, ErrNotFound
	}

	data, err := os.ReadFile(file)
	if err != nil {
		return model.SessionPage{}, ErrNotFound
	}

	entries, next := sessions.ParseSessionLines(string(data), after)
	summary := sessions.SummarizeSession(file)
	live := !summary.Ended && float64(s.now())-summary.MtimeMs <= float64(lanes.StallMs)

	return model.SessionPage{
		ID:      id,
		Live:    live,
		Ended:   summary.Ended,
		Entries: entries,
		Next:    next,
	}, nil
}

// Poll calls emit once at the start and again whenever any configured repo's
// signature moves, every interval, until ctx is cancelled. It is the app's
// replacement for the Bun server's change event: one watcher, no port and no
// network call.
func (s *Service) Poll(ctx context.Context, every time.Duration, emit func()) {
	if every <= 0 {
		every = defaultPoll
	}

	last := s.signature()
	ticker := time.NewTicker(every)
	defer ticker.Stop()

	emit()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			current := s.signature()
			if current == last {
				continue
			}
			last = current
			emit()
		}
	}
}

// signature samples the poll signature of the configured repos.
func (s *Service) signature() string {
	list, _ := s.repos()
	return watch.Signature(list)
}
