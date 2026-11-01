package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"vault-search/internal/search"
)

// fixtureVault builds a small vault in a temp directory. The notes are
// written here so the tests never depend on files another task owns.
func fixtureVault(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	notes := map[string]string{
		"decisions/decision-zebra-token.md": `---
type: decision
repo: github.com/acme/app
status: active
---

# Zebra token budget

The zebrawordtoken budget is one hundred.
`,
		"decisions/decision-retired-token.md": `---
type: decision
repo: github.com/acme/app
status: superseded
---

# Retired token rule

The retiredtoken rule is gone.
`,
		"decisions/decision-other-repo-token.md": `---
type: decision
repo: github.com/acme/other
status: active
---

# Other repo token rule

The otherrepotoken rule applies elsewhere.
`,
		"decisions/decision-shared-one.md": `---
type: decision
repo: github.com/acme/app
status: active
---

# Shared first

The sharedtoken appears here.
`,
		"lessons/lesson-shared-two.md": `---
type: lesson
repo: github.com/acme/app
status: active
---

# Shared second

The sharedtoken appears here too.
`,
		"findings/finding-global-token.md": `---
type: finding
repo: -
status: open
---

# Global finding

The globaltoken applies everywhere.
`,
		"work/20260101-0000-demo/report.md": `# Report

The workfiletoken is inside work.
`,
	}
	for rel, content := range notes {
		path := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", rel, err)
		}
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatalf("write %s: %v", rel, err)
		}
	}
	return root
}

// runCLI runs the command with separate buffers for stdout and stderr.
func runCLI(t *testing.T, args ...string) (int, string, string) {
	t.Helper()
	var stdout, stderr bytes.Buffer
	code := run(args, &stdout, &stderr)
	return code, stdout.String(), stderr.String()
}

func decodeHits(t *testing.T, raw string) []search.Hit {
	t.Helper()
	var hits []search.Hit
	if err := json.Unmarshal([]byte(raw), &hits); err != nil {
		t.Fatalf("unmarshal %q: %v", raw, err)
	}
	return hits
}

func hasBasename(hits []search.Hit, basename string) bool {
	for _, hit := range hits {
		if hit.Basename == basename {
			return true
		}
	}
	return false
}

func TestTextOutput(t *testing.T) {
	vault := fixtureVault(t)
	code, stdout, stderr := runCLI(t, "--vault", vault, "--repo", "github.com/acme/app", "zebrawordtoken")
	if code != 0 {
		t.Fatalf("exit %d, stderr %q", code, stderr)
	}
	lines := strings.Split(strings.TrimSuffix(stdout, "\n"), "\n")
	if len(lines) < 2 {
		t.Fatalf("expected a header and a snippet, got %q", stdout)
	}
	fields := strings.Split(lines[0], " | ")
	if len(fields) != 5 {
		t.Fatalf("header has %d fields: %q", len(fields), lines[0])
	}
	want := []string{"decision-zebra-token", "decision", "github.com/acme/app", "active"}
	for i, value := range want {
		if fields[i] != value {
			t.Fatalf("header field %d = %q, want %q", i, fields[i], value)
		}
	}
	if !strings.Contains(fields[4], ".") || len(strings.Split(fields[4], ".")[1]) != 3 {
		t.Fatalf("score %q is not printed with 3 decimals", fields[4])
	}
	for _, line := range lines[1:] {
		if !strings.HasPrefix(line, "  ") {
			t.Fatalf("snippet line %q is not indented by two spaces", line)
		}
	}
}

func TestJSONOutput(t *testing.T) {
	vault := fixtureVault(t)
	code, stdout, stderr := runCLI(t, "--vault", vault, "--repo", "github.com/acme/app", "--json", "zebrawordtoken")
	if code != 0 {
		t.Fatalf("exit %d, stderr %q", code, stderr)
	}
	if !strings.HasPrefix(stdout, "[\n  {") {
		t.Fatalf("JSON is not indented with two spaces: %q", stdout)
	}
	if !strings.HasSuffix(stdout, "}\n]\n") {
		t.Fatalf("JSON does not end with one newline: %q", stdout)
	}
	hits := decodeHits(t, stdout)
	if len(hits) != 1 || hits[0].Basename != "decision-zebra-token" {
		t.Fatalf("hits = %+v", hits)
	}
	if hits[0].Path != "decisions/decision-zebra-token.md" {
		t.Fatalf("path = %q", hits[0].Path)
	}
}

func TestAllWidensRepoScope(t *testing.T) {
	vault := fixtureVault(t)
	code, _, stderr := runCLI(t, "--vault", vault, "--repo", "github.com/acme/app", "--json", "otherrepotoken")
	if code != 0 {
		t.Fatalf("exit %d, stderr %q", code, stderr)
	}
	if hits := decodeHits(t, stdoutOf(t, vault, "otherrepotoken")); len(hits) != 0 {
		t.Fatalf("other repo note found without --all: %+v", hits)
	}
	code, stdout, stderr := runCLI(t, "--vault", vault, "--repo", "github.com/acme/app", "--all", "--json", "otherrepotoken")
	if code != 0 {
		t.Fatalf("exit %d, stderr %q", code, stderr)
	}
	hits := decodeHits(t, stdout)
	if len(hits) != 1 || hits[0].Basename != "decision-other-repo-token" {
		t.Fatalf("--all hits = %+v", hits)
	}
}

// stdoutOf runs one JSON search and returns stdout, failing on a non-zero exit.
func stdoutOf(t *testing.T, vault, query string) string {
	t.Helper()
	code, stdout, stderr := runCLI(t, "--vault", vault, "--repo", "github.com/acme/app", "--json", query)
	if code != 0 {
		t.Fatalf("exit %d, stderr %q", code, stderr)
	}
	return stdout
}

