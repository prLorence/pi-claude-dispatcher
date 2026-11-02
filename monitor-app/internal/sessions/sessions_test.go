package sessions

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf16"

	"pi-monitor/internal/model"
)

const (
	ts        = "2026-10-22T18-02-28-549Z"
	fileStamp = "2026-10-22T18-02-28-549Z"
)

func ptr[T any](value T) *T {
	return &value
}

func mustJSON(t *testing.T, value any) string {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	return string(data)
}

func linesText(t *testing.T, lines []any) string {
	t.Helper()
	builder := strings.Builder{}
	for _, line := range lines {
		builder.WriteString(mustJSON(t, line))
		builder.WriteString("\n")
	}
	return builder.String()
}

func messageLine(t *testing.T, stamp string, message any) map[string]any {
	t.Helper()
	return map[string]any{"type": "message", "timestamp": stamp, "message": message}
}

func sessionHeader(id string) map[string]any {
	return map[string]any{"type": "session", "version": 3, "id": id}
}

func modelChange(modelID, stamp string) map[string]any {
	provider := ""
	name := modelID
	if slash := strings.Index(modelID, "/"); slash != -1 {
		provider = modelID[:slash]
		name = modelID[slash+1:]
	}
	return map[string]any{"type": "model_change", "timestamp": stamp, "provider": provider, "modelId": name}
}

func userMsg(text, stamp string) map[string]any {
	return messageLineRaw(stamp, map[string]any{"role": "user", "content": []any{textPart(text)}})
}

func messageLineRaw(stamp string, message any) map[string]any {
	return map[string]any{"type": "message", "timestamp": stamp, "message": message}
}

func textPart(text string) map[string]any {
	return map[string]any{"type": "text", "text": text}
}

func thinkingPart(text string) map[string]any {
	return map[string]any{"type": "thinking", "thinking": text}
}

func toolCall(name string, args any, id string) map[string]any {
	return map[string]any{"type": "toolCall", "id": id, "name": name, "arguments": args}
}

func toolResult(toolName, text, stamp string, isError bool) map[string]any {
	message := map[string]any{
		"role":     "toolResult",
		"toolName": toolName,
		"content":  []any{textPart(text)},
	}
	if isError {
		message["isError"] = true
	}
	return messageLineRaw(stamp, message)
}

func systemMsg(stamp string) map[string]any {
	return messageLineRaw(stamp, map[string]any{
		"role":     "system",
		"content":  "",
		"sections": map[string]any{"tools": strings.Repeat("system prompt text. ", 500)},
	})
}

type assistantOptions struct {
	StopReason *string
	Input      *float64
	Output     *float64
	Cost       *float64
}

func assistantMsg(parts []any, stamp string, options assistantOptions) map[string]any {
	message := map[string]any{"role": "assistant", "content": parts}
	if options.StopReason != nil {
		message["stopReason"] = *options.StopReason
	}
	if options.Input != nil || options.Output != nil || options.Cost != nil {
		input := float64(0)
		if options.Input != nil {
			input = *options.Input
		}
		output := float64(0)
		if options.Output != nil {
			output = *options.Output
		}
		cost := float64(0)
		if options.Cost != nil {
			cost = *options.Cost
		}
		message["usage"] = map[string]any{"input": input, "output": output, "cost": map[string]any{"total": cost}}
	}
	return messageLineRaw(stamp, message)
}

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

func writeSession(t *testing.T, dir, planID, sessionID string, lines []any) string {
	t.Helper()
	folder := filepath.Join(dir, "sessions", planID)
	if err := os.MkdirAll(folder, 0o700); err != nil {
		t.Fatalf("mkdir session folder: %v", err)
	}
	file := filepath.Join(folder, fileStamp+"_"+sessionID+".jsonl")
	if err := os.WriteFile(file, []byte(linesText(t, lines)), 0o600); err != nil {
		t.Fatalf("write session: %v", err)
	}
	return file
}

func writeRaw(t *testing.T, dir, planID, sessionID, text string) string {
	t.Helper()
	folder := filepath.Join(dir, "sessions", planID)
	if err := os.MkdirAll(folder, 0o700); err != nil {
		t.Fatalf("mkdir session folder: %v", err)
	}
	file := filepath.Join(folder, fileStamp+"_"+sessionID+".jsonl")
	if err := os.WriteFile(file, []byte(text), 0o600); err != nil {
		t.Fatalf("write session: %v", err)
	}
	return file
}

func kinds(entries []model.Entry) []string {
	result := make([]string, 0, len(entries))
	for _, item := range entries {
		result = append(result, string(item.Kind))
	}
	return result
}

func texts(entries []model.Entry) []string {
	result := make([]string, 0, len(entries))
	for _, item := range entries {
		result = append(result, item.Text)
	}
	return result
}

func equalStrings(t *testing.T, got, want []string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
}

func equalInts(t *testing.T, got, want []int) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
}

func equalString(t *testing.T, got *string, want string) {
	t.Helper()
	if got == nil || *got != want {
		t.Fatalf("got %v, want %q", got, want)
	}
}

