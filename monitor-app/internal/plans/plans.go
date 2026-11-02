// Package plans reads the plan files and trace events the dispatcher writes.
//
// It is a port of monitor/src/server/plans.ts. The TypeScript is the oracle:
// every rule here follows that file, including its lenient handling of trace
// events, where one unexpected field type must not drop the whole event.
package plans

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"pi-monitor/internal/fsx"
	"pi-monitor/internal/model"
)

// PlanTask is one task of a parsed plan.
type PlanTask struct {
	ID        string
	Role      string
	Pair      *string
	DependsOn []string
}

// ParsedPlan is the frontmatter and the task list of one plan file.
type ParsedPlan struct {
	ID    string
	Trace string
	Round int
	Tasks []PlanTask
}

// TraceEvent is one line of a trace file, kept as the TypeScript keeps it:
// every field is optional except ts and kind, and data stays free-form.
type TraceEvent struct {
	Ts      string
	Kind    string
	Plan    *string
	Task    *string
	Attempt *int
	Data    map[string]any
}

// Selected is the plan selectPlan picked, with the reason when it picked none.
type Selected struct {
	Plan    *ParsedPlan
	Running bool
	Message *string
}

var (
	keyLineRe     = regexp.MustCompile(`^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$`)
	taskHeadingRe = regexp.MustCompile(`^##\s+task\s*:\s*(.+?)\s*$`)
	commentRe     = regexp.MustCompile(`\s+#.*$`)
)

// splitPlanLines splits on "\n" and removes one "\r" before it, like
// JavaScript's split(/\r?\n/).
func splitPlanLines(text string) []string {
	lines := strings.Split(text, "\n")
	for i, line := range lines {
		lines[i] = strings.TrimSuffix(line, "\r")
	}
	return lines
}

func cleanValue(raw string) string {
	value := strings.TrimSpace(raw)
	if strings.HasPrefix(value, "#") {
		return ""
	}
	value = strings.TrimSpace(commentRe.ReplaceAllString(value, ""))
	if len(value) >= 2 && ((strings.HasPrefix(value, `"`) && strings.HasSuffix(value, `"`)) ||
		(strings.HasPrefix(value, "'") && strings.HasSuffix(value, "'"))) {
		value = strings.TrimSpace(value[1 : len(value)-1])
	}
	return value
}

func parseList(raw string) []string {
	value := strings.TrimSpace(raw)
	inner := value
	if strings.HasPrefix(value, "[") && strings.HasSuffix(value, "]") {
		inner = value[1 : len(value)-1]
	}
	list := []string{}
	for _, item := range strings.Split(inner, ",") {
		item = strings.TrimSpace(item)
		if item != "" {
			list = append(list, item)
		}
	}
	return list
}

// parseRound is JavaScript's Number.parseInt(raw, 10) followed by the
// Number.isFinite check of the TypeScript: the leading integer of the string,
// or 1 when there is none.
func parseRound(raw string) int {
	s := strings.TrimLeftFunc(raw, isJSWhiteSpace)
	sign := 1
	if strings.HasPrefix(s, "+") {
		s = s[1:]
	} else if strings.HasPrefix(s, "-") {
		sign = -1
		s = s[1:]
	}
	end := 0
	for end < len(s) && s[end] >= '0' && s[end] <= '9' {
		end++
	}
	if end == 0 {
		return 1
	}
	value, err := strconv.ParseFloat(s[:end], 64)
	if err != nil || math.IsInf(value, 0) || math.IsNaN(value) {
		return 1
	}
	value *= float64(sign)
	if value > math.MaxInt32 {
		return math.MaxInt32
	}
	if value < math.MinInt32 {
		return math.MinInt32
	}
	return int(value)
}

func isJSWhiteSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0x00a0, 0xfeff, 0x2028, 0x2029:
		return true
	}
	return r >= 0x1680 && (r == 0x1680 || (r >= 0x2000 && r <= 0x200a) || r == 0x202f || r == 0x205f || r == 0x3000)
}

// ParsePlan parses the frontmatter and tasks of one plan file, or returns nil
// when the frontmatter has no id.
func ParsePlan(text string) *ParsedPlan {
	lines := splitPlanLines(text)
	open := -1
	for i, line := range lines {
		if strings.TrimSpace(line) == "---" {
			open = i
			break
		}
	}
	if open == -1 {
		return nil
	}
	closeRel := -1
	for i := open + 1; i < len(lines); i++ {
		if strings.TrimSpace(lines[i]) == "---" {
			closeRel = i
			break
		}
	}
	if closeRel == -1 {
		return nil
	}
	closeAt := closeRel

	meta := map[string]string{}
	for _, line := range lines[open+1 : closeAt] {
		match := keyLineRe.FindStringSubmatch(line)
		if match == nil {
			continue
		}
		meta[strings.ToLower(match[1])] = cleanValue(match[2])
	}

	id := meta["id"]
	if id == "" {
		return nil
	}
	trace := meta["trace"]
	round := 1
	if raw, ok := meta["round"]; ok {
		round = parseRound(raw)
	}

	tasks := []PlanTask{}
	var current *PlanTask
	inMeta := false

	for _, line := range lines[closeAt+1:] {
		if heading := taskHeadingRe.FindStringSubmatch(line); heading != nil {
			tasks = append(tasks, PlanTask{ID: heading[1], Role: "implement", Pair: nil, DependsOn: []string{}})
			// Point at the stored task so later metadata edits that task.
			current = &tasks[len(tasks)-1]
			inMeta = true
			continue
		}
		if current == nil || !inMeta {
			continue
		}
		if strings.TrimSpace(line) == "" {
			inMeta = false
			continue
		}
		match := keyLineRe.FindStringSubmatch(line)
		if match == nil {
			inMeta = false
			continue
		}
		key := strings.ToLower(match[1])
		value := cleanValue(match[2])
		if key == "depends_on" {
			current.DependsOn = parseList(match[2])
		} else if key == "role" {
			if value != "" {
				current.Role = value
			}
		} else if key == "pair" {
			if value == "" {
				current.Pair = nil
			} else {
				pair := value
				current.Pair = &pair
			}
		}
	}

	if trace == "" {
		trace = id
	}
	return &ParsedPlan{ID: id, Trace: trace, Round: round, Tasks: tasks}
}

