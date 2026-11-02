package decider

import (
	"encoding/json"
	"math"
	"reflect"
	"testing"

	"pi-monitor/internal/model"
	"pi-monitor/internal/plans"
)

const planID = "20261023-1458-monitor-r1"

func ptr[T any](value T) *T {
	return &value
}

func planOf(taskIDs ...string) model.PlanView {
	tasks := make([]model.TaskRow, 0, len(taskIDs))
	for _, id := range taskIDs {
		tasks = append(tasks, model.TaskRow{
			ID:          id,
			Role:        "implement",
			Pair:        nil,
			DependsOn:   []string{},
			WaitsFor:    []string{},
			Skipped:     false,
			Implementer: model.Lane{State: "waiting", Attempts: []model.Attempt{}},
			Reviewer:    nil,
			Decider:     nil,
		})
	}
	return model.PlanView{
		ID:    planID,
		Trace: "20261023-1458-monitor",
		Round: 1,
		State: "done",
		Gate:  nil,
		Done:  len(taskIDs),
		Total: len(taskIDs),
		Tasks: tasks,
		Audit: nil,
	}
}

func effort(ts string, task *string, data map[string]any) plans.TraceEvent {
	return plans.TraceEvent{Ts: ts, Kind: "decision.effort", Plan: ptr(planID), Task: task, Data: data}
}

func start(ts, task string, attempt int, data map[string]any) plans.TraceEvent {
	return plans.TraceEvent{
		Ts:      ts,
		Kind:    "task.start",
		Plan:    ptr(planID),
		Task:    ptr(task),
		Attempt: ptr(attempt),
		Data:    data,
	}
}

func audit(ts string, data map[string]any) plans.TraceEvent {
	return plans.TraceEvent{Ts: ts, Kind: "decision.audit", Plan: ptr(planID), Data: data}
}

func deciderOf(t *testing.T, view model.PlanView, index int) *model.DeciderTaskView {
	t.Helper()
	return view.Tasks[index].Decider
}

func TestNoEventsLeaveEveryTaskAndThePlanAuditNull(t *testing.T) {
	view := ApplyDecider(planOf("one", "two"), nil)
	if view.Tasks[0].Decider != nil {
		t.Errorf("tasks[0].decider = %#v, want nil", view.Tasks[0].Decider)
	}
	if view.Tasks[1].Decider != nil {
		t.Errorf("tasks[1].decider = %#v, want nil", view.Tasks[1].Decider)
	}
	if view.Audit != nil {
		t.Errorf("audit = %#v, want nil", view.Audit)
	}
}

func TestAnEffortEventFillsTheDeciderOfItsTask(t *testing.T) {
	view := ApplyDecider(planOf("one"), []plans.TraceEvent{
		effort("2026-10-23T10:00:00.000Z", ptr("one"), map[string]any{
			"task":          "one",
			"suggested":     "high",
			"probabilities": map[string]any{"low": 0.1, "high": 0.8, "max": 0.1},
			"confidence":    0.8,
			"complexity":    3.0,
			"model":         "some/model",
			"cost":          0.0001,
			"mode":          "apply",
		}),
	})
	want := model.DeciderTaskView{
		Suggested:     "high",
		Probabilities: map[string]float64{"low": 0.1, "high": 0.8, "max": 0.1},
		Confidence:    ptr(0.8),
		Complexity:    ptr(3.0),
		Ran:           nil,
	}
	got := deciderOf(t, view, 0)
	if got == nil {
		t.Fatalf("decider = nil, want %#v", want)
	}
	if !reflect.DeepEqual(*got, want) {
		t.Errorf("decider = %#v, want %#v", *got, want)
	}
	if view.Audit != nil {
		t.Errorf("audit = %#v, want nil", view.Audit)
	}
}

func TestAnEffortEventForAnotherTaskLeavesThisTaskNull(t *testing.T) {
	view := ApplyDecider(planOf("one"), []plans.TraceEvent{
		effort("2026-10-23T10:00:00.000Z", ptr("two"), map[string]any{
			"task":          "two",
			"suggested":     "low",
			"probabilities": map[string]any{},
			"confidence":    0.5,
			"complexity":    1.0,
		}),
	})
	if view.Tasks[0].Decider != nil {
		t.Errorf("tasks[0].decider = %#v, want nil", view.Tasks[0].Decider)
	}
	if view.Audit != nil {
		t.Errorf("audit = %#v, want nil", view.Audit)
	}
}

