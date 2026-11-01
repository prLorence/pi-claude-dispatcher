package search

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strings"
	"testing"
	"time"
)

func fixtureVault(t *testing.T) string {
	t.Helper()
	path, err := filepath.Abs(filepath.Join("..", "..", "testdata", "vault"))
	if err != nil {
		t.Fatalf("fixture path: %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("fixture vault missing: %v", err)
	}
	return path
}

func runSearch(t *testing.T, opts Options, query string) []Hit {
	t.Helper()
	hits, err := Run(opts, query)
	if err != nil {
		t.Fatalf("Run(%q) failed: %v", query, err)
	}
	return hits
}

func basenames(hits []Hit) []string {
	out := make([]string, 0, len(hits))
	for _, hit := range hits {
		out = append(out, hit.Basename)
	}
	return out
}

func hasBasename(hits []Hit, basename string) bool {
	for _, hit := range hits {
		if hit.Basename == basename {
			return true
		}
	}
	return false
}

func indexOf(hits []Hit, basename string) int {
	for index, hit := range hits {
		if hit.Basename == basename {
			return index
		}
	}
	return -1
}

func copyDir(t *testing.T, src, dst string) {
	t.Helper()
	err := filepath.WalkDir(src, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if entry.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, data, 0o644)
	})
	if err != nil {
		t.Fatalf("copy fixture: %v", err)
	}
}

type snapshotEntry struct {
	path    string
	size    int64
	modTime time.Time
}

func snapshot(t *testing.T, root string) []snapshotEntry {
	t.Helper()
	entries := make([]snapshotEntry, 0, 32)
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		if entry.IsDir() {
			entries = append(entries, snapshotEntry{path: rel})
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		entries = append(entries, snapshotEntry{path: rel, size: info.Size(), modTime: info.ModTime()})
		return nil
	})
	if err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].path < entries[j].path })
	return entries
}

func TestTokenize(t *testing.T) {
	cases := []struct {
		name  string
		input string
		want  []string
	}{
		{"plain", "Hello, WORLD!", []string{"hello", "world"}},
		{"punctuation", "a.b-c_d/e", []string{"a", "b", "c", "d", "e"}},
		{"numbers", "Go 1.22 is ready", []string{"go", "1", "22", "is", "ready"}},
		{"unicode", "Naïve café 42", []string{"naïve", "café", "42"}},
		{"empty", "  ---  ", []string{}},
		{"mixed", "vault-lock_fingerprint", []string{"vault", "lock", "fingerprint"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := Tokenize(tc.input)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("Tokenize(%q) = %#v, want %#v", tc.input, got, tc.want)
			}
		})
	}
}

func TestIsActive(t *testing.T) {
	for _, status := range []string{"", "active", "open", "done"} {
		if !IsActive(status) {
			t.Fatalf("IsActive(%q) = false, want true", status)
		}
	}
	for _, status := range []string{"closed", "superseded", "stale", "dropped"} {
		if IsActive(status) {
			t.Fatalf("IsActive(%q) = true, want false", status)
		}
	}
}

func TestScopeRepoAndGlobal(t *testing.T) {
	vault := fixtureVault(t)
	hits := runSearch(t, Options{Vault: vault, Repo: "github.com/acme/app", Limit: 50}, "vault")

	for _, want := range []string{
		"decision-acme-app-adopt-bm25",
		"lesson-acme-app-vault-lock",
		"finding-open-lock",
		"spec-vault-search",
		"idea-go-search",
		"plan-vault-search-r1",
		"run-vault-search-r1",
	} {
		if !hasBasename(hits, want) {
			t.Fatalf("repo scope misses %q in %v", want, basenames(hits))
		}
	}
	for _, unwanted := range []string{
		"decision-acme-other-deploy-days",
		"lesson-acme-app-read-first",
		"finding-closed-old",
	} {
		if hasBasename(hits, unwanted) {
			t.Fatalf("repo scope leaked %q in %v", unwanted, basenames(hits))
		}
	}
}

func TestScopeAll(t *testing.T) {
	vault := fixtureVault(t)
	hits := runSearch(t, Options{Vault: vault, Repo: "github.com/acme/app", All: true, Limit: 50}, "vault")
	if !hasBasename(hits, "decision-acme-other-deploy-days") {
		t.Fatalf("--all misses the other repo: %v", basenames(hits))
	}
}

