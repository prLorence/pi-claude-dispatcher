// Package sessions is the Go port of monitor/src/server/sessions.ts: it turns a
// Pi session transcript into the entries the monitor shows and summarises a
// session for the lanes. The TypeScript is the oracle; every rule here mirrors
// it, including the two JavaScript behaviours that are easy to miss: tool-call
// arguments are re-encoded the way JSON.stringify writes them (source key
// order, no HTML escaping, JavaScript number formatting) and the caps count
// UTF-16 code units, not bytes or runes.
package sessions

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"

	"pi-monitor/internal/fsx"
	"pi-monitor/internal/model"
)

// ToolResultCap and ToolArgsCap are the character caps of the transcript.
const (
	ToolResultCap = 2000
	ToolArgsCap   = 8000
)

const truncationNote = "… [truncated]"

var pathKeys = []string{"path", "file_path", "filePath", "file"}

// SessionSummary is the summary of one session file. The fields mirror the
// TypeScript interface, including a null pointer for every null value.
type SessionSummary struct {
	Exists     bool     `json:"exists"`
	Ended      bool     `json:"ended"`
	StopReason *string  `json:"stopReason"`
	StartedAt  *string  `json:"startedAt"`
	LastTs     *string  `json:"lastTs"`
	MtimeMs    float64  `json:"mtimeMs"`
	LastTool   *string  `json:"lastTool"`
	Tokens     *float64 `json:"tokens"`
	Cost       *float64 `json:"cost"`
	LastText   *string  `json:"lastText"`
	Model      *string  `json:"model"`
	Thinking   *string  `json:"thinking"`
	Error      *string  `json:"error"`
}

// SessionFile is one session file found for a plan.
type SessionFile struct {
	ID   string `json:"id"`
	File string `json:"file"`
}

// obj is one decoded JSON object with its values kept as raw JSON, so the
// source key order survives for the tool-call arguments.
type obj map[string]json.RawMessage

// completeLines returns the complete lines of text. The text after the final
// newline is a line still being written, so it is not returned.
func completeLines(text string) []string {
	parts := strings.Split(text, "\n")
	if len(parts) == 0 {
		return []string{}
	}
	return parts[:len(parts)-1]
}

func parseObject(raw string) (obj, bool) {
	if strings.TrimSpace(raw) == "" {
		return nil, false
	}
	var value obj
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		return nil, false
	}
	if value == nil {
		return nil, false
	}
	return value, true
}

func asObject(raw json.RawMessage) (obj, bool) {
	if len(raw) == 0 {
		return nil, false
	}
	var value obj
	if err := json.Unmarshal(raw, &value); err != nil || value == nil {
		return nil, false
	}
	return value, true
}

func asArray(raw json.RawMessage) ([]json.RawMessage, bool) {
	if len(raw) == 0 {
		return nil, false
	}
	var value []json.RawMessage
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, false
	}
	return value, true
}

func stringField(value obj, key string) (string, bool) {
	raw, ok := value[key]
	if !ok {
		return "", false
	}
	var text string
	if err := json.Unmarshal(raw, &text); err != nil {
		return "", false
	}
	return text, true
}

func textParts(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return ""
	}
	if trimmed[0] == '"' {
		var text string
		if err := json.Unmarshal(trimmed, &text); err != nil {
			return ""
		}
		return text
	}
	parts, ok := asArray(trimmed)
	if !ok {
		return ""
	}
	builder := strings.Builder{}
	for _, part := range parts {
		value, ok := asObject(part)
		if !ok {
			continue
		}
		kind, _ := stringField(value, "type")
		text, hasText := stringField(value, "text")
		if kind == "text" && hasText {
			builder.WriteString(text)
		}
	}
	return builder.String()
}

// textLen is the length of text in UTF-16 code units, which is what
// JavaScript's String.prototype.length counts.
func textLen(text string) int {
	return len(utf16.Encode([]rune(text)))
}