func TestParseSessionLinesMapsEveryKind(t *testing.T) {
	stopToolUse := "toolUse"
	text := linesText(t, []any{
		sessionHeader("p.t.a1"),
		modelChange("opencode-go/beam-free", ts),
		map[string]any{"type": "thinking_level_change", "timestamp": ts, "thinkingLevel": "high"},
		systemMsg(ts),
		userMsg("do the thing", ts),
		assistantMsg([]any{textPart("hello"), thinkingPart("hmm"), toolCall("edit", map[string]any{"path": "src/a.ts"}, "1")}, ts, assistantOptions{StopReason: &stopToolUse}),
		toolResult("edit", "ok", ts, false),
	})
	entries, next := ParseSessionLines(text, 0)

	if next != 7 {
		t.Fatalf("next = %d, want 7", next)
	}
	equalStrings(t, kinds(entries), []string{"note", "note", "note", "user", "assistant", "thinking", "tool_call", "tool_result"})
	lineNumbers := make([]int, 0, len(entries))
	for _, item := range entries {
		lineNumbers = append(lineNumbers, item.Line)
	}
	equalInts(t, lineNumbers, []int{2, 3, 4, 5, 6, 6, 6, 7})
	equalString(t, &entries[0].Text, "model: beam-free")
	equalString(t, &entries[1].Text, "thinking: high")
	equalString(t, &entries[2].Text, "System prompt hidden")
	equalString(t, &entries[3].Text, "do the thing")
	if !entries[3].Collapsed {
		t.Fatalf("user entry is not collapsed")
	}
	equalString(t, &entries[4].Text, "hello")
	if entries[4].Collapsed {
		t.Fatalf("assistant entry is collapsed")
	}
	equalString(t, &entries[5].Text, "hmm")
	if !entries[5].Collapsed {
		t.Fatalf("thinking entry is not collapsed")
	}
	equalString(t, &entries[6].Text, `edit {"path":"src/a.ts"}`)
	if entries[6].Tool == nil || entries[6].Tool.Name != "edit" || entries[6].Tool.Args != `{"path":"src/a.ts"}` {
		t.Fatalf("tool call = %#v", entries[6].Tool)
	}
	if entries[6].Collapsed {
		t.Fatalf("tool call entry is collapsed")
	}
	equalString(t, &entries[7].Text, "ok")
	if entries[7].Tool == nil || entries[7].Tool.Name != "edit" || entries[7].Tool.Args != "" {
		t.Fatalf("tool result tool = %#v", entries[7].Tool)
	}
	if entries[7].IsError {
		t.Fatalf("tool result is an error")
	}
	equalString(t, entries[0].Ts, ts)
}

func TestParseSessionLinesJoinsTextPartsAndMarksToolErrors(t *testing.T) {
	text := linesText(t, []any{
		messageLine(t, ts, map[string]any{"role": "user", "content": []any{textPart("one "), textPart("two")}}),
		messageLine(t, ts, map[string]any{"role": "toolResult", "toolName": "bash", "isError": true, "content": []any{textPart("failed"), textPart(" hard")}}),
	})
	entries, _ := ParseSessionLines(text, 0)

	if len(entries) != 2 {
		t.Fatalf("entries = %d, want 2", len(entries))
	}
	equalString(t, &entries[0].Text, "one two")
	equalString(t, &entries[1].Text, "failed hard")
	if !entries[1].IsError {
		t.Fatalf("tool result is not an error")
	}
	if entries[1].Tool == nil || entries[1].Tool.Name != "bash" {
		t.Fatalf("tool result tool = %#v", entries[1].Tool)
	}
}

func TestParseSessionLinesIgnoresUnknownRolesAndPartTypes(t *testing.T) {
	text := linesText(t, []any{
		messageLine(t, ts, map[string]any{"role": "tool", "content": []any{textPart("ignored")}}),
		messageLine(t, ts, map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "image", "data": "x"}, textPart("kept")}}),
	})
	entries, _ := ParseSessionLines(text, 0)

	if len(entries) != 1 {
		t.Fatalf("entries = %d, want 1", len(entries))
	}
	equalString(t, &entries[0].Text, "kept")
}

func TestParseSessionLinesTruncatesLongToolResult(t *testing.T) {
	raw := strings.Repeat("x", ToolResultCap+10)
	text := linesText(t, []any{
		messageLine(t, ts, map[string]any{"role": "toolResult", "toolName": "read", "content": []any{textPart(raw)}}),
	})
	entries, _ := ParseSessionLines(text, 0)
	entry := entries[0]

	if !entry.Truncated {
		t.Fatalf("entry is not truncated")
	}
	if !strings.HasPrefix(entry.Text, strings.Repeat("x", ToolResultCap)) {
		t.Fatalf("text does not keep the capped prefix")
	}
	if !strings.HasSuffix(entry.Text, "… [truncated]") {
		t.Fatalf("text does not end with the note: %q", entry.Text)
	}
	if got, want := textLen(entry.Text), ToolResultCap+textLen(truncationNote); got != want {
		t.Fatalf("text length = %d, want %d", got, want)
	}
}

func TestParseSessionLinesKeepsExactlyCapUntruncated(t *testing.T) {
	raw := strings.Repeat("y", ToolResultCap)
	text := linesText(t, []any{
		messageLine(t, ts, map[string]any{"role": "toolResult", "toolName": "read", "content": []any{textPart(raw)}}),
	})
	entries, _ := ParseSessionLines(text, 0)
	entry := entries[0]

	if entry.Truncated {
		t.Fatalf("entry is truncated")
	}
	if got := textLen(entry.Text); got != ToolResultCap {
		t.Fatalf("text length = %d, want %d", got, ToolResultCap)
	}
}

func TestParseSessionLinesTruncatesLongToolCall(t *testing.T) {
	text := linesText(t, []any{
		messageLine(t, ts, map[string]any{"role": "assistant", "content": []any{toolCall("bash", map[string]any{"command": strings.Repeat("z", ToolArgsCap+50)}, "1")}}),
	})
	entries, _ := ParseSessionLines(text, 0)
	entry := entries[0]

	if !entry.Truncated {
		t.Fatalf("entry is not truncated")
	}
	if !strings.HasSuffix(entry.Text, "… [truncated]") {
		t.Fatalf("text does not end with the note")
	}
	if got, want := textLen(entry.Text), ToolArgsCap+textLen(truncationNote); got != want {
		t.Fatalf("text length = %d, want %d", got, want)
	}
	if entry.Tool == nil || entry.Tool.Name != "bash" {
		t.Fatalf("tool = %#v", entry.Tool)
	}
}

func TestParseSessionLinesSkipsInvalidMiddleLineAndAdvances(t *testing.T) {
	stop := "stop"
	first := mustJSON(t, messageLine(t, ts, map[string]any{"role": "assistant", "content": []any{textPart("one")}, "stopReason": stop}))
	third := mustJSON(t, messageLine(t, ts, map[string]any{"role": "assistant", "content": []any{textPart("three")}, "stopReason": stop}))
	entries, next := ParseSessionLines(first+"\nnot json\n"+third+"\n", 0)

	if next != 3 {
		t.Fatalf("next = %d, want 3", next)
	}
	equalStrings(t, texts(entries), []string{"one", "three"})
}

