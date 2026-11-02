package repos

import (
	"errors"
	"path/filepath"
	"testing"
)

func TestConfigsFlagModeUsesOnlyTheFlags(t *testing.T) {
	base := t.TempDir()
	store := Store{Path: filepath.Join(base, "repos.json")}
	saved := plansFolder(t, base, "saved")
	if _, message, err := store.Add(saved); err != nil || message != "" {
		t.Fatalf("seed Add = (%q, %v)", message, err)
	}
	flagRepo := filepath.Join(base, "flag")

	m := Manager{
		Flags: []string{"flagged=" + flagRepo},
		Cwd:   base,
		Store: store,
		Pick: func() (string, error) {
			t.Fatal("Pick called in flag mode")
			return "", nil
		},
	}
	list, message := m.Configs()
	if len(list) != 1 || list[0].Name != "flagged" || list[0].Dir != flagRepo {
		t.Fatalf("Configs = %v, want only the flag repo", list)
	}
	if message != nil {
		t.Fatalf("message = %q, want nil", *message)
	}
}

func TestConfigsSavedModePassesTheSavedList(t *testing.T) {
	base := t.TempDir()
	store := Store{Path: filepath.Join(base, "repos.json")}
	a := plansFolder(t, base, "a repo")
	b := plansFolder(t, base, "b")
	for _, dir := range []string{a, b} {
		if _, message, err := store.Add(dir); err != nil || message != "" {
			t.Fatalf("seed Add = (%q, %v)", message, err)
		}
	}
	m := Manager{Cwd: base, Store: store}
	list, message := m.Configs()
	if message != nil {
		t.Fatalf("message = %q, want nil", *message)
	}
	if len(list) != 2 {
		t.Fatalf("Configs = %v, want two repos", list)
	}
	if list[0].Name != "a-repo" || list[0].Dir != a {
		t.Fatalf("first repo = %v, want a-repo at %q", list[0], a)
	}
	if list[1].Name != "b" || list[1].Dir != b {
		t.Fatalf("second repo = %v, want b at %q", list[1], b)
	}
}

func TestAddInFlagModeChangesNothing(t *testing.T) {
	base := t.TempDir()
	store := Store{Path: filepath.Join(base, "repos.json")}
	m := Manager{
		Flags: []string{filepath.Join(base, "flag")},
		Cwd:   base,
		Store: store,
		Pick: func() (string, error) {
			t.Fatal("Pick called in flag mode")
			return "", nil
		},
	}
	message, changed := m.Add()
	if message != "repos come from --plans flags" {
		t.Fatalf("message = %q, want the flag-mode message", message)
	}
	if changed {
		t.Fatal("changed = true, want false")
	}
	if len(store.Load()) != 0 {
		t.Fatal("flag mode wrote the saved list")
	}
}

func TestAddCancelledOrFailedPickerChangesNothing(t *testing.T) {
	base := t.TempDir()
	store := Store{Path: filepath.Join(base, "repos.json")}
	for _, pick := range []func() (string, error){
		func() (string, error) { return "", nil },
		func() (string, error) { return "", errors.New("dialog failed") },
	} {
		m := Manager{Cwd: base, Store: store, Pick: pick}
		message, changed := m.Add()
		if message != "" {
			t.Fatalf("message = %q, want empty", message)
		}
		if changed {
			t.Fatal("changed = true, want false")
		}
		if len(store.Load()) != 0 {
			t.Fatal("cancelled picker wrote the saved list")
		}
	}
}

func TestAddRefusedFolderReturnsTheStoreMessage(t *testing.T) {
	base := t.TempDir()
	store := Store{Path: filepath.Join(base, "repos.json")}
	m := Manager{
		Cwd:   base,
		Store: store,
		Pick:  func() (string, error) { return base, nil },
	}
	message, changed := m.Add()
	if message != "not a plans folder" {
		t.Fatalf("message = %q, want the store refusal", message)
	}
	if changed {
		t.Fatal("changed = true, want false")
	}
}

func TestAddSavedReportsChanged(t *testing.T) {
	base := t.TempDir()
	store := Store{Path: filepath.Join(base, "repos.json")}
	dir := plansFolder(t, base, "repo")
	m := Manager{
		Cwd:   base,
		Store: store,
		Pick:  func() (string, error) { return dir, nil },
	}
	message, changed := m.Add()
	if message != "" {
		t.Fatalf("message = %q, want empty", message)
	}
	if !changed {
		t.Fatal("changed = false, want true")
	}
	list := store.Load()
	if len(list) != 1 || list[0].Path != dir {
		t.Fatalf("saved = %v, want %q", list, dir)
	}
}

func TestRemoveInFlagModeOrUnknownNameChangesNothing(t *testing.T) {
	base := t.TempDir()
	store := Store{Path: filepath.Join(base, "repos.json")}
	dir := plansFolder(t, base, "saved")
	if _, message, err := store.Add(dir); err != nil || message != "" {
		t.Fatalf("seed Add = (%q, %v)", message, err)
	}

	flag := Manager{Flags: []string{filepath.Join(base, "flag")}, Cwd: base, Store: store}
	message, changed := flag.Remove("saved")
	if message != "repos come from --plans flags" || changed {
		t.Fatalf("flag Remove = (%q, %v), want message and no change", message, changed)
	}

	saved := Manager{Cwd: base, Store: store}
	message, changed = saved.Remove("nope")
	if message == "" || changed {
		t.Fatalf("unknown Remove = (%q, %v), want message and no change", message, changed)
	}
	if len(store.Load()) != 1 {
		t.Fatal("unknown Remove changed the saved list")
	}
}

func TestRemoveSavedReportsChanged(t *testing.T) {
	base := t.TempDir()
	store := Store{Path: filepath.Join(base, "repos.json")}
	dir := plansFolder(t, base, "repo")
	if _, message, err := store.Add(dir); err != nil || message != "" {
		t.Fatalf("seed Add = (%q, %v)", message, err)
	}
	m := Manager{Cwd: base, Store: store}
	message, changed := m.Remove("repo")
	if message != "" {
		t.Fatalf("message = %q, want empty", message)
	}
	if !changed {
		t.Fatal("changed = false, want true")
	}
	if len(store.Load()) != 0 {
		t.Fatal("repo still saved after Remove")
	}
}
