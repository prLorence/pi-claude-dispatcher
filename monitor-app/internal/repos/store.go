package repos

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// SavedRepo is one entry of the saved repo list: the file the user's Add and
// Remove controls change.
type SavedRepo struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

// Store is the saved repo list at Path. Path is always injected by the caller;
// a missing, empty or damaged file reads as an empty list.
type Store struct {
	Path string
}

func emptySaved() []SavedRepo {
	return []SavedRepo{}
}

// Load reads the saved list. It never panics and never returns nil: a missing,
// empty or damaged file gives an empty list.
func (s Store) Load() []SavedRepo {
	data, err := os.ReadFile(s.Path)
	if err != nil {
		return emptySaved()
	}
	list := emptySaved()
	if err := json.Unmarshal(data, &list); err != nil {
		return emptySaved()
	}
	if list == nil {
		return emptySaved()
	}
	return list
}

// isPlansFolder reports whether dir is a plans folder: it is named ".plans" or
// holds one of the plans-folder markers.
func isPlansFolder(dir string) bool {
	if filepath.Base(dir) == ".plans" {
		return true
	}
	for _, marker := range markers {
		if _, err := os.Stat(filepath.Join(dir, marker)); err == nil {
			return true
		}
	}
	return false
}

// Add saves the chosen folder. It accepts a folder named ".plans" or one that
// holds a plans-folder marker, and otherwise uses a ".plans" subfolder when the
// chosen folder has one. When the folder is refused the returned message is the
// user-facing reason and nothing changes; an error is a write failure.
func (s Store) Add(chosen string) (SavedRepo, string, error) {
	target := filepath.Clean(chosen)

	info, err := os.Stat(target)
	switch {
	case err != nil || !info.IsDir():
		return SavedRepo{}, "not a plans folder", nil
	case isPlansFolder(target):
		// Use the chosen folder itself.
	default:
		sub := filepath.Join(target, ".plans")
		if subInfo, err := os.Stat(sub); err == nil && subInfo.IsDir() {
			target = sub
		} else {
			return SavedRepo{}, "not a plans folder", nil
		}
	}

	list := s.Load()
	for _, saved := range list {
		if filepath.Clean(saved.Path) == target {
			return SavedRepo{}, "this repo is already in the list", nil
		}
	}

	seen := make(map[string]int, len(list)+1)
	for _, saved := range list {
		seen[saved.Name] = 1
	}
	saved := SavedRepo{Name: uniqueName(defaultName(target), seen), Path: target}

	list = append(list, saved)
	if err := s.save(list); err != nil {
		return SavedRepo{}, "", err
	}
	return saved, "", nil
}

// Remove deletes the saved repo with the given name. An unknown name is an
// error and leaves the file alone.
func (s Store) Remove(name string) error {
	list := s.Load()
	out := make([]SavedRepo, 0, len(list))
	found := false
	for _, saved := range list {
		if !found && saved.Name == name {
			found = true
			continue
		}
		out = append(out, saved)
	}
	if !found {
		return fmt.Errorf("no saved repo named %s", name)
	}
	return s.save(out)
}

// save writes the list atomically: a temporary file in the same folder, then a
// rename. The file is left at mode 0600, so the list is private to the user. A
// parent folder the store has to create is made at mode 0700; a folder that
// already exists keeps its mode.
func (s Store) save(list []SavedRepo) error {
	dir := filepath.Dir(s.Path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(list, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')

	f, err := os.CreateTemp(dir, ".repos-*.tmp")
	if err != nil {
		return err
	}
	tmp := f.Name()
	done := false
	defer func() {
		if !done {
			os.Remove(tmp)
		}
	}()

	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmp, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, s.Path); err != nil {
		return err
	}
	done = true
	return nil
}