// cutUnits returns the first limit UTF-16 code units of text. A cut through a
// surrogate pair leaves an unpaired half, as the TypeScript slice does; Go
// cannot hold an unpaired surrogate in a string, so that half becomes the
// replacement character while the cut position and the code-unit count match.
func cutUnits(text string, limit int) string {
	units := utf16.Encode([]rune(text))
	if len(units) <= limit {
		return text
	}
	return string(utf16.Decode(units[:limit]))
}

func capText(text string, limit int) (string, bool) {
	if textLen(text) <= limit {
		return text, false
	}
	return cutUnits(text, limit) + truncationNote, true
}

func timestampOf(value obj) *string {
	ts, ok := stringField(value, "timestamp")
	if !ok {
		return nil
	}
	return &ts
}

func entry(line int, ts *string, kind model.EntryKind, text string) model.Entry {
	return model.Entry{
		Line:      line,
		Ts:        ts,
		Kind:      kind,
		Text:      text,
		Collapsed: false,
		Truncated: false,
		Tool:      nil,
		IsError:   false,
	}
}

func messageEntries(value obj, line int, ts *string) []model.Entry {
	rawMessage, ok := value["message"]
	if !ok {
		return []model.Entry{}
	}
	msg, ok := asObject(rawMessage)
	if !ok {
		return []model.Entry{}
	}
	role, _ := stringField(msg, "role")

	if role == "system" {
		return []model.Entry{entry(line, ts, "note", "System prompt hidden")}
	}

	if role == "user" {
		content := entry(line, ts, "user", textParts(msg["content"]))
		content.Collapsed = true
		return []model.Entry{content}
	}

	if role == "assistant" {
		parts, ok := asArray(msg["content"])
		if !ok {
			return []model.Entry{}
		}
		entries := make([]model.Entry, 0, len(parts))
		for _, part := range parts {
			typed, ok := asObject(part)
			if !ok {
				continue
			}
			kind, _ := stringField(typed, "type")
			switch kind {
			case "text":
				if text, ok := stringField(typed, "text"); ok {
					entries = append(entries, entry(line, ts, "assistant", text))
				}
			case "thinking":
				if text, ok := stringField(typed, "thinking"); ok {
					thinking := entry(line, ts, "thinking", text)
					thinking.Collapsed = true
					entries = append(entries, thinking)
				}
			case "toolCall":
				name, ok := stringField(typed, "name")
				if !ok {
					name = "unknown"
				}
				args := ""
				if rawArgs, present := typed["arguments"]; present {
					encoded, ok := stringifyArguments(rawArgs)
					if !ok {
						encoded = "null"
					}
					args = encoded
				}
				toolCall := entry(line, ts, "tool_call", name+" "+args)
				toolCall.Tool = &model.EntryTool{Name: name, Args: args}
				toolCall.Text, toolCall.Truncated = capText(toolCall.Text, ToolArgsCap)
				entries = append(entries, toolCall)
			}
		}
		return entries
	}

	if role == "toolResult" {
		toolName, _ := stringField(msg, "toolName")
		result := entry(line, ts, "tool_result", textParts(msg["content"]))
		result.Text, result.Truncated = capText(result.Text, ToolResultCap)
		result.Tool = &model.EntryTool{Name: toolName, Args: ""}
		if raw, ok := msg["isError"]; ok {
			result.IsError = string(bytes.TrimSpace(raw)) == "true"
		}
		return []model.Entry{result}
	}

	return []model.Entry{}
}

func lineEntries(value obj, line int) []model.Entry {
	ts := timestampOf(value)
	kind, _ := stringField(value, "type")

	switch kind {
	case "session", "session_info":
		return []model.Entry{}
	case "model_change":
		modelID, _ := stringField(value, "modelId")
		return []model.Entry{entry(line, ts, "note", "model: "+modelID)}
	case "thinking_level_change":
		level, _ := stringField(value, "thinkingLevel")
		return []model.Entry{entry(line, ts, "note", "thinking: "+level)}
	case "message":
		return messageEntries(value, line, ts)
	default:
		return []model.Entry{}
	}
}

