package repos

import "fmt"

// Manager is the repo mode of spec R6. When Flags is not empty the monitor is in
// flag mode: only the flag repos are shown and the saved list is neither read
// nor changed. Otherwise the saved list is passed to ResolveRepos as name=path
// entries. Pick is injected so only the Wails shell owns the folder dialog.
type Manager struct {
	Flags []string
	Cwd   string
	Store Store
	Pick  func() (string, error)
}

func (m *Manager) flagMode() bool {
	return len(m.Flags) > 0
}

// Configs returns the repos to show and the cap message, if any.
func (m *Manager) Configs() ([]RepoConfig, *string) {
	if m.flagMode() {
		return ResolveRepos(RepoInput{Flags: m.Flags}, m.Cwd)
	}
	saved := m.Store.Load()
	specs := make([]string, 0, len(saved))
	for _, repo := range saved {
		specs = append(specs, repo.Name+"="+repo.Path)
	}
	return ResolveRepos(RepoInput{Flags: specs}, m.Cwd)
}

// Add runs the folder picker and saves the chosen folder. The message is the
// user-facing reason when nothing changed; changed is true only after a save.
func (m *Manager) Add() (string, bool) {
	if m.flagMode() {
		return "repos come from --plans flags", false
	}
	if m.Pick == nil {
		return "", false
	}
	chosen, err := m.Pick()
	if err != nil || chosen == "" {
		return "", false
	}
	_, message, err := m.Store.Add(chosen)
	if err != nil {
		return err.Error(), false
	}
	if message != "" {
		return message, false
	}
	return "", true
}

// Remove deletes a saved repo by name. A flag repo and an unknown name return a
// message and change nothing.
func (m *Manager) Remove(name string) (string, bool) {
	if m.flagMode() {
		return "repos come from --plans flags", false
	}
	if err := m.Store.Remove(name); err != nil {
		return fmt.Sprintf("no saved repo named %s", name), false
	}
	return "", true
}
