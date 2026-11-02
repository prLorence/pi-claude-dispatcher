// Package settings holds the monitor's own settings: whether it reads omp and
// Pi sessions, and which of those sessions it lists. The settings live in a
// small JSON file that the caller points at; the package never guesses a path.
package settings

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// ScopeRepos lists only the sessions of the added repos. ScopeAll lists every
// session of the enabled agents.
const (
	ScopeRepos = "repos"
	ScopeAll   = "all"
)

// Settings is the saved state of the settings panel.
type Settings struct {
	OmpSessions bool   `json:"ompSessions"`
	PiSessions  bool   `json:"piSessions"`
	Scope       string `json:"scope"`
}

// Default is the state before the user changes anything: both agent toggles
// off, and only the added repos in scope.
func Default() Settings {
	return Settings{OmpSessions: false, PiSessions: false, Scope: ScopeRepos}
}

// Normalize repairs a value that could be saved but is not meaningful: an
// unknown scope becomes ScopeRepos, and the rest is left alone.
func Normalize(s Settings) Settings {
	if s.Scope != ScopeAll {
		s.Scope = ScopeRepos
	}
	return s
}

// Store is the settings file at Path. Path is always injected by the caller; a
// missing, empty or damaged file reads as the defaults.
type Store struct {
	Path string
}

// Load reads the settings. It never panics: a missing, empty or damaged file,
// including one whose fields have the wrong type, gives the defaults. A file
// that parses is normalized, so an unknown scope becomes ScopeRepos.
func (s Store) Load() Settings {
	data, err := os.ReadFile(s.Path)
	if err != nil {
		return Default()
	}
	var v Settings
	if err := json.Unmarshal(data, &v); err != nil {
		return Default()
	}
	return Normalize(v)
}

// Save writes the settings atomically: normalized, indented JSON with a
// trailing newline, through a temporary file in the same folder and a rename.
// The file is left at mode 0600. A parent folder the store has to create is
// made at mode 0700; a folder that already exists keeps its mode.
func (s Store) Save(v Settings) error {
	dir := filepath.Dir(s.Path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(Normalize(v), "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')

	f, err := os.CreateTemp(dir, ".settings-*.tmp")
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