func TestTheLatestEffortEventOfATaskWins(t *testing.T) {
	view := ApplyDecider(planOf("one"), []plans.TraceEvent{
		effort("2026-10-23T10:00:00.000Z", ptr("one"), map[string]any{
			"task":          "one",
			"suggested":     "low",
			"probabilities": map[string]any{"low": 0.9},
			"confidence":    0.9,
			"complexity":    1.0,
		}),
		effort("2026-10-23T09:00:00.000Z", ptr("one"), map[string]any{
			"task":          "one",
			"suggested":     "max",
			"probabilities": map[string]any{"max": 0.9},
			"confidence":    0.1,
			"complexity":    9.0,
		}),
		effort("2026-10-23T11:00:00.000Z", ptr("one"), map[string]any{
			"task":          "one",
			"suggested":     "high",
			"probabilities": map[string]any{"high": 0.9},
			"confidence":    0.8,
			"complexity":    5.0,
		}),
	})
	got := deciderOf(t, view, 0)
	if got == nil {
		t.Fatalf("decider = nil, want a view")
	}
	if got.Suggested != "high" {
		t.Errorf("suggested = %q, want %q", got.Suggested, "high")
	}
	if got.Complexity == nil || *got.Complexity != 5.0 {
		t.Errorf("complexity = %v, want 5", got.Complexity)
	}
}

func TestRanIsNullBeforeAnyStartAndTheFirstAttemptAfterTwoStarts(t *testing.T) {
	before := ApplyDecider(planOf("one"), []plans.TraceEvent{
		effort("2026-10-23T10:00:00.000Z", ptr("one"), map[string]any{
			"task":          "one",
			"suggested":     "high",
			"probabilities": map[string]any{},
			"confidence":    nil,
			"complexity":    nil,
		}),
	})
	if got := deciderOf(t, before, 0); got == nil || got.Ran != nil {
		t.Errorf("ran = %v, want nil", got)
	}

	after := ApplyDecider(planOf("one"), []plans.TraceEvent{
		effort("2026-10-23T10:00:00.000Z", ptr("one"), map[string]any{
			"task":          "one",
			"suggested":     "high",
			"probabilities": map[string]any{},
			"confidence":    nil,
			"complexity":    nil,
		}),
		start("2026-10-23T10:01:00.000Z", "one", 2, map[string]any{"thinking": "max"}),
		start("2026-10-23T10:00:30.000Z", "one", 1, map[string]any{"thinking": "low"}),
	})
	got := deciderOf(t, after, 0)
	if got == nil {
		t.Fatalf("decider = nil, want a view")
	}
	if got.Ran == nil || *got.Ran != "low" {
		t.Errorf("ran = %v, want %q", got.Ran, "low")
	}
}

func TestATaskWithoutAnEventStaysNullWhileAnotherHasOne(t *testing.T) {
	view := ApplyDecider(planOf("one", "two"), []plans.TraceEvent{
		effort("2026-10-23T10:00:00.000Z", ptr("two"), map[string]any{
			"task":          "two",
			"suggested":     "low",
			"probabilities": map[string]any{"low": 1.0},
			"confidence":    1.0,
			"complexity":    0.0,
		}),
	})
	if view.Tasks[0].Decider != nil {
		t.Errorf("tasks[0].decider = %#v, want nil", view.Tasks[0].Decider)
	}
	if got := deciderOf(t, view, 1); got == nil || got.Suggested != "low" {
		t.Errorf("tasks[1].decider = %#v, want suggested %q", got, "low")
	}
}

func TestAnEffortEventWhoseTaskIsOnlyInDataTaskIsMatched(t *testing.T) {
	view := ApplyDecider(planOf("one"), []plans.TraceEvent{
		effort("2026-10-23T10:00:00.000Z", nil, map[string]any{
			"task":          "one",
			"suggested":     "max",
			"probabilities": map[string]any{"max": 0.7},
			"confidence":    0.7,
			"complexity":    8.0,
		}),
	})
	if got := deciderOf(t, view, 0); got == nil || got.Suggested != "max" {
		t.Errorf("decider = %#v, want suggested %q", got, "max")
	}
}

