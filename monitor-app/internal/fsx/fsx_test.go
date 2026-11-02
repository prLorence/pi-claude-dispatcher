package fsx

import (
	"os"
	"path/filepath"
	"testing"
)

func mustWrite(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func mustMkdir(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(path, 0o700); err != nil {
		t.Fatalf("mkdir %s: %v", path, err)
	}
}

func TestResolveInsideAcceptsNestedPaths(t *testing.T) {
	base := filepath.Join(t.TempDir(), "plans")

	got, ok := ResolveInside(base, "sessions", "p1", "a.jsonl")
	if !ok {
		t.Fatalf("ResolveInside(%q, sessions, p1, a.jsonl) was rejected", base)
	}
	if want := filepath.Join(base, "sessions", "p1", "a.jsonl"); got != want {
		t.Fatalf("ResolveInside nested = %q, want %q", got, want)
	}

	got, ok = ResolveInside(base)
	if !ok || got != base {
		t.Fatalf("ResolveInside(base) = %q, %v, want %q, true", got, ok, base)
	}

	got, ok = ResolveInside(base, "a", "b")
	if !ok {
		t.Fatalf("ResolveInside(%q, a, b) was rejected", base)
	}
	if want := filepath.Join(base, "a", "b"); got != want {
		t.Fatalf("ResolveInside(%q, a, b) = %q, want %q", base, got, want)
	}
}

func TestResolveInsideRejectsTraversalAbsolutePartsAndNul(t *testing.T) {
	base := filepath.Join(t.TempDir(), "plans")

	cases := []struct {
		name  string
		parts []string
	}{
		{name: "parent segment", parts: []string{"..", "etc"}},
		{name: "nested parent segment", parts: []string{"a/../../etc"}},
		{name: "absolute part", parts: []string{"/etc/passwd"}},
		{name: "NUL byte", parts: []string{"a\x00b"}},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got, ok := ResolveInside(base, testCase.parts...); ok {
				t.Fatalf("ResolveInside(%q, %v) = %q, want rejection", base, testCase.parts, got)
			}
		})
	}

	if got, ok := ResolveInside(filepath.Join(base, "a"), "..", "ab"); ok {
		t.Fatalf("ResolveInside(base/a, .., ab) = %q, want rejection", got)
	}
}

func TestResolveInsideRejectsSiblingPrefix(t *testing.T) {
	root := t.TempDir()
	base := filepath.Join(root, "plans")
	mustWrite(t, filepath.Join(root, "plans-sibling"), "")

	if got, ok := ResolveInside(base, "../plans-sibling"); ok {
		t.Fatalf("ResolveInside(%q, ../plans-sibling) = %q, want rejection", base, got)
	}
}

func TestRealInsideFile(t *testing.T) {
	root := t.TempDir()
	base := filepath.Join(root, "plans")
	mustMkdir(t, base)
	file := filepath.Join(base, "a.jsonl")
	mustWrite(t, file, "line\n")

	if !RealInside(base, file) {
		t.Fatalf("RealInside(%q, %q) = false, want true", base, file)
	}
	if RealInside(base, filepath.Join(root, "outside.jsonl")) {
		t.Fatalf("RealInside(%q, outside file) = true, want false", base)
	}
}

func TestRealInsideSymlinkStaysInside(t *testing.T) {
	root := t.TempDir()
	base := filepath.Join(root, "plans")
	mustMkdir(t, base)
	mustWrite(t, filepath.Join(base, "real.jsonl"), "line\n")
	if err := os.Symlink("real.jsonl", filepath.Join(base, "link.jsonl")); err != nil {
		t.Fatalf("symlink inside: %v", err)
	}

	if !RealInside(base, filepath.Join(base, "link.jsonl")) {
		t.Fatalf("RealInside(%q, inside symlink) = false, want true", base)
	}
}

func TestRealInsideSymlinkOutside(t *testing.T) {
	root := t.TempDir()
	base := filepath.Join(root, "plans")
	mustMkdir(t, base)
	outside := filepath.Join(root, "outside.jsonl")
	mustWrite(t, outside, "secret\n")
	escape := filepath.Join(base, "escape.jsonl")
	if err := os.Symlink(outside, escape); err != nil {
		t.Fatalf("symlink outside: %v", err)
	}

	if RealInside(base, escape) {
		t.Fatalf("RealInside(%q, %q) = true, want false", base, escape)
	}

	// ResolveInside is a path-text check and follows no symlink, so the same
	// link is accepted there, exactly like the TypeScript.
	got, ok := ResolveInside(base, "escape.jsonl")
	if !ok || got != escape {
		t.Fatalf("ResolveInside(%q, escape.jsonl) = %q, %v, want %q, true", base, got, ok, escape)
	}
}

func TestRealInsideBaseReachedThroughSymlink(t *testing.T) {
	root := t.TempDir()
	realBase := filepath.Join(root, "real-plans")
	mustMkdir(t, realBase)
	file := filepath.Join(realBase, "a.jsonl")
	mustWrite(t, file, "line\n")

	linkBase := filepath.Join(root, "linked-plans")
	if err := os.Symlink(realBase, linkBase); err != nil {
		t.Fatalf("symlink base: %v", err)
	}

	if !RealInside(linkBase, filepath.Join(linkBase, "a.jsonl")) {
		t.Fatalf("RealInside(linked base, linked file) = false, want true")
	}
	if !RealInside(realBase, filepath.Join(linkBase, "a.jsonl")) {
		t.Fatalf("RealInside(real base, linked file) = false, want true")
	}
	if !RealInside(linkBase, filepath.Join(realBase, "a.jsonl")) {
		t.Fatalf("RealInside(linked base, real file) = false, want true")
	}
	if RealInside(realBase, filepath.Join(root, "real-plans-sibling", "a.jsonl")) {
		t.Fatalf("RealInside(real base, sibling folder) = true, want false")
	}
}

func TestRealInsideTmpSymlink(t *testing.T) {
	// On macOS /tmp is a symlink to /private/tmp, so a base built under /tmp
	// reaches its real path through a symlink. Resolving both sides keeps the
	// file inside; comparing the unresolved text would not.
	root, err := os.MkdirTemp("/tmp", "pi-monitor-fsx-")
	if err != nil {
		t.Skipf("no /tmp: %v", err)
	}
	t.Cleanup(func() { os.RemoveAll(root) })

	base := filepath.Join(root, "plans")
	mustMkdir(t, base)
	file := filepath.Join(base, "a.jsonl")
	mustWrite(t, file, "line\n")

	if !RealInside(base, file) {
		t.Fatalf("RealInside(%q, %q) = false, want true", base, file)
	}
}

func TestRealInsideMissingTarget(t *testing.T) {
	root := t.TempDir()
	base := filepath.Join(root, "plans")
	mustMkdir(t, base)

	if RealInside(base, filepath.Join(base, "missing.jsonl")) {
		t.Fatalf("RealInside(%q, missing target) = true, want false", base)
	}
	if RealInside(filepath.Join(root, "missing-base"), filepath.Join(root, "missing-base", "a.jsonl")) {
		t.Fatalf("RealInside(missing base, missing target) = true, want false")
	}
}