func TestStatusAnyIncludesRetired(t *testing.T) {
	vault := fixtureVault(t)
	if hits := decodeHits(t, stdoutOf(t, vault, "retiredtoken")); len(hits) != 0 {
		t.Fatalf("retired note found without --status any: %+v", hits)
	}
	code, stdout, stderr := runCLI(t, "--vault", vault, "--repo", "github.com/acme/app", "--status", "any", "--json", "retiredtoken")
	if code != 0 {
		t.Fatalf("exit %d, stderr %q", code, stderr)
	}
	hits := decodeHits(t, stdout)
	if len(hits) != 1 || hits[0].Basename != "decision-retired-token" || hits[0].Status != "superseded" {
		t.Fatalf("--status any hits = %+v", hits)
	}
}

func TestIncludeWork(t *testing.T) {
	vault := fixtureVault(t)
	if hits := decodeHits(t, stdoutOf(t, vault, "workfiletoken")); len(hits) != 0 {
		t.Fatalf("work file found without --include-work: %+v", hits)
	}
	code, stdout, stderr := runCLI(t, "--vault", vault, "--repo", "github.com/acme/app", "--include-work", "--json", "workfiletoken")
	if code != 0 {
		t.Fatalf("exit %d, stderr %q", code, stderr)
	}
	hits := decodeHits(t, stdout)
	if len(hits) != 1 || hits[0].Type != "work" || hits[0].Repo != "-" {
		t.Fatalf("--include-work hits = %+v", hits)
	}
	if hits[0].Basename != "work/20260101-0000-demo/report.md" {
		t.Fatalf("work basename = %q", hits[0].Basename)
	}
}

func TestLimit(t *testing.T) {
	vault := fixtureVault(t)
	code, stdout, stderr := runCLI(t, "--vault", vault, "--repo", "github.com/acme/app", "--limit", "1", "sharedtoken")
	if code != 0 {
		t.Fatalf("exit %d, stderr %q", code, stderr)
	}
	if lines := strings.Split(strings.TrimSuffix(stdout, "\n"), "\n"); len(lines) != 2 {
		t.Fatalf("--limit 1 printed %d lines: %q", len(lines), stdout)
	}
	code, stdout, stderr = runCLI(t, "--vault", vault, "--repo", "github.com/acme/app", "--json", "sharedtoken")
	if code != 0 {
		t.Fatalf("exit %d, stderr %q", code, stderr)
	}
	if hits := decodeHits(t, stdout); len(hits) != 2 {
		t.Fatalf("default limit returned %d hits, want 2", len(hits))
	}
}

func TestVersion(t *testing.T) {
	code, stdout, stderr := runCLI(t, "--version")
	if code != 0 {
		t.Fatalf("exit %d, stderr %q", code, stderr)
	}
	if stdout != "vault-search 0.1.0\n" {
		t.Fatalf("version output = %q", stdout)
	}
}

func TestIndexIsNotBuilt(t *testing.T) {
	code, stdout, stderr := runCLI(t, "--vault", fixtureVault(t), "--index", "token")
	if code != 2 {
		t.Fatalf("exit %d, want 2", code)
	}
	if stdout != "" {
		t.Fatalf("stdout = %q, want empty", stdout)
	}
	if !strings.Contains(stderr, "--index is not built yet") {
		t.Fatalf("stderr = %q", stderr)
	}
}

func TestUsageErrors(t *testing.T) {
	vault := fixtureVault(t)
	cases := []struct {
		name string
		args []string
		want string
	}{
		{"missing vault", []string{"token"}, "--vault is required"},
		{"empty query", []string{"--vault", vault}, "a query is required"},
		{"limit zero", []string{"--vault", vault, "--limit", "0", "token"}, "--limit must be at least 1"},
		{"bad status", []string{"--vault", vault, "--status", "done", "token"}, "--status must be active or any"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			code, stdout, stderr := runCLI(t, test.args...)
			if code != 2 {
				t.Fatalf("exit %d, want 2", code)
			}
			if stdout != "" {
				t.Fatalf("stdout = %q, want empty", stdout)
			}
			if !strings.Contains(stderr, test.want) {
				t.Fatalf("stderr = %q, want %q", stderr, test.want)
			}
		})
	}
}

func TestQueryAfterDoubleDash(t *testing.T) {
	vault := fixtureVault(t)
	code, stdout, stderr := runCLI(t, "--vault", vault, "--repo", "github.com/acme/app", "--json", "--", "zebrawordtoken")
	if code != 0 {
		t.Fatalf("exit %d, stderr %q", code, stderr)
	}
	hits := decodeHits(t, stdout)
	if len(hits) != 1 || hits[0].Basename != "decision-zebra-token" {
		t.Fatalf("hits = %+v", hits)
	}
}

func TestNoHits(t *testing.T) {
	vault := fixtureVault(t)
	code, stdout, stderr := runCLI(t, "--vault", vault, "--repo", "github.com/acme/app", "zzzznomatch")
	if code != 0 {
		t.Fatalf("exit %d, stderr %q", code, stderr)
	}
	if stdout != "" {
		t.Fatalf("text output = %q, want empty", stdout)
	}
	code, stdout, stderr = runCLI(t, "--vault", vault, "--repo", "github.com/acme/app", "--json", "zzzznomatch")
	if code != 0 {
		t.Fatalf("exit %d, stderr %q", code, stderr)
	}
	if stdout != "[]\n" {
		t.Fatalf("JSON output = %q, want []", stdout)
	}
}