func TestParseSessionLinesDoesNotConsumePartialLastLine(t *testing.T) {
	stop := "stop"
	first := mustJSON(t, messageLine(t, ts, map[string]any{"role": "assistant", "content": []any{textPart("one")}, "stopReason": stop})) + "\n"
	second := mustJSON(t, messageLine(t, ts, map[string]any{"role": "assistant", "content": []any{textPart("two")}, "stopReason": stop})) + "\n"
	partial := second[:25]

	before, next := ParseSessionLines(first+partial, 0)
	if next != 1 {
		t.Fatalf("before next = %d, want 1", next)
	}
	equalStrings(t, texts(before), []string{"one"})

	after, next := ParseSessionLines(first+second, next)
	if next != 2 {
		t.Fatalf("after next = %d, want 2", next)
	}
	equalStrings(t, texts(after), []string{"two"})

	again, next := ParseSessionLines(first+second, next)
	if next != 2 {
		t.Fatalf("again next = %d, want 2", next)
	}
	if len(again) != 0 {
		t.Fatalf("again entries = %v, want none", texts(again))
	}
}

func TestParseSessionLinesWithNothingNewReturnsAfter(t *testing.T) {
	entries, next := ParseSessionLines("", 0)
	if len(entries) != 0 || next != 0 {
		t.Fatalf("empty = %v, %d, want [], 0", texts(entries), next)
	}
	entries, next = ParseSessionLines("one\n", 5)
	if len(entries) != 0 || next != 5 {
		t.Fatalf("nothing new = %v, %d, want [], 5", texts(entries), next)
	}
	if entries == nil {
		t.Fatalf("entries is nil, want an empty slice")
	}
}

func TestSummarizeSessionReportsMissingFile(t *testing.T) {
	summary := SummarizeSession("")
	if summary.Exists {
		t.Fatalf("exists = true, want false")
	}
	if summary.Ended {
		t.Fatalf("ended = true, want false")
	}
	if summary.MtimeMs != 0 {
		t.Fatalf("mtimeMs = %v, want 0", summary.MtimeMs)
	}
	if summary.Tokens != nil {
		t.Fatalf("tokens = %v, want nil", *summary.Tokens)
	}
	if summary.Error != nil {
		t.Fatalf("error = %q, want nil", *summary.Error)
	}
}

func TestSummarizeSessionReportsUnreadableFile(t *testing.T) {
	dir := makePlansDir(t)
	folder := filepath.Join(dir, "sessions", "p1")
	if err := os.MkdirAll(folder, 0o700); err != nil {
		t.Fatalf("mkdir folder: %v", err)
	}
	file := filepath.Join(folder, "not-a-file.jsonl")
	if err := os.Mkdir(file, 0o700); err != nil {
		t.Fatalf("mkdir not-a-file: %v", err)
	}

	summary := SummarizeSession(file)
	if !summary.Exists {
		t.Fatalf("exists = false, want true")
	}
	if summary.Ended {
		t.Fatalf("ended = true, want false")
	}
	equalString(t, summary.Error, "unreadable session")
	if summary.Tokens != nil {
		t.Fatalf("tokens = %v, want nil", *summary.Tokens)
	}
	if summary.Cost != nil {
		t.Fatalf("cost = %v, want nil", *summary.Cost)
	}
}

func TestSummarizeSessionTreatsEmptyFileAsNotEnded(t *testing.T) {
	dir := makePlansDir(t)
	file := writeSession(t, dir, "p1", "p1.t.a1", []any{})
	summary := SummarizeSession(file)

	if !summary.Exists {
		t.Fatalf("exists = false, want true")
	}
	if summary.Ended {
		t.Fatalf("ended = true, want false")
	}
	if summary.StopReason != nil {
		t.Fatalf("stopReason = %q, want nil", *summary.StopReason)
	}
	if summary.StartedAt != nil {
		t.Fatalf("startedAt = %q, want nil", *summary.StartedAt)
	}
	if summary.LastTs != nil {
		t.Fatalf("lastTs = %q, want nil", *summary.LastTs)
	}
	if summary.MtimeMs <= 0 {
		t.Fatalf("mtimeMs = %v, want > 0", summary.MtimeMs)
	}
}

func TestSummarizeSessionNotEndedWhileWaitingForTool(t *testing.T) {
	dir := makePlansDir(t)
	toolUse := "toolUse"
	file := writeSession(t, dir, "p1", "p1.t.a1", []any{
		sessionHeader("p1.t.a1"),
		assistantMsg([]any{textPart("working")}, ts, assistantOptions{StopReason: &toolUse}),
	})
	summary := SummarizeSession(file)

	if summary.Ended {
		t.Fatalf("ended = true, want false")
	}
	equalString(t, summary.StopReason, "toolUse")
	equalString(t, summary.LastText, "working")
}

func TestSummarizeSessionEndedOnStopAndSumsUsage(t *testing.T) {
	dir := makePlansDir(t)
	stop := "stop"
	file := writeSession(t, dir, "p1", "p1.t.a1", []any{
		sessionHeader("p1.t.a1"),
		modelChange("opencode-go/beam-free", ts),
		map[string]any{"type": "thinking_level_change", "timestamp": ts, "thinkingLevel": "medium"},
		userMsg("go", ts),
		assistantMsg([]any{textPart("first")}, ts, assistantOptions{StopReason: &stop, Input: ptr(float64(10)), Output: ptr(float64(5)), Cost: ptr(0.25)}),
		assistantMsg([]any{textPart("second")}, ts, assistantOptions{StopReason: &stop, Input: ptr(float64(7)), Output: ptr(float64(3)), Cost: ptr(0.5)}),
	})
	summary := SummarizeSession(file)

	if !summary.Ended {
		t.Fatalf("ended = false, want true")
	}
	equalString(t, summary.StopReason, "stop")
	if summary.Tokens == nil || *summary.Tokens != 25 {
		t.Fatalf("tokens = %v, want 25", summary.Tokens)
	}
	if summary.Cost == nil || *summary.Cost != 0.75 {
		t.Fatalf("cost = %v, want 0.75", summary.Cost)
	}
	equalString(t, summary.StartedAt, ts)
	equalString(t, summary.LastTs, ts)
	equalString(t, summary.LastText, "second")
	equalString(t, summary.Model, "beam-free")
	equalString(t, summary.Thinking, "medium")
	if summary.Error != nil {
		t.Fatalf("error = %q, want nil", *summary.Error)
	}
}

