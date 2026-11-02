// Package state builds the monitor board for a list of repos.
//
// It is a port of monitor/src/server/state.ts. The TypeScript is the oracle:
// a repo shows its selected plan with the decider overlay, its first and last
// trace timestamps, and the repos are ordered active first by newest start,
// then idle by last activity, newest first, with ties keeping input order.
package state

import (
	"sort"
	"time"

	"pi-monitor/internal/decider"
	"pi-monitor/internal/lanes"
	"pi-monitor/internal/model"
	"pi-monitor/internal/plans"
	"pi-monitor/internal/repos"
	"pi-monitor/internal/sessions"
)

// stringPtr is a helper for the string pointers of the model.
func stringPtr(value string) *string {
	return &value
}

// tsOf is an event's timestamp, when it is a string that Date.parse reads.
func tsOf(event *plans.TraceEvent) *string {
	if event == nil {
		return nil
	}
	if _, ok := model.ParseTime(event.Ts); !ok {
		return nil
	}
	return stringPtr(event.Ts)
}

func emptyRepo(name string, message *string) model.RepoView {
	return model.RepoView{
		Name:         name,
		Active:       false,
		Plan:         nil,
		Message:      message,
		StartedAt:    nil,
		LastActivity: nil,
	}
}

// ReadRepo reads one repo's selected plan and builds its view.
func ReadRepo(repo repos.RepoConfig, nowMs int64) (view model.RepoView) {
	// The TypeScript catches every read error and reports one message; a panic
	// in one of the ported readers plays the role of that catch.
	defer func() {
		if recover() != nil {
			view = emptyRepo(repo.Name, stringPtr("Could not read the plans folder"))
		}
	}()

	selected := plans.SelectPlan(repo.Dir)
	if selected.Plan == nil {
		return emptyRepo(repo.Name, selected.Message)
	}

	events := plans.ReadTraceEvents(repo.Dir, selected.Plan.Trace, selected.Plan.ID)
	sessionFiles := sessions.ListSessionFiles(repo.Dir, selected.Plan.ID)
	table := lanes.BuildPlanView(
		selected.Plan,
		selected.Running,
		events,
		sessionFiles,
		nowMs,
		nil,
	)
	plan := decider.ApplyDecider(table, events)

	var startedAt *string
	var lastActivity *string
	if len(events) > 0 {
		startedAt = tsOf(&events[0])
		lastActivity = tsOf(&events[len(events)-1])
	}

	return model.RepoView{
		Name:         repo.Name,
		Active:       selected.Running,
		Plan:         &plan,
		Message:      selected.Message,
		StartedAt:    startedAt,
		LastActivity: lastActivity,
	}
}

// isoNow formats Unix milliseconds the way the TypeScript's
// new Date(nowMs).toISOString() does: UTC, with milliseconds.
func isoNow(nowMs int64) string {
	return time.UnixMilli(nowMs).UTC().Format("2006-01-02T15:04:05.000Z")
}

// byTimeDesc compares two ISO timestamps; a nil sorts last and a tie keeps the
// input order.
func byTimeDesc(a, b *string) int {
	if a == nil && b == nil {
		return 0
	}
	if a == nil {
		return 1
	}
	if b == nil {
		return -1
	}
	am, aok := model.ParseTime(*a)
	bm, bok := model.ParseTime(*b)
	switch {
	case !aok && !bok:
		return 0
	case !aok:
		return 1
	case !bok:
		return -1
	case bm > am:
		return 1
	case bm < am:
		return -1
	}
	return 0
}

// ReadState builds the whole board: every repo's view, with active repos first
// by newest start and idle repos after them by last activity, newest first.
func ReadState(list []repos.RepoConfig, nowMs int64, message *string) model.MonitorState {
	views := make([]model.RepoView, 0, len(list))
	for _, repo := range list {
		views = append(views, ReadRepo(repo, nowMs))
	}

	active := make([]model.RepoView, 0, len(views))
	idle := make([]model.RepoView, 0, len(views))
	for _, view := range views {
		if view.Active {
			active = append(active, view)
			continue
		}
		idle = append(idle, view)
	}

	// sort.SliceStable is the TypeScript's stable sort: equal keys keep the
	// configured order.
	sort.SliceStable(active, func(i, j int) bool {
		return byTimeDesc(active[i].StartedAt, active[j].StartedAt) < 0
	})
	sort.SliceStable(idle, func(i, j int) bool {
		return byTimeDesc(idle[i].LastActivity, idle[j].LastActivity) < 0
	})

	ordered := make([]model.RepoView, 0, len(views))
	ordered = append(ordered, active...)
	ordered = append(ordered, idle...)

	return model.MonitorState{
		Repos:   ordered,
		Message: message,
		Now:     isoNow(nowMs),
	}
}
