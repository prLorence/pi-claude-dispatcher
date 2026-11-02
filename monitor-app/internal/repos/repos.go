// Package repos builds the list of monitored repositories, exactly as
// monitor/src/server/repos.ts does, and owns the only file the app writes: the
// saved repo list of spec R6.
package repos

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// RepoConfig is one configured repository: its display name and its folder.
type RepoConfig struct {
	Name string `json:"name"`
	Dir  string `json:"dir"`
}

// RepoInput is the repo configuration input. A field left empty is unset, so
// the precedence is flags, then list, then root, then single.
type RepoInput struct {
	Flags  []string
	List   string
	Root   string
	Single string
}

// MaxRepos is the cap on the number of repos the monitor shows.
const MaxRepos = 24

var nameRe = regexp.MustCompile(`^[\w.-]+$`)

var markers = []string{"traces", "running", "done", "inbox", "sessions"}

// entry is one candidate repo before names are made unique.
type entry struct {
	name *string
	dir  string
}

// folderName is the folder name of a resolved path; "" when the path has no
// usable name.
func folderName(dir string) string {
	base := filepath.Base(dir)
	if base == "" || base == string(filepath.Separator) || base == "." {
		return ""
	}
	return base
}

// sanitize turns every character outside [\w.-] into "-"; an empty result
// becomes "repo".
func sanitize(raw string) string {
	var b strings.Builder
	for _, r := range raw {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == '_' || r == '.' || r == '-':
			b.WriteRune(r)
		default:
			b.WriteByte('-')
		}
	}
	if b.Len() == 0 {
		return "repo"
	}
	return b.String()
}

// defaultName is the folder name, or the parent folder name for a path ending
// in ".plans", sanitised.
func defaultName(dir string) string {
	if filepath.Base(dir) == ".plans" {
		return sanitize(folderName(filepath.Dir(dir)))
	}
	return sanitize(folderName(dir))
}

// parseSpec reads a "[name=]<path>" spec. The text before the first "=" is a
// name only when it matches the name rule and a path follows.
func parseSpec(text string) (string, string, bool) {
	eq := strings.Index(text, "=")
	if eq > 0 {
		candidate := text[:eq]
		rest := text[eq+1:]
		if nameRe.MatchString(candidate) && rest != "" {
			return candidate, rest, true
		}
	}
	return "", text, false
}

// resolvePath is the Node path.resolve rule for one part: an absolute part is
// cleaned, a relative one is joined to cwd.
func resolvePath(cwd, p string) string {
	if filepath.IsAbs(p) {
		return filepath.Clean(p)
	}
	return filepath.Join(cwd, p)
}

func (e entry) resolvedName() string {
	if e.name != nil {
		return *e.name
	}
	return defaultName(e.dir)
}

func specEntry(spec, cwd string) entry {
	named, value, explicit := parseSpec(spec)
	e := entry{dir: resolvePath(cwd, value)}
	if explicit {
		e.name = &named
	}
	return e
}

func listSpecs(list string) []string {
	parts := strings.Split(list, string(filepath.ListSeparator))
	out := make([]string, 0, len(parts))
	for _, item := range parts {
		item = strings.TrimSpace(item)
		if item != "" {
			out = append(out, item)
		}
	}
	return out
}

// rootEntries lists the immediate subfolders of a plans root, or the root
// itself when it already looks like a plans folder.
func rootEntries(root, cwd string) []entry {
	abs := resolvePath(cwd, root)

	info, err := os.Stat(abs)
	if err != nil || !info.IsDir() {
		return nil
	}

	for _, marker := range markers {
		if _, err := os.Stat(filepath.Join(abs, marker)); err == nil {
			return []entry{{dir: abs}}
		}
	}

	items, err := os.ReadDir(abs)
	if err != nil {
		return nil
	}

	folders := make([]string, 0, len(items))
	for _, item := range items {
		if item.IsDir() && !strings.HasPrefix(item.Name(), ".") {
			folders = append(folders, item.Name())
		}
	}
	// The TypeScript sorts with localeCompare; the app never uses Root (the
	// Manager passes Flags), so a plain byte sort is kept here on purpose and
	// the mixed-case ordering may differ.
	sort.Strings(folders)

	out := make([]entry, 0, len(folders))
	for _, name := range folders {
		out = append(out, entry{dir: filepath.Join(abs, name)})
	}
	return out
}

// uniqueName is the TypeScript duplicate rule: the first use of a name is the
// name itself, later uses get -2, -3, ... skipping names already taken.
func uniqueName(base string, seen map[string]int) string {
	current, ok := seen[base]
	if !ok {
		seen[base] = 1
		return base
	}
	n := current + 1
	for {
		if _, taken := seen[base+"-"+strconv.Itoa(n)]; !taken {
			break
		}
		n++
	}
	seen[base] = n
	candidate := base + "-" + strconv.Itoa(n)
	seen[candidate] = 1
	return candidate
}

// ResolveRepos builds the repo list from one configuration form, names the
// repos, cuts them at MaxRepos and returns the cap message when repos were
// dropped. The message is nil when nothing was dropped.
func ResolveRepos(input RepoInput, cwd string) ([]RepoConfig, *string) {
	base, err := filepath.Abs(cwd)
	if err != nil {
		base = filepath.Clean(cwd)
	}

	var entries []entry
	switch {
	case len(input.Flags) > 0:
		entries = make([]entry, 0, len(input.Flags))
		for _, flag := range input.Flags {
			entries = append(entries, specEntry(flag, base))
		}
	case input.List != "":
		specs := listSpecs(input.List)
		entries = make([]entry, 0, len(specs))
		for _, spec := range specs {
			entries = append(entries, specEntry(spec, base))
		}
	case input.Root != "":
		entries = rootEntries(input.Root, base)
	case input.Single != "":
		entries = []entry{specEntry(input.Single, base)}
	}

	seen := make(map[string]int, len(entries))
	all := make([]RepoConfig, 0, len(entries))
	for _, e := range entries {
		all = append(all, RepoConfig{Name: uniqueName(e.resolvedName(), seen), Dir: e.dir})
	}

	repos := all
	if len(all) > MaxRepos {
		repos = all[:MaxRepos]
	}
	var message *string
	if extra := len(all) - len(repos); extra > 0 {
		text := strconv.Itoa(extra) + " more repos ignored (limit " + strconv.Itoa(MaxRepos) + ")"
		message = &text
	}
	return repos, message
}
