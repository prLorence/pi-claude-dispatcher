package parity

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"pi-monitor/internal/repos"
	"pi-monitor/internal/service"
)

// testdataDir is the fixture root, relative to this package.
const testdataDir = "../testdata"

// requiredCases are the fixture cases the parity set must contain. The
// manifest must also hold at least minCases cases, because the port is only
// proven equal over the whole set.
const minCases = 12

var requiredCases = []string{
	"running-pair",
	"finished-pass",
	"failed-gate",
	"skipped-task",
	"stalled-lane",
	"decider-effort-audit",
	"retry-two-attempts",
	"idle-and-active",
	"missing-folder",
	"unreadable-folder",
	"over-cap",
	"transcript-edge",
}

// manifest is the fixture description written by tools/golden.ts. Git cannot
// store empty folders, folder modes or modification times, so the test rebuilds
// them from it in the same order the generator does.
type manifest struct {
	NowMs  int64            `json:"nowMs"`
	Cases  []manifestCase   `json:"cases"`
	Mtimes map[string]int64 `json:"mtimes"`
}

type manifestCase struct {
	Name     string            `json:"name"`
	Message  *string           `json:"message"`
	Repos    []manifestRepo    `json:"repos"`
	Dirs     []string          `json:"dirs"`
	Modes    map[string]int    `json:"modes"`
	State    string            `json:"state"`
	Sessions []manifestSession `json:"sessions"`
}

type manifestRepo struct {
	Name string `json:"name"`
	Dir  string `json:"dir"`
}

type manifestSession struct {
	Repo   string `json:"repo"`
	Plan   string `json:"plan"`
	ID     string `json:"id"`
	After  int    `json:"after"`
	Golden string `json:"golden"`
}

// loadManifest reads and decodes the manifest.
func loadManifest(t *testing.T) manifest {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(testdataDir, "manifest.json"))
	if err != nil {
		t.Fatalf("read manifest: %v", err)
	}
	var m manifest
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("decode manifest: %v", err)
	}
	return m
}

// TestManifestCoversTheFixtureSet fails when a case of the required set is
// missing, so a later manifest edit cannot quietly shrink the parity check.
func TestManifestCoversTheFixtureSet(t *testing.T) {
	m := loadManifest(t)
	if len(m.Cases) < minCases {
		t.Errorf("manifest has %d cases, want at least %d", len(m.Cases), minCases)
	}
	seen := make(map[string]bool, len(m.Cases))
	for _, c := range m.Cases {
		seen[c.Name] = true
	}
	for _, name := range requiredCases {
		if !seen[name] {
			t.Errorf("manifest is missing the case %q", name)
		}
	}
}

// TestGoldenParity rebuilds every fixture tree in a temporary folder, builds
// the state and the listed session pages with the fixed clock, and compares
// each result with the golden JSON.
func TestGoldenParity(t *testing.T) {
	m := loadManifest(t)
	if len(m.Cases) < minCases {
		t.Fatalf("manifest has %d cases, want at least %d", len(m.Cases), minCases)
	}
	seen := make(map[string]bool, len(m.Cases))
	for _, c := range m.Cases {
		seen[c.Name] = true
	}
	for _, name := range requiredCases {
		if !seen[name] {
			t.Fatalf("manifest is missing the case %q", name)
		}
	}

	for _, c := range m.Cases {
		c := c
		t.Run(c.Name, func(t *testing.T) {
			runCase(t, m, c)
		})
	}
}

// runCase rebuilds one case's tree and compares its state and session pages.
func runCase(t *testing.T, m manifest, c manifestCase) {
	t.Helper()

	root := t.TempDir()
	materialize(t, m, c, root)

	configs := make([]repos.RepoConfig, 0, len(c.Repos))
	for _, repo := range c.Repos {
		configs = append(configs, repos.RepoConfig{
			Name: repo.Name,
			Dir:  filepath.Join(root, filepath.FromSlash(repo.Dir)),
		})
	}
	message := c.Message
	nowMs := m.NowMs
	svc := service.New(service.Options{
		Repos: func() ([]repos.RepoConfig, *string) {
			return configs, message
		},
		Now: func() int64 {
			return nowMs
		},
	})

	compareGolden(t, c.Name, "state", c.State, svc.State())

	for index, request := range c.Sessions {
		page, err := svc.Session(request.Repo, request.Plan, request.ID, request.After)
		if err != nil {
			t.Fatalf("Session(%q, %q, %q, %d) = %v, want a page",
				request.Repo, request.Plan, request.ID, request.After, err)
		}
		label := fmt.Sprintf("session %d", index+1)
		compareGolden(t, c.Name, label, request.Golden, page)
	}
}