func TestAnAuditEventFillsThePlanAudit(t *testing.T) {
	view := ApplyDecider(planOf("one"), []plans.TraceEvent{
		audit("2026-10-23T10:00:00.000Z", map[string]any{
			"model":       "some/model",
			"cost":        0.002,
			"audit_round": 2.0,
			"verdict":     "pass",
			"proposal":    "approve",
			"aggregate":   0.12,
			"findings": []any{
				map[string]any{"id": "f1", "severity": "minor", "p": 0.2},
				map[string]any{"id": "f2", "severity": "blocker", "p": 0.9},
			},
		}),
	})
	want := model.DeciderAuditView{
		Proposal:   "approve",
		Aggregate:  0.12,
		Verdict:    "pass",
		AuditRound: 2,
		Findings: []model.DeciderFinding{
			{ID: "f1", Severity: "minor", P: 0.2},
			{ID: "f2", Severity: "blocker", P: 0.9},
		},
	}
	if view.Audit == nil {
		t.Fatalf("audit = nil, want %#v", want)
	}
	if !reflect.DeepEqual(*view.Audit, want) {
		t.Errorf("audit = %#v, want %#v", *view.Audit, want)
	}
	if view.Tasks[0].Decider != nil {
		t.Errorf("tasks[0].decider = %#v, want nil", view.Tasks[0].Decider)
	}
}

func TestTheLatestAuditEventWins(t *testing.T) {
	view := ApplyDecider(planOf("one"), []plans.TraceEvent{
		audit("2026-10-23T10:00:00.000Z", map[string]any{
			"audit_round": 1.0,
			"verdict":     "fail",
			"proposal":    "fix",
			"aggregate":   0.8,
			"findings":    []any{},
		}),
		audit("2026-10-23T11:00:00.000Z", map[string]any{
			"audit_round": 2.0,
			"verdict":     "pass",
			"proposal":    "approve",
			"aggregate":   0.1,
			"findings":    []any{},
		}),
		audit("2026-10-23T09:00:00.000Z", map[string]any{
			"audit_round": 0.0,
			"verdict":     "fail",
			"proposal":    "hold",
			"aggregate":   0.5,
			"findings":    []any{},
		}),
	})
	if view.Audit == nil {
		t.Fatalf("audit = nil, want a view")
	}
	if view.Audit.AuditRound != 2 {
		t.Errorf("auditRound = %d, want 2", view.Audit.AuditRound)
	}
	if view.Audit.Verdict != "pass" {
		t.Errorf("verdict = %q, want %q", view.Audit.Verdict, "pass")
	}
	if view.Audit.Proposal != "approve" {
		t.Errorf("proposal = %q, want %q", view.Audit.Proposal, "approve")
	}
}

func TestMalformedDataFallsBackToSafeDefaults(t *testing.T) {
	view := ApplyDecider(planOf("one"), []plans.TraceEvent{
		effort("2026-10-23T10:00:00.000Z", ptr("one"), map[string]any{
			"task":          "one",
			"suggested":     "high",
			"probabilities": map[string]any{"low": "nope", "high": 0.5, "max": math.NaN()},
			"confidence":    "wide",
			"complexity":    nil,
		}),
		audit("2026-10-23T10:01:00.000Z", map[string]any{
			"audit_round": "two",
			"verdict":     42.0,
			"proposal":    nil,
			"aggregate":   "big",
			"findings": []any{
				map[string]any{"id": "ok", "severity": "minor", "p": 0.3},
				map[string]any{"id": "no-p", "severity": "minor"},
				map[string]any{"severity": "minor", "p": 0.4},
				nil,
				"text",
			},
		}),
	})
	gotTask := deciderOf(t, view, 0)
	if gotTask == nil {
		t.Fatalf("decider = nil, want a view")
	}
	if want := map[string]float64{"high": 0.5}; !reflect.DeepEqual(gotTask.Probabilities, want) {
		t.Errorf("probabilities = %#v, want %#v", gotTask.Probabilities, want)
	}
	if gotTask.Confidence != nil {
		t.Errorf("confidence = %v, want nil", *gotTask.Confidence)
	}
	if gotTask.Complexity != nil {
		t.Errorf("complexity = %v, want nil", *gotTask.Complexity)
	}
	if view.Audit == nil {
		t.Fatalf("audit = nil, want a view")
	}
	if view.Audit.Aggregate != 0 {
		t.Errorf("aggregate = %v, want 0", view.Audit.Aggregate)
	}
	if view.Audit.AuditRound != 0 {
		t.Errorf("auditRound = %d, want 0", view.Audit.AuditRound)
	}
	if view.Audit.Verdict != "unknown" {
		t.Errorf("verdict = %q, want %q", view.Audit.Verdict, "unknown")
	}
	if view.Audit.Proposal != "unknown" {
		t.Errorf("proposal = %q, want %q", view.Audit.Proposal, "unknown")
	}
	wantFindings := []model.DeciderFinding{{ID: "ok", Severity: "minor", P: 0.3}}
	if !reflect.DeepEqual(view.Audit.Findings, wantFindings) {
		t.Errorf("findings = %#v, want %#v", view.Audit.Findings, wantFindings)
	}
}

