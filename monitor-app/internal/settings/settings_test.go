package settings

import (
	"encoding/json"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func newStore(t *testing.T) Store {
	t.Helper()
	return Store{Path: filepath.Join(t.TempDir(), "settings.json")}
}

func writeFile(t *testing.T, path, content string, perm os.FileMode) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), perm); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, perm); err != nil {
		t.Fatal(err)
	}
}

func TestDefault(t *testing.T) {
	got := Default()
	if got.OmpSessions || got.PiSessions {
		t.Fatalf("Default toggles = (%v, %v), want both false", got.OmpSessions, got.PiSessions)
	}
	if got.Scope != ScopeRepos {
		t.Fatalf("Default scope = %q, want %q", got.Scope, ScopeRepos)
	}
}

func TestLoadMissingEmptyAndDamagedGivesDefaults(t *testing.T) {
	dir := t.TempDir()
	cases := []struct {
		name    string
		content *string
	}{
		{name: "missing", content: nil},
		{name: "empty", content: strptr("")},
		{name: "damaged", content: strptr("{not json")},
		{name: "null", content: strptr("null")},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(dir, tc.name+".json")
			if tc.content != nil {
				writeFile(t, path, *tc.content, 0o644)
			}
			got := Store{Path: path}.Load()
			if got != Default() {
				t.Fatalf("Load = %+v, want %+v", got, Default())
			}
		})
	}
}

func TestLoadUnknownScopeRepairsToRepos(t *testing.T) {
	store := newStore(t)
	writeFile(t, store.Path, `{"ompSessions":true,"piSessions":false,"scope":"elsewhere"}`, 0o644)
	got := store.Load()
	if got.Scope != ScopeRepos {
		t.Fatalf("scope = %q, want %q", got.Scope, ScopeRepos)
	}
	if !got.OmpSessions {
		t.Fatal("ompSessions = false, want the saved true")
	}
}

func TestLoadWrongTypedFieldGivesDefaults(t *testing.T) {
	store := newStore(t)
	writeFile(t, store.Path, `{"ompSessions":"yes","piSessions":true,"scope":"all"}`, 0o644)
	got := store.Load()
	if got != Default() {
		t.Fatalf("Load = %+v, want %+v", got, Default())
	}
}

func TestNormalize(t *testing.T) {
	if got := Normalize(Settings{Scope: ScopeAll}); got.Scope != ScopeAll {
		t.Fatalf("scope = %q, want %q", got.Scope, ScopeAll)
	}
	if got := Normalize(Settings{Scope: ""}); got.Scope != ScopeRepos {
		t.Fatalf("scope = %q, want %q", got.Scope, ScopeRepos)
	}
}

func TestSaveAndLoadRoundTrip(t *testing.T) {
	store := newStore(t)
	want := Settings{OmpSessions: true, PiSessions: true, Scope: ScopeAll}
	if err := store.Save(want); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if got := store.Load(); got != want {
		t.Fatalf("Load = %+v, want %+v", got, want)
	}
}

func TestSaveWritesIndentedJSONWithTrailingNewline(t *testing.T) {
	store := newStore(t)
	if err := store.Save(Settings{PiSessions: true, Scope: ScopeAll}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	data, err := os.ReadFile(store.Path)
	if err != nil {
		t.Fatalf("saved file: %v", err)
	}
	if len(data) == 0 || data[len(data)-1] != '\n' {
		t.Fatalf("file does not end with a newline: %q", data)
	}
	want, err := json.MarshalIndent(Settings{PiSessions: true, Scope: ScopeAll}, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != string(want)+"\n" {
		t.Fatalf("file = %q, want %q", data, string(want)+"\n")
	}
}

func TestSaveNormalizesScope(t *testing.T) {
	store := newStore(t)
	if err := store.Save(Settings{OmpSessions: true, Scope: "bogus"}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if got := store.Load(); got.Scope != ScopeRepos {
		t.Fatalf("scope = %q, want %q", got.Scope, ScopeRepos)
	}
}

func TestSaveFileMode(t *testing.T) {
	store := newStore(t)
	if err := store.Save(Default()); err != nil {
		t.Fatalf("Save: %v", err)
	}
	info, err := os.Stat(store.Path)
	if err != nil {
		t.Fatalf("saved file: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("file mode = %#o, want %#o", perm, 0o600)
	}
}

func TestSaveOverwritesWiderMode(t *testing.T) {
	store := newStore(t)
	writeFile(t, store.Path, "{}\n", 0o644)
	if err := store.Save(Default()); err != nil {
		t.Fatalf("Save: %v", err)
	}
	info, err := os.Stat(store.Path)
	if err != nil {
		t.Fatalf("saved file: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("file mode after save = %#o, want %#o", perm, 0o600)
	}
}

func TestSaveNewFolderMode(t *testing.T) {
	old := syscall.Umask(0)
	t.Cleanup(func() { syscall.Umask(old) })

	parent := filepath.Join(t.TempDir(), "nested", "dir")
	store := Store{Path: filepath.Join(parent, "settings.json")}
	if err := store.Save(Default()); err != nil {
		t.Fatalf("Save: %v", err)
	}
	info, err := os.Stat(parent)
	if err != nil {
		t.Fatalf("created folder: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o700 {
		t.Fatalf("folder mode = %#o, want %#o", perm, 0o700)
	}
}

func TestSaveKeepsExistingFolderMode(t *testing.T) {
	parent := filepath.Join(t.TempDir(), "existing")
	if err := os.Mkdir(parent, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(parent, 0o755); err != nil {
		t.Fatal(err)
	}
	store := Store{Path: filepath.Join(parent, "settings.json")}
	if err := store.Save(Default()); err != nil {
		t.Fatalf("Save: %v", err)
	}
	info, err := os.Stat(parent)
	if err != nil {
		t.Fatalf("existing folder: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o755 {
		t.Fatalf("existing folder mode = %#o, want %#o", perm, 0o755)
	}
}

func TestSaveFailureLeavesNoTemporaryFile(t *testing.T) {
	base := t.TempDir()
	blocker := filepath.Join(base, "blocker")
	writeFile(t, blocker, "not a folder", 0o644)
	store := Store{Path: filepath.Join(blocker, "settings.json")}

	if err := store.Save(Default()); err == nil {
		t.Fatal("Save = nil, want an error for a path under a file")
	}
	entries, err := os.ReadDir(base)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != "blocker" {
		t.Fatalf("folder holds %v, want only the blocker file", entries)
	}
}

func strptr(s string) *string { return &s }