// ReadTraceEvents returns the events of one plan, skipping malformed lines and
// events of another plan. A missing or unreadable trace file is an empty list.
func ReadTraceEvents(plansDir, trace, planID string) []TraceEvent {
	events := []TraceEvent{}
	file, ok := fsx.ResolveInside(plansDir, "traces", trace+".jsonl")
	if !ok {
		return events
	}
	data, err := os.ReadFile(file)
	if err != nil {
		return events
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var parsed any
		if err := json.Unmarshal([]byte(line), &parsed); err != nil {
			continue
		}
		raw, ok := parsed.(map[string]any)
		if !ok {
			continue
		}
		plan, ok := raw["plan"].(string)
		if !ok || plan != planID {
			continue
		}
		event := TraceEvent{Ts: stringsOf(raw["ts"]), Kind: stringsOf(raw["kind"]), Plan: stringPtr(plan)}
		if task, ok := raw["task"].(string); ok {
			event.Task = &task
		}
		if attempt, ok := raw["attempt"].(float64); ok {
			if attempt == math.Trunc(attempt) && attempt >= math.MinInt32 && attempt <= math.MaxInt32 {
				n := int(attempt)
				event.Attempt = &n
			}
		}
		if eventData, ok := raw["data"].(map[string]any); ok {
			event.Data = eventData
		}
		events = append(events, event)
	}
	return events
}

// stringsOf returns a string field, or "" when its JSON value is not a string.
func stringsOf(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	return ""
}

func stringPtr(value string) *string {
	return &value
}

func readPlanFile(file string) *ParsedPlan {
	data, err := os.ReadFile(file)
	if err != nil {
		return nil
	}
	return ParsePlan(string(data))
}

type candidate struct {
	plan *ParsedPlan
	key  float64
}

func selectNewest(candidates []candidate) *ParsedPlan {
	var best *candidate
	for i := range candidates {
		if best == nil || candidates[i].key > best.key {
			best = &candidates[i]
		}
	}
	if best == nil {
		return nil
	}
	return best.plan
}

// readDirNames reads a folder in directory order, which is the order
// readdirSync uses; os.ReadDir would sort the names instead.
func readDirNames(dir string) ([]string, bool) {
	handle, err := os.Open(dir)
	if err != nil {
		return nil, false
	}
	defer handle.Close()
	entries, err := handle.ReadDir(-1)
	if err != nil {
		return nil, false
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	return names, true
}

// mtimeMs is the modification time in Unix milliseconds, the value of
// Node's statSync(...).mtimeMs.
func mtimeMs(file string) float64 {
	info, err := os.Stat(file)
	if err != nil {
		return 0
	}
	mod := info.ModTime()
	return float64(mod.Unix())*1000 + float64(mod.Nanosecond())/1e6
}

func selectRunning(plansDir string) *ParsedPlan {
	names, ok := readDirNames(filepath.Join(plansDir, "running"))
	if !ok {
		return nil
	}
	candidates := []candidate{}
	for _, name := range names {
		if !strings.HasSuffix(name, ".md") {
			continue
		}
		file, ok := fsx.ResolveInside(plansDir, "running", name)
		if !ok {
			continue
		}
		plan := readPlanFile(file)
		if plan == nil {
			continue
		}
		candidates = append(candidates, candidate{plan: plan, key: mtimeMs(file)})
	}
	return selectNewest(candidates)
}

func doneKey(plansDir string, plan *ParsedPlan, folder string) float64 {
	events := ReadTraceEvents(plansDir, plan.Trace, plan.ID)
	var key *int64
	for _, event := range events {
		if event.Kind != "plan.end" {
			continue
		}
		if ts, ok := model.ParseTime(event.Ts); ok {
			value := ts
			key = &value
		}
	}
	if key != nil {
		return float64(*key)
	}
	return mtimeMs(folder)
}

func selectDone(plansDir string) *ParsedPlan {
	names, ok := readDirNames(filepath.Join(plansDir, "done"))
	if !ok {
		return nil
	}
	candidates := []candidate{}
	for _, name := range names {
		folder, ok := fsx.ResolveInside(plansDir, "done", name)
		if !ok {
			continue
		}
		file, ok := fsx.ResolveInside(plansDir, "done", name, "plan.md")
		if !ok {
			continue
		}
		plan := readPlanFile(file)
		if plan == nil {
			continue
		}
		candidates = append(candidates, candidate{plan: plan, key: doneKey(plansDir, plan, folder)})
	}
	return selectNewest(candidates)
}

// SelectPlan picks the newest running plan, else the newest finished plan,
// else reports why there is none.
func SelectPlan(plansDir string) Selected {
	info, err := os.Stat(plansDir)
	if err != nil || !info.IsDir() {
		return Selected{Plan: nil, Running: false, Message: stringPtr("No plans folder found")}
	}

	if running := selectRunning(plansDir); running != nil {
		return Selected{Plan: running, Running: true, Message: nil}
	}

	if done := selectDone(plansDir); done != nil {
		return Selected{Plan: done, Running: false, Message: nil}
	}

	return Selected{Plan: nil, Running: false, Message: stringPtr("No plan has run yet")}
}