func TestSummarizeSessionEndedOnErrorKeepsError(t *testing.T) {
	dir := makePlansDir(t)
	file := writeSession(t, dir, "p1", "p1.t.a1", []any{
		messageLine(t, ts, map[string]any{
			"role":         "assistant",
			"content":      []any{textPart("boom")},
			"stopReason":   "error",
			"errorMessage": "provider failed",
		}),
	})
	summary := SummarizeSession(file)

	if !summary.Ended {
		t.Fatalf("ended = false, want true")
	}
	equalString(t, summary.StopReason, "error")
	equalString(t, summary.Error, "provider failed")
}

func TestSummarizeSessionReportsNoTokensWithoutUsage(t *testing.T) {
	dir := makePlansDir(t)
	stop := "stop"
	file := writeSession(t, dir, "p1", "p1.t.a1", []any{
		assistantMsg([]any{textPart("no usage")}, ts, assistantOptions{StopReason: &stop}),
	})
	summary := SummarizeSession(file)

	if summary.Tokens != nil {
		t.Fatalf("tokens = %v, want nil", *summary.Tokens)
	}
	if summary.Cost != nil {
		t.Fatalf("cost = %v, want nil", *summary.Cost)
	}
}

func TestSummarizeSessionFormatsLastToolCall(t *testing.T) {
	stop := "stop"
	cases := []struct {
		name     string
		args     any
		expected string
	}{
		{name: "read", args: map[string]any{"path": "src/deep/a.ts"}, expected: "read a.ts"},
		{name: "edit", args: map[string]any{"file_path": "src/b.ts"}, expected: "edit b.ts"},
		{name: "write", args: map[string]any{"file": "src/c.ts"}, expected: "write c.ts"},
		{name: "bash", args: map[string]any{"command": "npm test -- --watch"}, expected: "bash npm test -- --watch"},
		{name: "grep", args: map[string]any{"pattern": "x"}, expected: "grep"},
	}

	dir := makePlansDir(t)
	for index, item := range cases {
		file := writeSession(t, dir, "p1", "p1.t.a"+string(rune('1'+index)), []any{
			assistantMsg([]any{toolCall(item.name, item.args, "1")}, ts, assistantOptions{StopReason: &stop}),
		})
		equalString(t, SummarizeSession(file).LastTool, item.expected)
	}
}

func TestSummarizeSessionCutsLongBashCommandAt60(t *testing.T) {
	dir := makePlansDir(t)
	stop := "stop"
	command := strings.Repeat("c", 100)
	file := writeSession(t, dir, "p1", "p1.t.a1", []any{
		assistantMsg([]any{toolCall("bash", map[string]any{"command": command}, "1")}, ts, assistantOptions{StopReason: &stop}),
	})
	equalString(t, SummarizeSession(file).LastTool, "bash "+strings.Repeat("c", 60))
}

