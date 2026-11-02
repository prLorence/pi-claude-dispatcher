// Package lanes builds the plan board the monitor client renders.
//
// It is a port of monitor/src/server/lanes.ts. The TypeScript is the oracle:
// every rule here follows that file, including the attempt numbering, the
// stalled rule, the review result and the plan state. A session summary is
// injected, so the board can be built without touching the disk.
package lanes

import (
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"pi-monitor/internal/model"
	"pi-monitor/internal/plans"
	"pi-monitor/internal/sessions"
)

// StallMs is how long a running session may go without a change before its
// lane shows stalled: 30 seconds.
const StallMs int64 = 30000

// escapeRe escapes the characters JavaScript's escapeRe escapes, so a plan or
// task id becomes a literal in the attempt patterns.
func escapeRe(value string) string {
	var builder strings.Builder
	for _, char := range value {
		switch char {
		case '.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\':
			builder.WriteByte('\\')
		}
		builder.WriteRune(char)
	}
	return builder.String()
}

// dataOf returns the event data, or an empty map when the event has none.
func dataOf(event plans.TraceEvent) map[string]any {
	if event.Data == nil {
		return map[string]any{}
	}
	return event.Data
}

// eventData is dataOf for an event that may be missing.
func eventData(event *plans.TraceEvent) map[string]any {
	if event == nil {
		return map[string]any{}
	}
	return dataOf(*event)
}

// numberOf is the value when it is a finite JSON number.
func numberOf(value any) (float64, bool) {
	num, ok := value.(float64)
	if !ok || math.IsNaN(num) || math.IsInf(num, 0) {
		return 0, false
	}
	return num, true
}

// intOf is numberOf narrowed to an int, for the integer counters of a trace.
func intOf(value any) (int, bool) {
	num, ok := numberOf(value)
	if !ok {
		return 0, false
	}
	return int(num), true
}

// attemptNumberOf is the event's attempt, when it has one.
func attemptNumberOf(event plans.TraceEvent) (int, bool) {
	if event.Attempt == nil {
		return 0, false
	}
	return *event.Attempt, true
}

// sessionIDOf is the event's non-empty data.session_id.
func sessionIDOf(event plans.TraceEvent) (string, bool) {
	value, ok := dataOf(event)["session_id"].(string)
	if !ok || value == "" {
		return "", false
	}
	return value, true
}

// textOf is the value when it is a non-empty string.
func textOf(value any) *string {
	text, ok := value.(string)
	if !ok || text == "" {
		return nil
	}
	return &text
}

// pickText is the first value that is set, in order.
func pickText(values ...*string) *string {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}

// endStateOf reads a task.end state: failed by failed, or by retry with
// ok: false.
func endStateOf(event plans.TraceEvent) model.LaneState {
	data := dataOf(event)
	if data["state"] == "failed" {
		return "failed"
	}
	if data["state"] == "retry" && data["ok"] == false {
		return "failed"
	}
	return "done"
}

// freshness is live while the plan runs and the session file is recent, and
// stalled otherwise.
func freshness(summary sessions.SessionSummary, running bool, nowMs int64) model.LaneState {
	if running && float64(nowMs)-summary.MtimeMs <= float64(StallMs) {
		return "live"
	}
	return "stalled"
}

// elapsedSeconds is the whole seconds from the session start to its last
// timestamp, or to now while it is live, never negative.
func elapsedSeconds(
	summary sessions.SessionSummary,
	state model.LaneState,
	nowMs int64,
) *float64 {
	if summary.StartedAt == nil {
		return nil
	}
	start, ok := model.ParseTime(*summary.StartedAt)
	if !ok {
		return nil
	}
	var end int64
	if summary.LastTs != nil {
		parsed, ok := model.ParseTime(*summary.LastTs)
		if ok {
			end = parsed
		} else if state != "live" {
			return nil
		} else {
			end = nowMs
		}
	} else if state != "live" {
		return nil
	} else {
		end = nowMs
	}
	seconds := math.Max(0, math.Round(float64(end-start)/1000))
	return &seconds
}

// implementerSlot is one implementer attempt: its number, session and events.
type implementerSlot struct {
	num        int
	sessionID  string
	file       *string
	startEvent *plans.TraceEvent
	endEvent   *plans.TraceEvent
}

// reviewerSlot is one reviewer attempt: its round, session and event.
type reviewerSlot struct {
	round     int
	attempt   int
	sessionID string
	file      *string
	event     *plans.TraceEvent
}

// parseDigits is JavaScript's Number.parseInt(digits, 10) for a run of ASCII
// digits: an overflowing number keeps its place at the end of the order.
func parseDigits(digits string) int {
	value, err := strconv.Atoi(digits)
	if err != nil {
		return math.MaxInt32
	}
	return value
}