func TestScopeEmptyRepo(t *testing.T) {
	vault := fixtureVault(t)
	hits := runSearch(t, Options{Vault: vault, Limit: 50}, "vault")
	if !reflect.DeepEqual(basenames(hits), []string{"idea-go-search"}) {
		t.Fatalf("empty repo scope = %v, want only the global note", basenames(hits))
	}
}

func TestScopeProjectRepos(t *testing.T) {
	vault := fixtureVault(t)
	for _, repo := range []string{"github.com/acme/app", "github.com/acme/other"} {
		hits := runSearch(t, Options{Vault: vault, Repo: repo, Limit: 50}, "repositories")
		if !hasBasename(hits, "project-acme-app") {
			t.Fatalf("project note missing for %q: %v", repo, basenames(hits))
		}
	}
	hits := runSearch(t, Options{Vault: vault, Repo: "github.com/acme/third", Limit: 50}, "repositories")
	if len(hits) != 0 {
		t.Fatalf("project note matched a repo outside its repos list: %v", basenames(hits))
	}
	hits = runSearch(t, Options{Vault: vault, Limit: 50}, "repositories")
	if len(hits) != 0 {
		t.Fatalf("project note matched an empty repo: %v", basenames(hits))
	}
}

func TestRetiredHiddenAndShown(t *testing.T) {
	vault := fixtureVault(t)
	cases := []struct {
		query    string
		basename string
	}{
		{"checkout", "decision-acme-app-single-checkout"},
		{"read", "lesson-acme-app-read-first"},
		{"closed", "finding-closed-old"},
	}
	for _, tc := range cases {
		hidden := runSearch(t, Options{Vault: vault, Repo: "github.com/acme/app", Limit: 50}, tc.query)
		if hasBasename(hidden, tc.basename) {
			t.Fatalf("retired note %q shown without --status any", tc.basename)
		}
		shown := runSearch(t, Options{Vault: vault, Repo: "github.com/acme/app", AnyStatus: true, Limit: 50}, tc.query)
		if !hasBasename(shown, tc.basename) {
			t.Fatalf("retired note %q hidden with --status any: %v", tc.basename, basenames(shown))
		}
	}
}

func TestIncludeWorkAddsAndKeepsOrder(t *testing.T) {
	vault := fixtureVault(t)
	without := runSearch(t, Options{Vault: vault, Repo: "github.com/acme/app", Limit: 50}, "demo")
	if len(without) != 0 {
		t.Fatalf("work files searched without --include-work: %v", basenames(without))
	}

	withWork := runSearch(t, Options{Vault: vault, Repo: "github.com/acme/app", IncludeWork: true, Limit: 50}, "demo")
	if len(withWork) != 2 {
		t.Fatalf("--include-work found %d work files, want 2: %v", len(withWork), basenames(withWork))
	}
	for _, hit := range withWork {
		if hit.Type != "work" || hit.Repo != "-" || hit.Status != "-" {
			t.Fatalf("work hit metadata wrong: %+v", hit)
		}
	}
	for _, want := range []string{
		"work/20260101-0000-demo/report.md",
		"work/20260101-0000-demo/trace.jsonl",
	} {
		if !hasBasename(withWork, want) {
			t.Fatalf("--include-work misses %q: %v", want, basenames(withWork))
		}
	}

	notesBefore := notesOnly(runSearch(t, Options{Vault: vault, Repo: "github.com/acme/app", Limit: 50}, "vault"))
	notesAfter := notesOnly(runSearch(t, Options{Vault: vault, Repo: "github.com/acme/app", IncludeWork: true, Limit: 50}, "vault"))
	if !reflect.DeepEqual(notesBefore, notesAfter) {
		t.Fatalf("work files changed note order: %v vs %v", notesBefore, notesAfter)
	}
}

func notesOnly(hits []Hit) []string {
	out := make([]string, 0, len(hits))
	for _, hit := range hits {
		if hit.Type != "work" {
			out = append(out, hit.Basename)
		}
	}
	return out
}

