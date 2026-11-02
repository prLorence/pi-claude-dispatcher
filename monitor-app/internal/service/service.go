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
	"strconv"
	"time"

	"pi-monitor/internal/agents"
	"pi-monitor/internal/fsx"
	"pi-monitor/internal/lanes"
	"pi-monitor/internal/model"
	"pi-monitor/internal/repos"
	"pi-monitor/internal/sessions"
	"pi-monitor/internal/settings"
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
// values. Settings is the monitor settings and Home the folder the two agent
// roots live under; both are injected so no test reads a real agent folder.
type Options struct {
	Repos    func() ([]repos.RepoConfig, *string)
	Now      func() int64
	Settings func() settings.Settings
	Home     string
}

// Service answers the client bindings of spec R8.
type Service struct {
	repos    func() ([]repos.RepoConfig, *string)
	now      func() int64
	settings func() settings.Settings
	home     string
	agents   *agents.Reader
}

// New builds a service. A missing callback gets a safe default: no repos and
// the wall clock, which only the shell uses.
func New(o Options) *Service {
	service := &Service{
		repos:    o.Repos,
		now:      o.Now,
		settings: o.Settings,
		home:     o.Home,
		agents:   agents.New(),
	}
	if service.repos == nil {
		service.repos = func() ([]repos.RepoConfig, *string) { return []repos.RepoConfig{}, nil }
	}
	if service.now == nil {
		service.now = func() int64 { return time.Now().UnixMilli() }
	}
	if service.settings == nil {
		service.settings = settings.Default
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

// agentOptions builds the listing request for the Agents view. It reports
// false when there is no home folder to read the agent roots under.
func (s *Service) agentOptions() (agents.Options, bool) {
	if s.home == "" {
		return agents.Options{}, false
	}
	list, _ := s.repos()
	return agents.Options{
		Home:     s.home,
		Settings: s.settings(),
		Repos:    list,
		NowMs:    s.now(),
	}, true
}

// Agents returns the coding-agent sessions of the enabled roots, grouped like
// the added repos. With both toggles off, no home or no session the result is
// an empty non-nil slice, so it encodes as [].
func (s *Service) Agents() []model.AgentGroup {
	o, ok := s.agentOptions()
	if !ok {
		return []model.AgentGroup{}
	}
	groups := s.agents.List(o)
	if groups == nil {
		return []model.AgentGroup{}
	}
	return groups
}

// AgentSession returns one page of an agent session transcript. The file is
// found by listing the enabled roots and never built from the arguments, and
// after must not be negative; an id that is not listed is ErrNotFound.
func (s *Service) AgentSession(agent, group, id string, after int) (model.SessionPage, error) {
	if after < 0 {
		return model.SessionPage{}, ErrBadRequest
	}
	o, ok := s.agentOptions()
	if !ok {
		return model.SessionPage{}, ErrNotFound
	}
	file, ok := s.agents.Find(o, agent, group, id)
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

// signature samples the poll signature of the configured repos. While an
// agent toggle is on it also carries the settings and the cheap signature of
// the enabled agent roots, so a new, growing or removed session fires the
// change event; with both toggles off it is exactly the old value.
func (s *Service) signature() string {
	list, _ := s.repos()
	base := watch.Signature(list)
	current := s.settings()
	if !current.OmpSessions && !current.PiSessions {
		return base
	}
	part := "\nagents:" + current.Scope +
		"|omp=" + strconv.FormatBool(current.OmpSessions) +
		"|pi=" + strconv.FormatBool(current.PiSessions)
	if s.home != "" {
		part += "\n" + s.agents.Signature(agents.Options{
			Home:     s.home,
			Settings: current,
			Repos:    list,
			NowMs:    s.now(),
		})
	}
	return base + part
}