// ParseSessionLines parses the complete lines of a transcript after the line
// number after and returns the entries plus the line number the next call
// should start after.
func ParseSessionLines(text string, after int) ([]model.Entry, int) {
	entries := make([]model.Entry, 0)
	next := after
	for index, raw := range completeLines(text) {
		line := index + 1
		if line <= after {
			continue
		}
		next = line
		value, ok := parseObject(raw)
		if !ok {
			continue
		}
		entries = append(entries, lineEntries(value, line)...)
	}
	return entries, next
}

// stringifyArguments encodes raw the way JavaScript's JSON.stringify writes it:
// object keys in source order, no escaping of "<", ">" or "&", compact
// separators and JavaScript number formatting.
func stringifyArguments(raw json.RawMessage) (string, bool) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var builder strings.Builder
	if err := writeJSValue(decoder, &builder); err != nil {
		return "", false
	}
	if _, err := decoder.Token(); err != io.EOF {
		return "", false
	}
	return builder.String(), true
}

func writeJSValue(decoder *json.Decoder, builder *strings.Builder) error {
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	return writeJSToken(decoder, builder, token)
}

func writeJSToken(decoder *json.Decoder, builder *strings.Builder, token json.Token) error {
	switch value := token.(type) {
	case json.Delim:
		switch value {
		case '{':
			builder.WriteByte('{')
			first := true
			for decoder.More() {
				if !first {
					builder.WriteByte(',')
				}
				first = false
				keyToken, err := decoder.Token()
				if err != nil {
					return err
				}
				key, ok := keyToken.(string)
				if !ok {
					return fmt.Errorf("object key is %T", keyToken)
				}
				writeJSString(builder, key)
				builder.WriteByte(':')
				if err := writeJSValue(decoder, builder); err != nil {
					return err
				}
			}
			end, err := decoder.Token()
			if err != nil {
				return err
			}
			if end != json.Delim('}') {
				return fmt.Errorf("object does not close: %v", end)
			}
			builder.WriteByte('}')
		case '[':
			builder.WriteByte('[')
			first := true
			for decoder.More() {
				if !first {
					builder.WriteByte(',')
				}
				first = false
				if err := writeJSValue(decoder, builder); err != nil {
					return err
				}
			}
			end, err := decoder.Token()
			if err != nil {
				return err
			}
			if end != json.Delim(']') {
				return fmt.Errorf("array does not close: %v", end)
			}
			builder.WriteByte(']')
		default:
			return fmt.Errorf("unexpected delimiter %v", value)
		}
	case string:
		writeJSString(builder, value)
	case json.Number:
		number, err := strconv.ParseFloat(string(value), 64)
		if err != nil && !errors.Is(err, strconv.ErrRange) {
			return err
		}
		builder.WriteString(jsNumber(number))
	case bool:
		if value {
			builder.WriteString("true")
		} else {
			builder.WriteString("false")
		}
	case nil:
		builder.WriteString("null")
	default:
		return fmt.Errorf("unexpected token %T", token)
	}
	return nil
}

func writeJSString(builder *strings.Builder, text string) {
	builder.WriteByte('"')
	for _, r := range text {
		switch r {
		case '"':
			builder.WriteString(`\"`)
		case '\\':
			builder.WriteString(`\\`)
		case '\b':
			builder.WriteString(`\b`)
		case '\t':
			builder.WriteString(`\t`)
		case '\n':
			builder.WriteString(`\n`)
		case '\f':
			builder.WriteString(`\f`)
		case '\r':
			builder.WriteString(`\r`)
		default:
			switch {
			case r < 0x20:
				fmt.Fprintf(builder, `\u%04x`, r)
			case r >= 0xD800 && r <= 0xDFFF:
				fmt.Fprintf(builder, `\u%04x`, r)
			default:
				builder.WriteRune(r)
			}
		}
	}
	builder.WriteByte('"')
}