func TestListSessionFilesListsPlainFilesAndIgnoresRetired(t *testing.T) {
	dir := makePlansDir(t)
	writeSession(t, dir, "p1", "p1.t.a2", []any{sessionHeader("p1.t.a2")})
	writeSession(t, dir, "p1", "p1.t.review1.a1", []any{sessionHeader("p1.t.review1.a1")})
	retired := filepath.Join(dir, "sessions", "p1", fileStamp+"_p1.t.a1.jsonl")
	if err := os.WriteFile(retired, []byte(""), 0o600); err != nil {
		t.Fatalf("write retired: %v", err)
	}
	retiredName := filepath.Join(dir, "sessions", "p1", fileStamp+"_p1.t.a1.jsonl.prev-20261023")
	if err := os.Rename(retired, retiredName); err != nil {
		t.Fatalf("rename retired: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "sessions", "p1", "nested.jsonl"), 0o700); err != nil {
		t.Fatalf("mkdir nested: %v", err)
	}

	files := ListSessionFiles(dir, "p1")
	ids := make([]string, 0, len(files))
	for _, item := range files {
		ids = append(ids, item.ID)
		info, err := os.Stat(item.File)
		if err != nil || !info.Mode().IsRegular() {
			t.Fatalf("%s is not a file", item.File)
		}
	}
	equalStrings(t, ids, []string{"p1.t.a2", "p1.t.review1.a1"})
}

func TestListSessionFilesEmptyWhenFolderMissing(t *testing.T) {
	dir := makePlansDir(t)
	files := ListSessionFiles(dir, "missing")
	if len(files) != 0 {
		t.Fatalf("files = %v, want none", files)
	}
}

func TestFindSessionFileReturnsLastMatch(t *testing.T) {
	dir := makePlansDir(t)
	folder := filepath.Join(dir, "sessions", "p1")
	if err := os.MkdirAll(folder, 0o700); err != nil {
		t.Fatalf("mkdir folder: %v", err)
	}
	first := filepath.Join(folder, "2026-01-01T00-00-00-000Z_p1.t.a1.jsonl")
	second := filepath.Join(folder, "2026-02-01T00-00-00-000Z_p1.t.a1.jsonl")
	for _, name := range []string{first, second} {
		if err := os.WriteFile(name, []byte(""), 0o600); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}

	if got, ok := FindSessionFile(dir, "p1", "p1.t.a1"); !ok || got != second {
		t.Fatalf("FindSessionFile = %q, %v, want %q, true", got, ok, second)
	}
	if _, ok := FindSessionFile(dir, "p1", "p1.t.a9"); ok {
		t.Fatalf("FindSessionFile for an unknown id found a file")
	}
}

func TestParseSessionLinesJSONStringifyArgumentsKeepsOrderAndDoesNotEscapeHTML(t *testing.T) {
	raw := `{"type":"message","timestamp":"` + ts + `","message":{"role":"assistant","content":[{"type":"toolCall","id":"1","name":"edit","arguments":{"zeta":"<a>&b","alpha":1e21,"mid":0.5}}]}}`
	entries, _ := ParseSessionLines(raw+"\n", 0)

	if len(entries) != 1 {
		t.Fatalf("entries = %d, want 1", len(entries))
	}
	want := `edit {"zeta":"<a>&b","alpha":1e+21,"mid":0.5}`
	equalString(t, &entries[0].Text, want)
	if entries[0].Tool == nil || entries[0].Tool.Args != `{"zeta":"<a>&b","alpha":1e+21,"mid":0.5}` {
		t.Fatalf("tool args = %#v", entries[0].Tool)
	}
}

func TestParseSessionLinesCapsNonASCIITextInUTF16Units(t *testing.T) {
	raw := strings.Repeat("中", 1000) + strings.Repeat("🙂", 600)
	text := linesText(t, []any{
		messageLine(t, ts, map[string]any{"role": "toolResult", "toolName": "read", "content": []any{textPart(raw)}}),
	})
	entries, _ := ParseSessionLines(text, 0)
	entry := entries[0]

	if !entry.Truncated {
		t.Fatalf("entry is not truncated")
	}
	if got, want := textLen(entry.Text), ToolResultCap+textLen(truncationNote); got != want {
		t.Fatalf("text length = %d, want %d", got, want)
	}
	wantPrefix := string(utf16.Decode(utf16.Encode([]rune(raw))[:ToolResultCap]))
	if !strings.HasPrefix(entry.Text, wantPrefix) {
		t.Fatalf("text does not keep the capped prefix")
	}
}

func TestListSessionFilesRejectsSymlinkEscape(t *testing.T) {
	plans := makePlansDir(t)
	outside := t.TempDir()
	secret := filepath.Join(outside, "secret.jsonl")
	if err := os.WriteFile(secret, []byte("{\"type\":\"session\"}\n"), 0o600); err != nil {
		t.Fatalf("write secret: %v", err)
	}
	folder := filepath.Join(plans, "sessions", "p1")
	if err := os.MkdirAll(folder, 0o700); err != nil {
		t.Fatalf("mkdir folder: %v", err)
	}
	escape := filepath.Join(folder, fileStamp+"_p1.t.a1.jsonl")
	if err := os.Symlink(secret, escape); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	if files := ListSessionFiles(plans, "p1"); len(files) != 0 {
		t.Fatalf("files = %v, want none", files)
	}
	if _, ok := FindSessionFile(plans, "p1", "p1.t.a1"); ok {
		t.Fatalf("FindSessionFile found a file outside the plans folder")
	}
}

func TestJSNumberMatchesJavaScriptFormatting(t *testing.T) {
	cases := []struct {
		value    float64
		expected string
	}{
		{value: 0, expected: "0"},
		{value: 42, expected: "42"},
		{value: 0.5, expected: "0.5"},
		{value: -0.5, expected: "-0.5"},
		{value: 1e21, expected: "1e+21"},
		{value: 1e-7, expected: "1e-7"},
		{value: 123456789012345680000, expected: "123456789012345680000"},
		{value: 1.5e-8, expected: "1.5e-8"},
	}
	for _, item := range cases {
		if got := jsNumber(item.value); got != item.expected {
			t.Fatalf("jsNumber(%v) = %q, want %q", item.value, got, item.expected)
		}
	}
}

func TestSessionIDFromName(t *testing.T) {
	cases := []struct {
		name     string
		expected *string
	}{
		{name: "2026-01-01T00-00-00-000Z_p1.t.a1.jsonl", expected: ptr("p1.t.a1")},
		{name: "plain.jsonl", expected: nil},
		{name: "2026-01-01T00-00-00-000Z_.jsonl", expected: nil},
		{name: "2026-01-01T00-00-00-000Z_p1.t.a1.jsonl.prev", expected: nil},
		{name: "2026-01-01T00-00-00-000Z_p1.t.a1.txt", expected: nil},
	}
	for _, item := range cases {
		got := sessionIDFromName(item.name)
		if item.expected == nil {
			if got != nil {
				t.Fatalf("sessionIDFromName(%q) = %q, want nil", item.name, *got)
			}
			continue
		}
		if got == nil || *got != *item.expected {
			t.Fatalf("sessionIDFromName(%q) = %v, want %q", item.name, got, *item.expected)
		}
	}
}

func writeLinesFile(t *testing.T, dir, name string, lines []any) string {
	t.Helper()
	file := filepath.Join(dir, name)
	if err := os.WriteFile(file, []byte(linesText(t, lines)), 0o600); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
	return file
}

func ompHeader(id, cwd, title string) map[string]any {
	return map[string]any{"type": "session", "version": 3, "id": id, "cwd": cwd, "title": title}
}

func TestParseSessionLinesReadsOmpNotesAndToolError(t *testing.T) {
	text := linesText(t, []any{
		ompHeader("omp1", "/tmp/repo", "omp work"),
		messageLineRaw(ts, map[string]any{"role": "developer", "content": []any{textPart("rules")}}),
		messageLineRaw(ts, map[string]any{"role": "fileMention", "files": []any{"a.go", "b.go"}}),
		messageLineRaw(ts, map[string]any{"role": "toolResult", "toolName": "bash", "toolCallId": "1", "isError": true, "content": []any{textPart("boom")}}),
	})
	entries, next := ParseSessionLines(text, 0)

	if next != 4 {
		t.Fatalf("next = %d, want 4", next)
	}
	equalStrings(t, kinds(entries), []string{"note", "note", "tool_result"})
	equalStrings(t, texts(entries), []string{"developer message", "file mention", "boom"})
	if !entries[0].Collapsed || !entries[1].Collapsed {
		t.Fatalf("developer or fileMention note is not collapsed")
	}
	if !entries[2].IsError {
		t.Fatalf("tool result is not an error")
	}
}

func TestParseSessionLinesIgnoresUnknownToolNames(t *testing.T) {
	text := linesText(t, []any{
		messageLine(t, ts, map[string]any{"role": "assistant", "content": []any{toolCall("mystery", map[string]any{"x": 1}, "1")}}),
		map[string]any{"type": "some_unknown_line", "timestamp": ts},
	})
	entries, _ := ParseSessionLines(text, 0)

	if len(entries) != 1 {
		t.Fatalf("entries = %d, want 1", len(entries))
	}
	if entries[0].Tool == nil || entries[0].Tool.Name != "mystery" {
		t.Fatalf("tool = %#v, want mystery", entries[0].Tool)
	}
}

func TestSummarizeSessionReadsOmpModelAndCost(t *testing.T) {
	dir := makePlansDir(t)
	stop := "stop"
	file := writeSession(t, dir, "p1", "omp1", []any{
		ompHeader("omp1", "/tmp/repo", "omp work"),
		messageLineRaw(ts, map[string]any{
			"role":       "assistant",
			"model":      "gpt-5",
			"stopReason": stop,
			"content":    []any{textPart("hello")},
			"usage":      map[string]any{"input": 12.0, "output": 3.0, "cost": map[string]any{"total": 1.25}},
		}),
	})
	summary := SummarizeSession(file)

	if !summary.Ended {
		t.Fatalf("ended = false, want true")
	}
	equalString(t, summary.Model, "gpt-5")
	if summary.Cost == nil || *summary.Cost != 1.25 {
		t.Fatalf("cost = %v, want 1.25", summary.Cost)
	}
	if summary.Tokens == nil || *summary.Tokens != 15 {
		t.Fatalf("tokens = %v, want 15", summary.Tokens)
	}
}

func TestReadSessionHeader(t *testing.T) {
	dir := t.TempDir()
	headerLine := `{"type":"session","version":3,"id":"abc","cwd":"/tmp/repo","title":"Work"}`
	write := func(name, content string) string {
		file := filepath.Join(dir, name)
		if err := os.WriteFile(file, []byte(content), 0o600); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
		return file
	}

	header, ok := ReadSessionHeader(write("good.jsonl", headerLine+"\n"))
	if !ok {
		t.Fatalf("good header = false, want true")
	}
	if header.ID != "abc" || header.Cwd != "/tmp/repo" || header.Title != "Work" {
		t.Fatalf("header = %#v", header)
	}

	header, ok = ReadSessionHeader(write("no-newline.jsonl", headerLine))
	if !ok || header.ID != "abc" {
		t.Fatalf("header without a trailing newline = %#v, %v", header, ok)
	}

	if _, ok := ReadSessionHeader(write("other.jsonl", `{"type":"message"}`+"\n")); ok {
		t.Fatalf("non-session first line = true, want false")
	}
	if _, ok := ReadSessionHeader(write("empty.jsonl", "")); ok {
		t.Fatalf("empty file = true, want false")
	}
	if _, ok := ReadSessionHeader(filepath.Join(dir, "missing.jsonl")); ok {
		t.Fatalf("missing file = true, want false")
	}

	header, ok = ReadSessionHeader(write("broken-after.jsonl", headerLine+"\nnot json\n"))
	if !ok || header.ID != "abc" {
		t.Fatalf("invalid JSON after the header = %#v, %v, want the header", header, ok)
	}

	huge := `{"type":"session","id":"` + strings.Repeat("x", headerMaxBytes) + `"}`
	if _, ok := ReadSessionHeader(write("huge.jsonl", huge+"\n")); ok {
		t.Fatalf("first line over 1 MB = true, want false")
	}
}

func TestReadAgentInfoReadsHeaderPromptAndModel(t *testing.T) {
	dir := t.TempDir()
	file := writeLinesFile(t, dir, "omp.jsonl", []any{
		ompHeader("omp1", "/tmp/repo", "omp work"),
		userMsg("hello there", ts),
		messageLineRaw(ts, map[string]any{"role": "assistant", "model": "omp-model", "content": []any{textPart("hi")}}),
	})

	info, ok := ReadAgentInfo(file)
	if !ok {
		t.Fatalf("ReadAgentInfo = false, want true")
	}
	if info.ID != "omp1" || info.Cwd != "/tmp/repo" || info.Title != "omp work" {
		t.Fatalf("header = %#v", info.SessionHeader)
	}
	if info.FirstPrompt != "hello there" {
		t.Fatalf("first prompt = %q, want %q", info.FirstPrompt, "hello there")
	}
	equalString(t, info.Model, "omp-model")
}

func TestReadAgentInfoFallsBackToFirstPromptForTitle(t *testing.T) {
	dir := t.TempDir()
	prompt := strings.Repeat("p", 100)
	file := writeLinesFile(t, dir, "untitled.jsonl", []any{
		ompHeader("omp1", "/tmp/repo", ""),
		userMsg(prompt, ts),
	})

	info, ok := ReadAgentInfo(file)
	if !ok {
		t.Fatalf("ReadAgentInfo = false, want true")
	}
	if want := strings.Repeat("p", 80); info.FirstPrompt != want {
		t.Fatalf("first prompt length = %d, want 80", textLen(info.FirstPrompt))
	}
	if info.Title != info.FirstPrompt {
		t.Fatalf("title = %q, want the first prompt", info.Title)
	}
	if info.Model != nil {
		t.Fatalf("model = %q, want nil", *info.Model)
	}
}

func TestReadAgentInfoRejectsFileWithoutSessionHeader(t *testing.T) {
	dir := t.TempDir()
	file := writeLinesFile(t, dir, "other.jsonl", []any{
		map[string]any{"type": "message", "timestamp": ts},
		userMsg("hello", ts),
	})
	if _, ok := ReadAgentInfo(file); ok {
		t.Fatalf("ReadAgentInfo = true, want false")
	}
}

func TestReadAgentInfoPrefersLatestModelChange(t *testing.T) {
	dir := t.TempDir()
	file := writeLinesFile(t, dir, "model.jsonl", []any{
		ompHeader("omp1", "/tmp/repo", "omp work"),
		messageLineRaw(ts, map[string]any{"role": "assistant", "model": "assistant-model", "content": []any{textPart("one")}}),
		modelChange("opencode-go/changed-model", ts),
		messageLineRaw(ts, map[string]any{"role": "assistant", "model": "later-assistant", "content": []any{textPart("two")}}),
	})

	info, ok := ReadAgentInfo(file)
	if !ok {
		t.Fatalf("ReadAgentInfo = false, want true")
	}
	equalString(t, info.Model, "changed-model")
}

func TestReadAgentInfoSkipsOverlongLine(t *testing.T) {
	dir := t.TempDir()
	text := mustJSON(t, ompHeader("omp1", "/tmp/repo", "omp work")) + "\n" +
		strings.Repeat("z", agentLineMaxBytes+1) + "\n" +
		mustJSON(t, userMsg("after the long line", ts)) + "\n"
	file := filepath.Join(dir, "long.jsonl")
	if err := os.WriteFile(file, []byte(text), 0o600); err != nil {
		t.Fatalf("write long: %v", err)
	}

	info, ok := ReadAgentInfo(file)
	if !ok {
		t.Fatalf("ReadAgentInfo = false, want true")
	}
	if info.FirstPrompt != "after the long line" {
		t.Fatalf("first prompt = %q, want the line after the overlong one", info.FirstPrompt)
	}
}

func codeAt(t *testing.T, entries []model.Entry, index int) *model.CodeBlock {
	t.Helper()
	if len(entries) <= index {
		t.Fatalf("entries = %d, want at least %d", len(entries), index+1)
	}
	if entries[index].Code == nil {
		t.Fatalf("entry %d has no code block", index)
	}
	return entries[index].Code
}

func noCodeAt(t *testing.T, entries []model.Entry, index int) {
	t.Helper()
	if len(entries) <= index {
		t.Fatalf("entries = %d, want at least %d", len(entries), index+1)
	}
	if entries[index].Code != nil {
		t.Fatalf("entry %d code = %#v, want none", index, entries[index].Code)
	}
}

func equalCode(t *testing.T, block *model.CodeBlock, kind string, path *string, text string) {
	t.Helper()
	if block.Kind != kind {
		t.Fatalf("code kind = %q, want %q", block.Kind, kind)
	}
	if path == nil {
		if block.Path != nil {
			t.Fatalf("code path = %q, want nil", *block.Path)
		}
	} else if block.Path == nil || *block.Path != *path {
		t.Fatalf("code path = %v, want %q", block.Path, *path)
	}
	if block.Text != text {
		t.Fatalf("code text = %q, want %q", block.Text, text)
	}
}

func TestParseSessionLinesCodeBlocksForToolCalls(t *testing.T) {
	text := linesText(t, []any{
		messageLine(t, ts, map[string]any{"role": "assistant", "content": []any{
			toolCall("write", map[string]any{"path": "src/a.ts", "content": "package a\n\nfunc A() {}\n"}, "w1"),
			toolCall("bash", map[string]any{"command": "go test ./..."}, "b1"),
			toolCall("edit", map[string]any{"path": "src/b.ts", "edits": []any{
				map[string]any{"oldText": "one\ntwo\n", "newText": "uno\n"},
				map[string]any{"oldText": "three", "newText": "tres"},
			}}, "e1"),
		}}),
	})
	entries, _ := ParseSessionLines(text, 0)

	if len(entries) != 3 {
		t.Fatalf("entries = %d, want 3", len(entries))
	}
	equalCode(t, codeAt(t, entries, 0), "file", ptr("src/a.ts"), "package a\n\nfunc A() {}\n")
	equalCode(t, codeAt(t, entries, 1), "command", nil, "go test ./...")
	equalCode(t, codeAt(t, entries, 2), "diff", ptr("src/b.ts"), "-one\n-two\n+uno\n@@\n-three\n+tres")
	equalString(t, &entries[0].Text, `write {"content":"package a\n\nfunc A() {}\n","path":"src/a.ts"}`)
	if entries[0].Truncated {
		t.Fatalf("write entry is truncated")
	}
}

func TestParseSessionLinesOmpEditPathFromInput(t *testing.T) {
	cases := []struct {
		name  string
		input string
		path  *string
	}{
		{name: "stars", input: "*** src/e.go\n@@ -1 +1 @@\n-old\n+new\n", path: ptr("src/e.go")},
		{name: "dashes", input: "--- src/e.go\n+++ src/e.go\n-a\n+b\n", path: ptr("src/e.go")},
		{name: "at", input: "\n@@ src/e.go\n", path: ptr("src/e.go")},
		{name: "begin patch", input: "*** Begin Patch\n*** Update File: src/e.go\n", path: nil},
		{name: "space", input: "*** src/e.go extra\n", path: nil},
		{name: "no suffix", input: "*** Makefile\n", path: nil},
		{name: "long suffix", input: "*** a.abcdefghi\n", path: nil},
		{name: "no marker", input: "src/e.go\n", path: nil},
		{name: "empty", input: "", path: nil},
	}

	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			text := linesText(t, []any{
				messageLine(t, ts, map[string]any{"role": "assistant", "content": []any{
					toolCall("edit", map[string]any{"input": item.input}, "e1"),
				}}),
			})
			entries, _ := ParseSessionLines(text, 0)
			equalCode(t, codeAt(t, entries, 0), "diff", item.path, item.input)
		})
	}
}