// implementerSlots is the attempts of one implementer lane: first the ones the
// events name, then the session files the events do not know yet, sorted by
// attempt number.
func implementerSlots(
	plan *plans.ParsedPlan,
	task plans.PlanTask,
	taskEvents []plans.TraceEvent,
	sessionFiles []sessions.SessionFile,
	fileByID map[string]string,
) []implementerSlot {
	slots := map[int]*implementerSlot{}
	ensure := func(num int) *implementerSlot {
		if found, ok := slots[num]; ok {
			return found
		}
		slot := &implementerSlot{
			num:       num,
			sessionID: plan.ID + "." + task.ID + ".a" + strconv.Itoa(num),
		}
		slots[num] = slot
		return slot
	}

	for i := range taskEvents {
		event := &taskEvents[i]
		if event.Kind == "task.start" {
			num, ok := attemptNumberOf(*event)
			if !ok {
				continue
			}
			slot := ensure(num)
			slot.startEvent = event
			if sessionID, ok := sessionIDOf(*event); ok {
				slot.sessionID = sessionID
			}
		} else if event.Kind == "task.end" {
			num, ok := attemptNumberOf(*event)
			if !ok {
				continue
			}
			ensure(num).endEvent = event
		}
	}

	pattern := regexp.MustCompile(
		"^" + escapeRe(plan.ID) + `\.` + escapeRe(task.ID) + `\.a(\d+)$`,
	)
	for _, item := range sessionFiles {
		match := pattern.FindStringSubmatch(item.ID)
		if match == nil {
			continue
		}
		num := parseDigits(match[1])
		if existing, ok := slots[num]; ok {
			if existing.file == nil {
				file := item.File
				existing.file = &file
				existing.sessionID = item.ID
			}
			continue
		}
		file := item.File
		slots[num] = &implementerSlot{
			num:       num,
			sessionID: item.ID,
			file:      &file,
		}
	}

	out := make([]implementerSlot, 0, len(slots))
	for _, slot := range slots {
		if slot.file == nil {
			if file, ok := fileByID[slot.sessionID]; ok {
				value := file
				slot.file = &value
			}
		}
		out = append(out, *slot)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].num < out[j].num })
	return out
}

// reviewerSlots is the attempts of one reviewer lane: the rounds the events
// name, then the session files nobody has reported yet (a running reviewer has
// no event), sorted by round, then attempt.
func reviewerSlots(
	plan *plans.ParsedPlan,
	task plans.PlanTask,
	taskEvents []plans.TraceEvent,
	sessionFiles []sessions.SessionFile,
	fileByID map[string]string,
) []reviewerSlot {
	slots := []reviewerSlot{}

	for i := range taskEvents {
		event := &taskEvents[i]
		if event.Kind != "task.review" {
			continue
		}
		round, ok := intOf(dataOf(*event)["round"])
		if !ok {
			continue
		}
		slot := reviewerSlot{round: round, attempt: 1, event: event}
		if num, ok := attemptNumberOf(*event); ok {
			slot.attempt = num
		}
		if sessionID, ok := sessionIDOf(*event); ok {
			slot.sessionID = sessionID
			if file, ok := fileByID[sessionID]; ok {
				value := file
				slot.file = &value
			}
		} else {
			slot.sessionID = plan.ID + "." + task.ID + ".review" + strconv.Itoa(round) + ".a1"
		}
		slots = append(slots, slot)
	}

	pattern := regexp.MustCompile(
		"^" + escapeRe(plan.ID) + `\.` + escapeRe(task.ID) + `\.review(\d+)\.a(\d+)$`,
	)
	for _, item := range sessionFiles {
		match := pattern.FindStringSubmatch(item.ID)
		if match == nil {
			continue
		}
		round := parseDigits(match[1])
		attempt := parseDigits(match[2])
		duplicate := false
		for _, slot := range slots {
			if slot.sessionID == item.ID {
				duplicate = true
				break
			}
		}
		if duplicate {
			continue
		}
		open := -1
		for i := range slots {
			if slots[i].round == round && slots[i].file == nil {
				open = i
				break
			}
		}
		if open >= 0 {
			file := item.File
			slots[open].file = &file
			slots[open].sessionID = item.ID
			slots[open].attempt = attempt
			continue
		}
		file := item.File
		slots = append(slots, reviewerSlot{
			round:     round,
			attempt:   attempt,
			sessionID: item.ID,
			file:      &file,
		})
	}

	sort.SliceStable(slots, func(i, j int) bool {
		if slots[i].round != slots[j].round {
			return slots[i].round < slots[j].round
		}
		return slots[i].attempt < slots[j].attempt
	})
	return slots
}