// jsNumber formats a number the way JavaScript's Number::toString does, which
// is what JSON.stringify writes for a number value.
func jsNumber(value float64) string {
	if value != value || value > 1.7976931348623157e308 || value < -1.7976931348623157e308 {
		return "null"
	}
	if value == 0 {
		return "0"
	}
	negative := value < 0
	if negative {
		value = -value
	}
	formatted := strconv.FormatFloat(value, 'e', -1, 64)
	mantissa, exponentText, _ := strings.Cut(formatted, "e")
	exponent, _ := strconv.Atoi(exponentText)
	digits := strings.Replace(mantissa, ".", "", 1)
	k := len(digits)
	n := exponent + 1

	var out string
	switch {
	case k <= n && n <= 21:
		out = digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		out = digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		out = "0." + strings.Repeat("0", -n) + digits
	default:
		e := n - 1
		sign := "+"
		if e < 0 {
			sign = "-"
			e = -e
		}
		if k == 1 {
			out = digits + "e" + sign + strconv.Itoa(e)
		} else {
			out = digits[:1] + "." + digits[1:] + "e" + sign + strconv.Itoa(e)
		}
	}
	if negative {
		return "-" + out
	}
	return out
}

func emptySummary() SessionSummary {
	return SessionSummary{}
}

func firstPath(args obj) *string {
	for _, key := range pathKeys {
		value, ok := stringField(args, key)
		if ok && value != "" {
			return &value
		}
	}
	return nil
}

// jsBasename is Node's path.basename for the POSIX paths the sessions use.
func jsBasename(path string) string {
	if path == "" {
		return ""
	}
	for len(path) > 1 && strings.HasSuffix(path, "/") {
		path = path[:len(path)-1]
	}
	if path == "/" {
		return ""
	}
	index := strings.LastIndexByte(path, '/')
	return path[index+1:]
}

func formatTool(name string, args json.RawMessage) string {
	record, ok := asObject(args)
	if !ok {
		return name
	}
	if name == "read" || name == "edit" || name == "write" {
		target := firstPath(record)
		if target != nil {
			return name + " " + jsBasename(*target)
		}
		return name
	}
	if name == "bash" {
		command, _ := stringField(record, "command")
		if command == "" {
			return name
		}
		return "bash " + cutUnits(command, 60)
	}
	return name
}

func usageNumbers(message obj) (tokens *float64, cost *float64) {
	usage, ok := asObject(message["usage"])
	if !ok {
		return nil, nil
	}
	input := float64(0)
	if value, ok := numberField(usage, "input"); ok {
		input = value
	}
	output := float64(0)
	if value, ok := numberField(usage, "output"); ok {
		output = value
	}
	total := input + output
	tokens = &total
	if costRecord, ok := asObject(usage["cost"]); ok {
		if value, ok := numberField(costRecord, "total"); ok {
			cost = &value
		}
	}
	return tokens, cost
}

func numberField(value obj, key string) (float64, bool) {
	raw, ok := value[key]
	if !ok {
		return 0, false
	}
	var number float64
	if err := json.Unmarshal(raw, &number); err != nil {
		return 0, false
	}
	return number, true
}