func TestParseSessionLinesEditWithNeitherEditsNorInputHasNoCode(t *testing.T) {
	text := linesText(t, []any{
		messageLine(t, ts, map[string]any{"role": "assistant", "content": []any{
			toolCall("edit", map[string]any{"path": "src/a.ts"}, "e1"),
		}}),
	})
	entries, _ := ParseSessionLines(text, 0)
	noCodeAt(t, entries, 0)
	equalString(t, &entries[0].Text, `edit {"path":"src/a.ts"}`)
}

func TestParseSessionLinesCodeBlocksForReadResults(t *testing.T) {
	text := linesText(t, []any{
		messageLine(t, ts, map[string]any{"role": "assistant", "content": []any{
			toolCall("read", map[string]any{"path": "src/c.ts"}, "r1"),
			toolCall("write", map[string]any{"path": "src/d.ts", "content": "x"}, "w1"),
		}}),
		messageLineRaw(ts, map[string]any{"role": "toolResult", "toolName": "read", "toolCallId": "missing", "content": []any{textPart("orphan")}}),
		messageLineRaw(ts, map[string]any{"role": "toolResult", "toolName": "read", "toolCallId": "r1", "content": []any{textPart("file body")}}),
		messageLineRaw(ts, map[string]any{"role": "toolResult", "toolName": "read", "toolCallId": "r1", "isError": true, "content": []any{textPart("failed")}}),
		messageLineRaw(ts, map[string]any{"role": "toolResult", "toolName": "write", "toolCallId": "w1", "content": []any{textPart("written")}}),
	})
	entries, _ := ParseSessionLines(text, 0)

	if len(entries) != 6 {
		t.Fatalf("entries = %d, want 6", len(entries))
	}
	noCodeAt(t, entries, 0)
	equalCode(t, codeAt(t, entries, 1), "file", ptr("src/d.ts"), "x")
	noCodeAt(t, entries, 2)
	equalCode(t, codeAt(t, entries, 3), "file", ptr("src/c.ts"), "file body")
	noCodeAt(t, entries, 4)
	noCodeAt(t, entries, 5)
	equalString(t, &entries[3].Text, "file body")
}