func TestTitleAndFingerprintOutrankBody(t *testing.T) {
	vault := fixtureVault(t)
	hits := runSearch(t, Options{Vault: vault, Repo: "github.com/acme/app", Limit: 50}, "bm25")
	titleIndex := indexOf(hits, "decision-acme-app-adopt-bm25")
	bodyIndex := indexOf(hits, "decision-global-note-format")
	if titleIndex < 0 || bodyIndex < 0 {
		t.Fatalf("bm25 hits missing: %v", basenames(hits))
	}
	if titleIndex >= bodyIndex {
		t.Fatalf("title match did not outrank body-only match: %v", basenames(hits))
	}

	hits = runSearch(t, Options{Vault: vault, Repo: "github.com/acme/app", Limit: 50}, "fingerprintwd")
	fingerprintIndex := indexOf(hits, "finding-open-lock")
	bodyOnlyIndex := indexOf(hits, "lesson-global-slow-tests")
	if fingerprintIndex < 0 || bodyOnlyIndex < 0 {
		t.Fatalf("fingerprintwd hits missing: %v", basenames(hits))
	}
	if fingerprintIndex >= bodyOnlyIndex {
		t.Fatalf("fingerprint match did not outrank body-only match: %v", basenames(hits))
	}
}

func TestTiesSortByPath(t *testing.T) {
	vault := fixtureVault(t)
	hits := runSearch(t, Options{Vault: vault, Repo: "github.com/acme/app", Limit: 50}, "tiebreakwd")
	if len(hits) != 2 {
		t.Fatalf("tie query found %d hits, want 2: %v", len(hits), basenames(hits))
	}
	if hits[0].Score != hits[1].Score {
		t.Fatalf("expected a tie, scores are %v and %v", hits[0].Score, hits[1].Score)
	}
	if hits[0].Path >= hits[1].Path {
		t.Fatalf("ties are not sorted by path: %q then %q", hits[0].Path, hits[1].Path)
	}
	want := []string{"idea-tie-alpha", "idea-tie-beta"}
	if !reflect.DeepEqual(basenames(hits), want) {
		t.Fatalf("tie order = %v, want %v", basenames(hits), want)
	}
}

func TestMaxFileBytesSkips(t *testing.T) {
	root := filepath.Join(t.TempDir(), "vault")
	copyDir(t, fixtureVault(t), root)

	body := "# Oversized\n\nbigonlywd " + strings.Repeat("pad ", 400)
	content := "---\ntype: decision\nrepo: github.com/acme/app\n---\n" + body + "\n"
	oversized := filepath.Join(root, "decisions", "oversized.md")
	if err := os.WriteFile(oversized, []byte(content), 0o644); err != nil {
		t.Fatalf("write oversized note: %v", err)
	}

	under := runSearch(t, Options{Vault: root, Repo: "github.com/acme/app", MaxFileBytes: int64(len(content)) + 1}, "bigonlywd")
	if len(under) != 1 {
		t.Fatalf("large file not read under the cap: %v", basenames(under))
	}

	over := runSearch(t, Options{Vault: root, Repo: "github.com/acme/app", MaxFileBytes: int64(len(content)) - 1}, "bigonlywd")
	if len(over) != 0 {
		t.Fatalf("file over MaxFileBytes was read: %v", basenames(over))
	}
}

func TestSymlinkNotRead(t *testing.T) {
	root := filepath.Join(t.TempDir(), "vault")
	copyDir(t, fixtureVault(t), root)

	outside := filepath.Join(t.TempDir(), "outside.md")
	content := "---\ntype: decision\nrepo: github.com/acme/app\n---\n\n# Outside\n\nsymlinkwd lives outside the vault.\n"
	if err := os.WriteFile(outside, []byte(content), 0o644); err != nil {
		t.Fatalf("write outside note: %v", err)
	}
	link := filepath.Join(root, "decisions", "symlink-leak.md")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("OS refused to create a symlink: %v", err)
	}

	hits := runSearch(t, Options{Vault: root, Repo: "github.com/acme/app", Limit: 50}, "symlinkwd")
	if len(hits) != 0 {
		t.Fatalf("symlink target outside the vault was read: %v", basenames(hits))
	}
}