// SummarizeSession summarises one session file. An empty file name is the
// TypeScript null: a session that has no file.
func SummarizeSession(file string) SessionSummary {
	summary := emptySummary()
	if file == "" {
		return summary
	}

	info, err := os.Stat(file)
	if err != nil {
		return summary
	}
	mtimeMs := float64(info.ModTime().UnixNano()) / 1e6

	data, err := os.ReadFile(file)
	if err != nil {
		summary.Exists = true
		message := "unreadable session"
		summary.Error = &message
		return summary
	}

	summary.Exists = true
	summary.MtimeMs = mtimeMs

	var lastAssistant obj
	var lastMessageRole *string
	var tokens *float64
	var cost *float64

	for _, raw := range completeLines(string(data)) {
		value, ok := parseObject(raw)
		if !ok {
			continue
		}
		if ts := timestampOf(value); ts != nil {
			if summary.StartedAt == nil {
				summary.StartedAt = ts
			}
			summary.LastTs = ts
		}

		kind, _ := stringField(value, "type")
		if kind == "model_change" {
			if modelID, ok := stringField(value, "modelId"); ok {
				summary.Model = &modelID
				continue
			}
		}
		if kind == "thinking_level_change" {
			if level, ok := stringField(value, "thinkingLevel"); ok {
				summary.Thinking = &level
				continue
			}
		}
		if kind != "message" {
			continue
		}

		msg, ok := asObject(value["message"])
		if !ok {
			continue
		}
		role, hasRole := stringField(msg, "role")
		if hasRole {
			lastMessageRole = &role
		} else {
			lastMessageRole = nil
		}
		if role != "assistant" {
			continue
		}

		lastAssistant = msg
		messageTokens, messageCost := usageNumbers(msg)
		if messageTokens != nil {
			total := *messageTokens
			if tokens != nil {
				total += *tokens
			}
			tokens = &total
		}
		if messageCost != nil {
			total := *messageCost
			if cost != nil {
				total += *cost
			}
			cost = &total
		}

		if parts, ok := asArray(msg["content"]); ok {
			for _, part := range parts {
				typed, ok := asObject(part)
				if !ok {
					continue
				}
				partKind, _ := stringField(typed, "type")
				name, hasName := stringField(typed, "name")
				if partKind == "toolCall" && hasName {
					lastTool := formatTool(name, typed["arguments"])
					summary.LastTool = &lastTool
				}
			}
			if text := textParts(msg["content"]); text != "" {
				summary.LastText = &text
			}
		}
	}

	if lastAssistant != nil {
		if stopReason, ok := stringField(lastAssistant, "stopReason"); ok {
			summary.StopReason = &stopReason
		}
	}
	summary.Ended = lastMessageRole != nil &&
		*lastMessageRole == "assistant" &&
		summary.StopReason != nil &&
		*summary.StopReason != "" &&
		*summary.StopReason != "toolUse"
	summary.Tokens = tokens
	summary.Cost = cost
	if summary.StopReason != nil && *summary.StopReason == "error" && lastAssistant != nil {
		if errorMessage, ok := stringField(lastAssistant, "errorMessage"); ok {
			summary.Error = &errorMessage
		}
	}

	return summary
}

func sessionIDFromName(name string) *string {
	const suffix = ".jsonl"
	if !strings.HasSuffix(name, suffix) {
		return nil
	}
	base := name[:len(name)-len(suffix)]
	underscore := strings.IndexByte(base, '_')
	if underscore == -1 {
		return nil
	}
	id := base[underscore+1:]
	if id == "" {
		return nil
	}
	return &id
}

// ListSessionFiles lists the session files of a plan. A file whose real path
// leaves the plans folder is not listed, a step beyond the TypeScript, which
// follows symlinks (spec R10).
func ListSessionFiles(plansDir, planID string) []SessionFile {
	files := make([]SessionFile, 0)
	folder, ok := fsx.ResolveInside(plansDir, "sessions", planID)
	if !ok {
		return files
	}

	entries, err := os.ReadDir(folder)
	if err != nil {
		return files
	}
	names := make([]string, 0, len(entries))
	for _, item := range entries {
		names = append(names, item.Name())
	}
	sort.Strings(names)

	for _, name := range names {
		id := sessionIDFromName(name)
		if id == nil {
			continue
		}
		file, ok := fsx.ResolveInside(folder, name)
		if !ok {
			continue
		}
		info, err := os.Stat(file)
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		if !fsx.RealInside(plansDir, file) {
			continue
		}
		files = append(files, SessionFile{ID: *id, File: file})
	}
	return files
}

// FindSessionFile returns the file of the last session with the given id, as
// the TypeScript does, or false when there is none.
func FindSessionFile(plansDir, planID, sessionID string) (string, bool) {
	found := ""
	ok := false
	for _, item := range ListSessionFiles(plansDir, planID) {
		if item.ID == sessionID {
			found = item.File
			ok = true
		}
	}
	return found, ok
}