func TestParseSessionLinesMatchesReadCallBeforeAfter(t *testing.T) {
	text := linesText(t, []any{
		messageLine(t, ts, map[string]any{"role": "assistant", "content": []any{
			toolCall("read", map[string]any{"path": "src/early.ts"}, "r1"),
		}}),
		messageLineRaw(ts, map[string]any{"role": "toolResult", "toolName": "read", "toolCallId": "r1", "content": []any{textPart("later body")}}),
	})
	entries, next := ParseSessionLines(text, 1)

	if next != 2 {
		t.Fatalf("next = %d, want 2", next)
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %d, want 1", len(entries))
	}
	equalCode(t, codeAt(t, entries, 0), "file", ptr("src/early.ts"), "later body")
}

func TestParseSessionLinesCodeBlocksForOtherToolsAndBadArguments(t *testing.T) {
	text := linesText(t, []any{
		messageLine(t, ts, map[string]any{"role": "assistant", "content": []any{
			toolCall("find", map[string]any{"paths": []any{"."}, "pattern": "x"}, "f1"),
			toolCall("mystery", map[string]any{"x": 1}, "m1"),
			toolCall("bash", "not an object", "b1"),
		}}),
		messageLineRaw(ts, map[string]any{"role": "toolResult", "toolName": "find", "toolCallId": "f1", "content": []any{textPart("hits")}}),
	})
	entries, _ := ParseSessionLines(text, 0)

	if len(entries) != 4 {
		t.Fatalf("entries = %d, want 4", len(entries))
	}
	for index := range entries {
		noCodeAt(t, entries, index)
	}
}