func TestAnEffortEventWithNoSuggestedIsIgnored(t *testing.T) {
	view := ApplyDecider(planOf("one"), []plans.TraceEvent{
		effort("2026-10-23T10:00:00.000Z", ptr("one"), map[string]any{
			"task":          "one",
			"probabilities": map[string]any{"low": 1.0},
			"confidence":    1.0,
			"complexity":    1.0,
		}),
	})
	if view.Tasks[0].Decider != nil {
		t.Errorf("decider = %#v, want nil", view.Tasks[0].Decider)
	}
}

func TestAnEmptyThinkingLevelCountsAsNoLevel(t *testing.T) {
	view := ApplyDecider(planOf("one"), []plans.TraceEvent{
		effort("2026-10-23T10:00:00.000Z", ptr("one"), map[string]any{
			"task":          "one",
			"suggested":     "low",
			"probabilities": map[string]any{},
			"confidence":    nil,
			"complexity":    nil,
		}),
		start("2026-10-23T10:01:00.000Z", "one", 1, map[string]any{"thinking": ""}),
	})
	got := deciderOf(t, view, 0)
	if got == nil {
		t.Fatalf("decider = nil, want a view")
	}
	if got.Ran != nil {
		t.Errorf("ran = %q, want nil", *got.Ran)
	}
}

func TestTheInputPlanIsNotMutated(t *testing.T) {
	plan := planOf("one")
	before, err := json.Marshal(plan)
	if err != nil {
		t.Fatalf("marshal plan: %v", err)
	}
	view := ApplyDecider(plan, []plans.TraceEvent{
		effort("2026-10-23T10:00:00.000Z", ptr("one"), map[string]any{
			"task":          "one",
			"suggested":     "high",
			"probabilities": map[string]any{"high": 1.0},
			"confidence":    1.0,
			"complexity":    2.0,
		}),
		audit("2026-10-23T10:01:00.000Z", map[string]any{
			"audit_round": 1.0,
			"verdict":     "pass",
			"proposal":    "approve",
			"aggregate":   0.0,
			"findings":    []any{},
		}),
	})
	after, err := json.Marshal(plan)
	if err != nil {
		t.Fatalf("marshal plan: %v", err)
	}
	if string(before) != string(after) {
		t.Errorf("input plan changed: before %s, after %s", before, after)
	}
	if view.Tasks[0].Decider == nil {
		t.Errorf("view tasks[0].decider = nil, want a view")
	}
	if plan.Tasks[0].Decider != nil {
		t.Errorf("plan tasks[0].decider = %#v, want nil", plan.Tasks[0].Decider)
	}
	if view.Audit == nil {
		t.Errorf("view audit = nil, want a view")
	}
	if plan.Audit != nil {
		t.Errorf("plan audit = %#v, want nil", plan.Audit)
	}
	if &view.Tasks[0] == &plan.Tasks[0] {
		t.Errorf("view tasks[0] and plan tasks[0] are the same element")
	}
}