func TestNoQueryTokens(t *testing.T) {
	vault := fixtureVault(t)
	for _, query := range []string{"", "   ", "--- !!!"} {
		if _, err := Run(Options{Vault: vault}, query); err == nil {
			t.Fatalf("Run(%q) returned no error", query)
		}
	}
	if _, err := Run(Options{}, "vault"); err == nil {
		t.Fatal("Run without a vault returned no error")
	}
}

func TestReadOnly(t *testing.T) {
	root := filepath.Join(t.TempDir(), "vault")
	copyDir(t, fixtureVault(t), root)

	t.Cleanup(func() {
		_ = filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if entry.IsDir() {
				return os.Chmod(path, 0o755)
			}
			return os.Chmod(path, 0o644)
		})
	})

	dirs := make([]string, 0, 16)
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			dirs = append(dirs, path)
			return nil
		}
		return os.Chmod(path, 0o444)
	})
	if err != nil {
		t.Fatalf("make files read-only: %v", err)
	}
	for index := len(dirs) - 1; index >= 0; index-- {
		if err := os.Chmod(dirs[index], 0o555); err != nil {
			t.Fatalf("make directory read-only: %v", err)
		}
	}

	before := snapshot(t, root)
	hits := runSearch(t, Options{Vault: root, Repo: "github.com/acme/app", IncludeWork: true, Limit: 50}, "vault")
	if len(hits) == 0 {
		t.Fatal("read-only search found no hits")
	}
	after := snapshot(t, root)
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("search changed the vault\nbefore: %#v\nafter:  %#v", before, after)
	}
}

// TestScanJobsDoesNotRetainFileText guards the retained-substring bug:
// parseFrontmatter returns substrings of the file text, so keeping repo,
// status or type in a docSummary kept every scanned note's whole text alive.
// Measured here on macOS arm64: HeapAlloc 19,664,000 bytes against
// 16,432,000 bytes written before the clone fix, 816,048 bytes after it.
func TestScanJobsDoesNotRetainFileText(t *testing.T) {
	vaultDir := t.TempDir()
	decisions := filepath.Join(vaultDir, "decisions")
	if err := os.MkdirAll(decisions, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	const noteCount = 2000
	const noteBytes = 8192
	var note strings.Builder
	// Unquoted scalars keep the parsed values as substrings of the file text.
	note.WriteString("---\ntype: decision\nstatus: active\nrepo: github.com/acme/app\n---\n\n")
	for note.Len() < noteBytes {
		note.WriteString("filler words about a decision and the reasons behind it.\n")
	}
	content := note.String()
	var totalBytes int64
	for i := 0; i < noteCount; i++ {
		name := filepath.Join(decisions, fmt.Sprintf("decision-memory-%04d.md", i))
		if err := os.WriteFile(name, []byte(content), 0o644); err != nil {
			t.Fatalf("write note %d: %v", i, err)
		}
		totalBytes += int64(len(content))
	}

	opts := Options{Vault: vaultDir, All: true, MaxFileBytes: 262144}
	docs := scanJobs(opts, collectJobs(opts), map[string]bool{"needle": true})
	if len(docs) != noteCount {
		t.Fatalf("scanned %d docs, want %d", len(docs), noteCount)
	}

	runtime.GC()
	var stats runtime.MemStats
	runtime.ReadMemStats(&stats)
	// Keep the summaries reachable across the measurement above.
	runtime.KeepAlive(docs)

	if int64(stats.HeapAlloc) >= totalBytes/2 {
		t.Fatalf("HeapAlloc %d bytes (HeapInuse %d) is not under half of the %d bytes written: the scan retains the file text", stats.HeapAlloc, stats.HeapInuse, totalBytes)
	}
	t.Logf("HeapAlloc %d bytes, HeapInuse %d bytes, written %d bytes", stats.HeapAlloc, stats.HeapInuse, totalBytes)
}

func TestRepeatedRunsIdentical(t *testing.T) {
	vault := fixtureVault(t)
	opts := Options{Vault: vault, Repo: "github.com/acme/app", IncludeWork: true, Limit: 50}
	first := runSearch(t, opts, "vault")
	for round := 0; round < 20; round++ {
		next := runSearch(t, opts, "vault")
		if !reflect.DeepEqual(first, next) {
			t.Fatalf("run %d differs\nfirst: %#v\nnext:  %#v", round, first, next)
		}
	}
}