func TestParseSessionLinesCapsCodeBlockText(t *testing.T) {
	command := strings.Repeat("q", ToolArgsCap+25)
	text := linesText(t, []any{
		messageLine(t, ts, map[string]any{"role": "assistant", "content": []any{
			toolCall("write", map[string]any{"path": "src/big.ts", "content": command}, "w1"),
		}}),
	})
	entries, _ := ParseSessionLines(text, 0)
	block := codeAt(t, entries, 0)

	if !strings.HasSuffix(block.Text, truncationNote) {
		t.Fatalf("block text does not end with the note")
	}
	if got, want := textLen(block.Text), ToolArgsCap+textLen(truncationNote); got != want {
		t.Fatalf("block text length = %d, want %d", got, want)
	}
	if !entries[0].Truncated {
		t.Fatalf("entry is not truncated")
	}
}

func TestParseSessionLinesEntryTruncationIsItsOwnText(t *testing.T) {
	// The command alone is under the argument cap, but the entry text
	// ("bash " plus the JSON arguments) is over it: the block stays whole
	// while the entry keeps its own truncated flag.
	command := strings.Repeat("r", ToolArgsCap-10)
	text := linesText(t, []any{
		messageLine(t, ts, map[string]any{"role": "assistant", "content": []any{
			toolCall("bash", map[string]any{"command": command}, "b1"),
		}}),
	})
	entries, _ := ParseSessionLines(text, 0)
	block := codeAt(t, entries, 0)

	if block.Text != command {
		t.Fatalf("block text length = %d, want %d", textLen(block.Text), textLen(command))
	}
	if !entries[0].Truncated {
		t.Fatalf("entry is not truncated")
	}
	if !strings.HasSuffix(entries[0].Text, truncationNote) {
		t.Fatalf("entry text does not end with the note")
	}
}

func TestParseSessionLinesEntryWithoutCodeEncodesAsBefore(t *testing.T) {
	text := linesText(t, []any{userMsg("hello", ts)})
	entries, _ := ParseSessionLines(text, 0)
	if len(entries) != 1 {
		t.Fatalf("entries = %d, want 1", len(entries))
	}
	want := `{"line":1,"ts":"` + ts + `","kind":"user","text":"hello","collapsed":true,"truncated":false,"tool":null,"isError":false}`
	if got := mustJSON(t, entries[0]); got != want {
		t.Fatalf("entry JSON = %s, want %s", got, want)
	}

	withCode := linesText(t, []any{
		messageLine(t, ts, map[string]any{"role": "assistant", "content": []any{
			toolCall("bash", map[string]any{"command": "ls"}, "b1"),
		}}),
	})
	coded, _ := ParseSessionLines(withCode, 0)
	if !strings.Contains(mustJSON(t, coded[0]), `"code":{"kind":"command","path":null,"text":"ls"}`) {
		t.Fatalf("entry with a block encodes no code: %s", mustJSON(t, coded[0]))
	}
}