// implementerState is the state of one implementer attempt.
func implementerState(
	summary sessions.SessionSummary,
	slot implementerSlot,
	running bool,
	nowMs int64,
) model.LaneState {
	if summary.Exists {
		if !summary.Ended {
			return freshness(summary, running, nowMs)
		}
		if summary.StopReason != nil &&
			(*summary.StopReason == "error" || *summary.StopReason == "aborted") {
			return "failed"
		}
		if slot.endEvent == nil {
			return "done"
		}
		return endStateOf(*slot.endEvent)
	}
	if slot.endEvent != nil {
		return endStateOf(*slot.endEvent)
	}
	if slot.startEvent != nil && running {
		return "live"
	}
	return "waiting"
}

// verdictOf is the review verdict, unknown when the event names another.
func verdictOf(value any) model.Verdict {
	if value == "approve" {
		return "approve"
	}
	if value == "changes" {
		return "changes"
	}
	return "unknown"
}

// findingsOf is the finding count: a number, or the length of a list.
func findingsOf(value any) *int {
	if num, ok := numberOf(value); ok {
		count := int(num)
		return &count
	}
	if list, ok := value.([]any); ok {
		count := len(list)
		return &count
	}
	return nil
}

// buildReview is the review result pinned by a task.review event.
func buildReview(event plans.TraceEvent, summary sessions.SessionSummary) model.ReviewResult {
	data := dataOf(event)
	verdict := verdictOf(data["verdict"])
	return model.ReviewResult{
		Verdict:  verdict,
		Findings: findingsOf(data["findings"]),
		Failed:   data["ok"] == false || verdict == "unknown",
		Text:     summary.LastText,
	}
}

// reviewerState is the state of one reviewer attempt.
func reviewerState(
	summary sessions.SessionSummary,
	review *model.ReviewResult,
	running bool,
	nowMs int64,
) model.LaneState {
	if summary.Exists {
		if !summary.Ended {
			return freshness(summary, running, nowMs)
		}
		if review != nil && review.Failed {
			return "failed"
		}
		return "done"
	}
	if review != nil {
		if review.Failed {
			return "failed"
		}
		return "done"
	}
	return "waiting"
}

// summaryOf is the session summary of an attempt; no file is the null case,
// which the summary reports as a session that does not exist.
func summaryOf(file *string, summarize func(string) sessions.SessionSummary) sessions.SessionSummary {
	if file == nil {
		return summarize("")
	}
	return summarize(*file)
}

// implementerAttempt is one implementer attempt of the board.
func implementerAttempt(
	slot implementerSlot,
	running bool,
	nowMs int64,
	summarize func(string) sessions.SessionSummary,
) model.Attempt {
	summary := summaryOf(slot.file, summarize)
	state := implementerState(summary, slot, running, nowMs)
	startData := eventData(slot.startEvent)
	endData := eventData(slot.endEvent)
	return model.Attempt{
		ID:         slot.sessionID,
		Label:      "a" + strconv.Itoa(slot.num),
		State:      state,
		Model:      pickText(textOf(startData["model"]), textOf(endData["model"]), summary.Model),
		Thinking:   pickText(textOf(startData["thinking"]), textOf(endData["thinking"]), summary.Thinking),
		StartedAt:  summary.StartedAt,
		ElapsedS:   elapsedSeconds(summary, state, nowMs),
		Tokens:     summary.Tokens,
		Cost:       summary.Cost,
		LastTool:   summary.LastTool,
		Error:      summary.Error,
		HasSession: summary.Exists,
		Review:     nil,
	}
}

// reviewerAttempt is one reviewer attempt of the board.
func reviewerAttempt(
	slot reviewerSlot,
	running bool,
	nowMs int64,
	summarize func(string) sessions.SessionSummary,
) model.Attempt {
	summary := summaryOf(slot.file, summarize)
	data := eventData(slot.event)
	var review *model.ReviewResult
	if slot.event != nil {
		built := buildReview(*slot.event, summary)
		review = &built
	}
	state := reviewerState(summary, review, running, nowMs)
	return model.Attempt{
		ID:         slot.sessionID,
		Label:      "r" + strconv.Itoa(slot.round),
		State:      state,
		Model:      pickText(textOf(data["model"]), summary.Model),
		Thinking:   pickText(textOf(data["thinking"]), summary.Thinking),
		StartedAt:  summary.StartedAt,
		ElapsedS:   elapsedSeconds(summary, state, nowMs),
		Tokens:     summary.Tokens,
		Cost:       summary.Cost,
		LastTool:   summary.LastTool,
		Error:      summary.Error,
		HasSession: summary.Exists,
		Review:     review,
	}
}