// materialize builds a case's tree under root: the manifest folders, a copy of
// the committed files, then the mtimes deepest path first and the modes last.
// The committed tree is only ever read.
func materialize(t *testing.T, m manifest, c manifestCase, root string) {
	t.Helper()

	for _, rel := range c.Dirs {
		abs := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(abs, 0o755); err != nil {
			t.Fatalf("create folder %s: %v", rel, err)
		}
	}

	source := filepath.Join(testdataDir, "trees", c.Name)
	err := filepath.WalkDir(source, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(testdataDir, path)
		if err != nil {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		dest := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
			return err
		}
		return os.WriteFile(dest, data, 0o644)
	})
	if err != nil {
		t.Fatalf("copy tree %s: %v", c.Name, err)
	}

	applyMtimes(t, root, m.Mtimes)
	applyModes(t, root, c.Modes)
}

// applyMtimes sets every path the manifest names, deepest path first, because
// writing a child moves its parent's mtime. Paths of other cases are skipped.
func applyMtimes(t *testing.T, root string, mtimes map[string]int64) {
	t.Helper()

	keys := make([]string, 0, len(mtimes))
	for rel := range mtimes {
		keys = append(keys, rel)
	}
	sort.Slice(keys, func(i, j int) bool {
		di := strings.Count(keys[i], "/")
		dj := strings.Count(keys[j], "/")
		if di != dj {
			return di > dj
		}
		return keys[i] < keys[j]
	})

	for _, rel := range keys {
		abs := filepath.Join(root, filepath.FromSlash(rel))
		if _, err := os.Lstat(abs); err != nil {
			continue
		}
		when := time.UnixMilli(mtimes[rel])
		if err := os.Chtimes(abs, when, when); err != nil {
			t.Fatalf("set mtime of %s: %v", rel, err)
		}
	}
}

// applyModes applies the manifest modes last, deepest path first, and restores
// them in t.Cleanup (shallow path first) so the temporary tree can be removed.
func applyModes(t *testing.T, root string, modes map[string]int) {
	t.Helper()
	if len(modes) == 0 {
		return
	}

	rels := make([]string, 0, len(modes))
	for rel := range modes {
		rels = append(rels, rel)
	}
	sort.Slice(rels, func(i, j int) bool {
		di := strings.Count(rels[i], "/")
		dj := strings.Count(rels[j], "/")
		if di != dj {
			return di > dj
		}
		return rels[i] < rels[j]
	})

	restore := make([]string, len(rels))
	copy(restore, rels)
	for i, j := 0, len(restore)-1; i < j; i, j = i+1, j-1 {
		restore[i], restore[j] = restore[j], restore[i]
	}
	t.Cleanup(func() {
		for _, rel := range restore {
			abs := filepath.Join(root, filepath.FromSlash(rel))
			if err := os.Chmod(abs, 0o755); err != nil {
				t.Logf("restore mode of %s: %v", rel, err)
			}
		}
	})

	for _, rel := range rels {
		abs := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.Chmod(abs, os.FileMode(modes[rel])); err != nil {
			t.Fatalf("set mode of %s: %v", rel, err)
		}
	}
}

// compareGolden encodes got as JSON, decodes it and the golden file into any
// values and compares them with reflect.DeepEqual. On a difference it reports
// the case, the file and the path of the first differing field.
func compareGolden(t *testing.T, caseName, label, goldenRel string, got any) {
	t.Helper()

	want := readGolden(t, goldenRel)
	encoded, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("case %s: encode %s: %v", caseName, label, err)
	}
	var gotValue any
	if err := json.Unmarshal(encoded, &gotValue); err != nil {
		t.Fatalf("case %s: decode encoded %s: %v", caseName, label, err)
	}
	if reflect.DeepEqual(gotValue, want) {
		return
	}

	path, gotAt, wantAt := firstDifference(gotValue, want, "")
	if path == "" {
		path = "<root>"
	}
	t.Fatalf("case %s: %s differs from %s at %s: got %s, want %s",
		caseName, label, goldenRel, path, describe(gotAt), describe(wantAt))
}

