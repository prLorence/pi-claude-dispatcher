package repos

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func newStore(t *testing.T) Store {
	t.Helper()
	return Store{Path: filepath.Join(t.TempDir(), "repos.json")}
}

func plansFolder(t *testing.T, parent, name string) string {
	t.Helper()
	dir := filepath.Join(parent, name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "traces"), 0o755); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestLoadMissingEmptyAndDamagedGivesAnEmptyList(t *testing.T) {
	dir := t.TempDir()
	cases := []struct {
		name    string
		content *string
	}{
		{name: "missing", content: nil},
		{name: "empty", content: strptr("")},
		{name: "damaged", content: strptr("{not json")},
		{name: "null", content: strptr("null")},
		{name: "wrong shape", content: strptr(`{"name":"x"}`)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(dir, tc.name+".json")
			if tc.content != nil {
				if err := os.WriteFile(path, []byte(*tc.content), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			list := Store{Path: path}.Load()
			if list == nil {
				t.Fatal("Load returned nil, want an empty list")
			}
			if len(list) != 0 {
				t.Fatalf("Load = %v, want empty", list)
			}
		})
	}
}

func strptr(s string) *string {
	return &s
}

func TestAddAcceptsAFolderNamedPlans(t *testing.T) {
	store := newStore(t)
	dir := filepath.Join(t.TempDir(), "myrepo", ".plans")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	saved, message, err := store.Add(dir)
	if err != nil {
		t.Fatalf("Add error = %v", err)
	}
	if message != "" {
		t.Fatalf("message = %q, want empty", message)
	}
	if saved.Name != "myrepo" {
		t.Fatalf("name = %q, want myrepo", saved.Name)
	}
	if saved.Path != dir {
		t.Fatalf("path = %q, want %q", saved.Path, dir)
	}
	list := store.Load()
	if len(list) != 1 || list[0] != saved {
		t.Fatalf("Load = %v, want just %v", list, saved)
	}
}

func TestAddAcceptsAFolderWithAMarker(t *testing.T) {
	store := newStore(t)
	dir := plansFolder(t, t.TempDir(), "repo")
	saved, message, err := store.Add(dir)
	if err != nil || message != "" {
		t.Fatalf("Add = (%q, %v), want no message and no error", message, err)
	}
	if saved.Path != dir || saved.Name != "repo" {
		t.Fatalf("saved = %v, want the chosen folder named repo", saved)
	}
}

func TestAddUsesAPlansSubfolderWhenThereIsOne(t *testing.T) {
	store := newStore(t)
	dir := filepath.Join(t.TempDir(), "repo")
	sub := filepath.Join(dir, ".plans")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	saved, message, err := store.Add(dir)
	if err != nil || message != "" {
		t.Fatalf("Add = (%q, %v), want no message and no error", message, err)
	}
	if saved.Path != sub {
		t.Fatalf("path = %q, want %q", saved.Path, sub)
	}
	if saved.Name != "repo" {
		t.Fatalf("name = %q, want repo", saved.Name)
	}
}

func TestAddRefusesAPlainOrMissingFolder(t *testing.T) {
	base := t.TempDir()
	store := Store{Path: filepath.Join(base, "repos.json")}
	plain := filepath.Join(base, "plain")
	if err := os.Mkdir(plain, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, chosen := range []string{plain, filepath.Join(base, "missing")} {
		_, message, err := store.Add(chosen)
		if err != nil {
			t.Fatalf("Add(%q) error = %v", chosen, err)
		}
		if message == "" {
			t.Fatalf("Add(%q) message empty, want a refusal", chosen)
		}
		if len(store.Load()) != 0 {
			t.Fatalf("Add(%q) changed the list", chosen)
		}
	}
	if _, err := os.Stat(store.Path); !os.IsNotExist(err) {
		t.Fatalf("refused Add wrote the file: %v", err)
	}
}

func TestAddRefusesADuplicatePath(t *testing.T) {
	store := newStore(t)
	dir := plansFolder(t, t.TempDir(), "repo")
	if _, message, err := store.Add(dir); err != nil || message != "" {
		t.Fatalf("first Add = (%q, %v)", message, err)
	}
	_, message, err := store.Add(dir)
	if err != nil {
		t.Fatal(err)
	}
	if message == "" {
		t.Fatal("second Add message empty, want a refusal")
	}
	if len(store.Load()) != 1 {
		t.Fatalf("Load = %v, want one repo", store.Load())
	}
}

func TestAddGivesDuplicatesNumberedNames(t *testing.T) {
	store := newStore(t)
	base := t.TempDir()
	first := plansFolder(t, filepath.Join(base, "one"), "repo")
	second := plansFolder(t, filepath.Join(base, "two"), "repo")
	one, _, err := store.Add(first)
	if err != nil {
		t.Fatal(err)
	}
	two, _, err := store.Add(second)
	if err != nil {
		t.Fatal(err)
	}
	if one.Name != "repo" || two.Name != "repo-2" {
		t.Fatalf("names = %q, %q, want repo, repo-2", one.Name, two.Name)
	}
}

func TestAddCreatesTheParentFolderAndWritesJSON(t *testing.T) {
	base := t.TempDir()
	path := filepath.Join(base, "nested", "dir", "repos.json")
	store := Store{Path: path}
	dir := plansFolder(t, base, "repo")
	if _, message, err := store.Add(dir); err != nil || message != "" {
		t.Fatalf("Add = (%q, %v)", message, err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("saved file: %v", err)
	}
	var raw []map[string]string
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("saved file is not a JSON array: %v", err)
	}
	if len(raw) != 1 || raw[0]["name"] != "repo" || raw[0]["path"] != dir {
		t.Fatalf("saved JSON = %v, want name and path", raw)
	}
}

func TestRemoveDeletesByNameAndRejectsUnknownNames(t *testing.T) {
	store := newStore(t)
	base := t.TempDir()
	a := plansFolder(t, base, "a")
	b := plansFolder(t, base, "b")
	for _, dir := range []string{a, b} {
		if _, message, err := store.Add(dir); err != nil || message != "" {
			t.Fatalf("Add(%q) = (%q, %v)", dir, message, err)
		}
	}
	if err := store.Remove("a"); err != nil {
		t.Fatalf("Remove(a) = %v", err)
	}
	list := store.Load()
	if len(list) != 1 || list[0].Name != "b" {
		t.Fatalf("after remove = %v, want just b", list)
	}

	if err := store.Remove("nope"); err == nil {
		t.Fatal("Remove(nope) = nil, want an error")
	}
	list = store.Load()
	if len(list) != 1 || list[0].Name != "b" {
		t.Fatalf("unknown remove changed the list: %v", list)
	}
}