// laneOf is the lane of a list of attempts: the newest attempt sets the state.
func laneOf(attempts []model.Attempt) model.Lane {
	if attempts == nil {
		attempts = []model.Attempt{}
	}
	if len(attempts) == 0 {
		return model.Lane{State: "waiting", Attempts: attempts}
	}
	return model.Lane{State: attempts[len(attempts)-1].State, Attempts: attempts}
}

// emptyLane is a lane with no attempt.
func emptyLane() model.Lane {
	return model.Lane{State: "waiting", Attempts: []model.Attempt{}}
}

// BuildPlanView builds the board of one plan. nowMs is the injected clock in
// Unix milliseconds and summarize reads a session file, so a caller can fake
// both.
func BuildPlanView(
	plan *plans.ParsedPlan,
	running bool,
	events []plans.TraceEvent,
	sessionFiles []sessions.SessionFile,
	nowMs int64,
	summarize func(file string) sessions.SessionSummary,
) model.PlanView {
	if summarize == nil {
		summarize = sessions.SummarizeSession
	}

	fileByID := map[string]string{}
	for _, item := range sessionFiles {
		if _, ok := fileByID[item.ID]; !ok {
			fileByID[item.ID] = item.File
		}
	}

	eventsByTask := map[string][]plans.TraceEvent{}
	for _, event := range events {
		if event.Task == nil || *event.Task == "" {
			continue
		}
		eventsByTask[*event.Task] = append(eventsByTask[*event.Task], event)
	}

	latestEndOf := func(taskID string) *plans.TraceEvent {
		list := eventsByTask[taskID]
		var found *plans.TraceEvent
		for i := range list {
			if list[i].Kind == "task.end" {
				found = &list[i]
			}
		}
		return found
	}

	isDoneTask := func(taskID string) bool {
		end := latestEndOf(taskID)
		return end != nil && dataOf(*end)["state"] == "done"
	}

	tasks := make([]model.TaskRow, 0, len(plan.Tasks))
	for _, task := range plan.Tasks {
		taskEvents := eventsByTask[task.ID]
		skipped := !running && len(taskEvents) == 0

		waitsFor := []string{}
		if !skipped {
			for _, id := range task.DependsOn {
				if !isDoneTask(id) {
					waitsFor = append(waitsFor, id)
				}
			}
		}

		implementer := emptyLane()
		if !skipped {
			slots := implementerSlots(plan, task, taskEvents, sessionFiles, fileByID)
			attempts := make([]model.Attempt, 0, len(slots))
			for _, slot := range slots {
				attempts = append(attempts, implementerAttempt(slot, running, nowMs, summarize))
			}
			implementer = laneOf(attempts)
		}

		var reviewer *model.Lane
		if task.Pair != nil {
			if skipped {
				lane := emptyLane()
				reviewer = &lane
			} else {
				slots := reviewerSlots(plan, task, taskEvents, sessionFiles, fileByID)
				attempts := make([]model.Attempt, 0, len(slots))
				for _, slot := range slots {
					attempts = append(attempts, reviewerAttempt(slot, running, nowMs, summarize))
				}
				lane := laneOf(attempts)
				reviewer = &lane
			}
		}

		dependsOn := task.DependsOn
		if dependsOn == nil {
			dependsOn = []string{}
		}
		tasks = append(tasks, model.TaskRow{
			ID:          task.ID,
			Role:        task.Role,
			Pair:        task.Pair,
			DependsOn:   dependsOn,
			WaitsFor:    waitsFor,
			Skipped:     skipped,
			Implementer: implementer,
			Reviewer:    reviewer,
			Decider:     nil,
		})
	}

	var planEnd *plans.TraceEvent
	for i := range events {
		if events[i].Kind == "plan.end" {
			planEnd = &events[i]
		}
	}
	var gate *string
	if planEnd != nil {
		switch dataOf(*planEnd)["gate_pass"] {
		case true:
			value := "pass"
			gate = &value
		case false:
			value := "fail"
			gate = &value
		}
	}

	state := "done"
	if running {
		state = "running"
	} else if gate != nil && *gate == "fail" {
		state = "failed"
	}

	done := 0
	for _, task := range plan.Tasks {
		if isDoneTask(task.ID) {
			done++
		}
	}

	return model.PlanView{
		ID:    plan.ID,
		Trace: plan.Trace,
		Round: plan.Round,
		State: state,
		Gate:  gate,
		Done:  done,
		Total: len(plan.Tasks),
		Tasks: tasks,
		Audit: nil,
	}
}