// readGolden decodes one golden file into the generic JSON shape.
func readGolden(t *testing.T, rel string) any {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(testdataDir, filepath.FromSlash(rel)))
	if err != nil {
		t.Fatalf("read golden %s: %v", rel, err)
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatalf("decode golden %s: %v", rel, err)
	}
	return value
}

// firstDifference walks two decoded JSON values and returns the path of the
// first differing field with the two values. An empty path means equal, which
// is not used as a field name anywhere.
func firstDifference(got, want any, path string) (string, any, any) {
	switch g := got.(type) {
	case map[string]any:
		w, ok := want.(map[string]any)
		if !ok {
			return path, got, want
		}
		keys := make([]string, 0, len(g)+len(w))
		for key := range g {
			keys = append(keys, key)
		}
		for key := range w {
			if _, present := g[key]; !present {
				keys = append(keys, key)
			}
		}
		sort.Strings(keys)
		for _, key := range keys {
			gv, inGot := g[key]
			wv, inWant := w[key]
			child := key
			if path != "" {
				child = path + "." + key
			}
			if inGot != inWant {
				return child, gv, wv
			}
			if found, gotAt, wantAt := firstDifference(gv, wv, child); found != "" {
				return found, gotAt, wantAt
			}
		}
		return "", nil, nil
	case []any:
		w, ok := want.([]any)
		if !ok {
			return path, got, want
		}
		shared := len(g)
		if len(w) < shared {
			shared = len(w)
		}
		for index := 0; index < shared; index++ {
			child := fmt.Sprintf("%s[%d]", path, index)
			if found, gotAt, wantAt := firstDifference(g[index], w[index], child); found != "" {
				return found, gotAt, wantAt
			}
		}
		if len(g) != len(w) {
			return path + " (length)", len(g), len(w)
		}
		return "", nil, nil
	default:
		if reflect.DeepEqual(got, want) {
			return "", nil, nil
		}
		if path == "" {
			path = "<root>"
		}
		return path, got, want
	}
}

// describe renders one differing value for the failure message.
func describe(value any) string {
	raw, err := json.Marshal(value)
	if err != nil {
		return fmt.Sprintf("%v", value)
	}
	text := string(raw)
	if len(text) > 200 {
		text = text[:200] + "..."
	}
	return text
}

// TestComparisonDetectsDifference proves the comparison can fail: two decoded
// copies of a golden value are equal, and an in-memory mutation of one is
// reported at its field path. It never touches the golden file.
func TestComparisonDetectsDifference(t *testing.T) {
	const golden = "golden/running-pair.state.json"

	want := readGolden(t, golden)
	got := readGolden(t, golden)
	if !reflect.DeepEqual(got, want) {
		t.Fatal("two decodes of the same golden file differ")
	}
	if path, _, _ := firstDifference(got, want, ""); path != "" {
		t.Fatalf("identical values differ at %q", path)
	}

	top, ok := got.(map[string]any)
	if !ok {
		t.Fatalf("golden %s is not a JSON object", golden)
	}
	list, ok := top["repos"].([]any)
	if !ok || len(list) == 0 {
		t.Fatalf("golden %s has no repos", golden)
	}
	repo, ok := list[0].(map[string]any)
	if !ok {
		t.Fatalf("golden %s has no repo object", golden)
	}
	repo["name"] = "mutated"

	if reflect.DeepEqual(got, want) {
		t.Fatal("mutation did not make the values differ")
	}
	path, gotAt, wantAt := firstDifference(got, want, "")
	if path != "repos[0].name" {
		t.Fatalf("difference reported at %q, want %q", path, "repos[0].name")
	}
	if gotAt != "mutated" || wantAt != "alpha" {
		t.Fatalf("difference values = %v, %v, want mutated, alpha", gotAt, wantAt)
	}
}
