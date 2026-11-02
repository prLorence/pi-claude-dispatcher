// Package decider adds the dispatcher decider's events to a plan view.
//
// It is a port of monitor/src/server/decider.ts. The TypeScript is the
// oracle: each task shows its latest decision.effort suggestion next to the
// thinking level its first task.start ran with, and the plan shows its latest
// decision.audit. A trace with no such events leaves those views null.
package decider

import (
	"math"

	"pi-monitor/internal/model"
	"pi-monitor/internal/plans"
)

// dataOf returns the event data, or an empty map when the event has none.
func dataOf(event plans.TraceEvent) map[string]any {
	if event.Data == nil {
		return map[string]any{}
	}
	return event.Data
}

// taskOf is the task an event belongs to: the top-level field, else data.task.
func taskOf(event plans.TraceEvent) (string, bool) {
	if event.Task != nil && *event.Task != "" {
		return *event.Task, true
	}
	if fromData, ok := dataOf(event)["task"].(string); ok && fromData != "" {
		return fromData, true
	}
	return "", false
}

// tsOf is the event time in Unix milliseconds, or negative infinity when the
// time does not parse, so a malformed time loses every comparison.
func tsOf(event plans.TraceEvent) float64 {
	if ms, ok := model.ParseTime(event.Ts); ok {
		return float64(ms)
	}
	return math.Inf(-1)
}

// numberOf is the event value when it is a finite JSON number.
func numberOf(value any) (float64, bool) {
	num, ok := value.(float64)
	if !ok || math.IsNaN(num) || math.IsInf(num, 0) {
		return 0, false
	}
	return num, true
}

// textOf is the event value when it is a non-empty string.
func textOf(value any) (string, bool) {
	text, ok := value.(string)
	if !ok || text == "" {
		return "", false
	}
	return text, true
}

// probabilitiesOf keeps the finite number entries of a probabilities object.
func probabilitiesOf(value any) map[string]float64 {
	result := map[string]float64{}
	object, ok := value.(map[string]any)
	if !ok {
		return result
	}
	for key, entry := range object {
		if num, ok := numberOf(entry); ok {
			result[key] = num
		}
	}
	return result
}

// atLeastAsLate is true when a is at least as late as b, so the later event
// in the file wins a tie.
func atLeastAsLate(a, b plans.TraceEvent) bool {
	return tsOf(a) >= tsOf(b)
}

// attemptOf is the event attempt, or positive infinity when it has none.
func attemptOf(event plans.TraceEvent) float64 {
	if event.Attempt != nil {
		return float64(*event.Attempt)
	}
	return math.Inf(1)
}

// startsBefore is true when a starts before b: lowest attempt first, then
// earliest ts.
func startsBefore(a, b plans.TraceEvent) bool {
	attemptA := attemptOf(a)
	attemptB := attemptOf(b)
	if attemptA != attemptB {
		return attemptA < attemptB
	}
	return tsOf(a) < tsOf(b)
}

// effortView is the decider view of one task.
func effortView(event plans.TraceEvent, start *plans.TraceEvent) model.DeciderTaskView {
	data := dataOf(event)
	startData := map[string]any{}
	if start != nil {
		startData = dataOf(*start)
	}
	suggested, _ := textOf(data["suggested"])
	view := model.DeciderTaskView{
		Suggested:     suggested,
		Probabilities: probabilitiesOf(data["probabilities"]),
	}
	if confidence, ok := numberOf(data["confidence"]); ok {
		view.Confidence = &confidence
	}
	if complexity, ok := numberOf(data["complexity"]); ok {
		view.Complexity = &complexity
	}
	if ran, ok := textOf(startData["thinking"]); ok {
		view.Ran = &ran
	}
	return view
}

// findingsOf keeps the well-formed findings of an audit event.
func findingsOf(value any) []model.DeciderFinding {
	findings := []model.DeciderFinding{}
	list, ok := value.([]any)
	if !ok {
		return findings
	}
	for _, entry := range list {
		item, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		id, ok := textOf(item["id"])
		if !ok {
			continue
		}
		severity, ok := textOf(item["severity"])
		if !ok {
			continue
		}
		p, ok := numberOf(item["p"])
		if !ok {
			continue
		}
		findings = append(findings, model.DeciderFinding{ID: id, Severity: severity, P: p})
	}
	return findings
}

// roundOf narrows the audit round to the JSON shape's integer. A fractional
// value truncates; the traces and the decider write whole rounds.
func roundOf(value float64) int {
	if value > math.MaxInt32 {
		return math.MaxInt32
	}
	if value < math.MinInt32 {
		return math.MinInt32
	}
	return int(value)
}

// auditView is the decider audit view of one plan.
func auditView(event plans.TraceEvent) model.DeciderAuditView {
	data := dataOf(event)
	proposal, ok := textOf(data["proposal"])
	if !ok {
		proposal = "unknown"
	}
	aggregate, ok := numberOf(data["aggregate"])
	if !ok {
		aggregate = 0
	}
	verdict, ok := textOf(data["verdict"])
	if !ok {
		verdict = "unknown"
	}
	auditRound, ok := numberOf(data["audit_round"])
	if !ok {
		auditRound = 0
	}
	return model.DeciderAuditView{
		Proposal:   proposal,
		Aggregate:  aggregate,
		Verdict:    verdict,
		AuditRound: roundOf(auditRound),
		Findings:   findingsOf(data["findings"]),
	}
}

// ApplyDecider returns the plan with each task's latest decision.effort
// suggestion next to the thinking level its first task.start ran with, and the
// latest decision.audit of the plan. The input plan is not changed.
func ApplyDecider(plan model.PlanView, events []plans.TraceEvent) model.PlanView {
	latestEffort := map[string]plans.TraceEvent{}
	firstStart := map[string]plans.TraceEvent{}
	var latestAudit *plans.TraceEvent

	for _, event := range events {
		switch event.Kind {
		case "decision.effort":
			task, ok := taskOf(event)
			if !ok {
				continue
			}
			if _, ok := textOf(dataOf(event)["suggested"]); !ok {
				continue
			}
			previous, seen := latestEffort[task]
			if !seen || atLeastAsLate(event, previous) {
				latestEffort[task] = event
			}
		case "task.start":
			task, ok := taskOf(event)
			if !ok {
				continue
			}
			previous, seen := firstStart[task]
			if !seen || startsBefore(event, previous) {
				firstStart[task] = event
			}
		case "decision.audit":
			if latestAudit == nil || atLeastAsLate(event, *latestAudit) {
				current := event
				latestAudit = &current
			}
		}
	}

	tasks := make([]model.TaskRow, len(plan.Tasks))
	for i, task := range plan.Tasks {
		row := task
		effort, hasEffort := latestEffort[task.ID]
		if !hasEffort {
			row.Decider = nil
		} else {
			var start *plans.TraceEvent
			if first, ok := firstStart[task.ID]; ok {
				firstCopy := first
				start = &firstCopy
			}
			view := effortView(effort, start)
			row.Decider = &view
		}
		tasks[i] = row
	}

	result := plan
	result.Tasks = tasks
	if latestAudit == nil {
		result.Audit = nil
	} else {
		audit := auditView(*latestAudit)
		result.Audit = &audit
	}
	return result
}
