// Package agents lists and summarises the coding-agent sessions of omp and Pi
// for the monitor's Agents view.
//
// It is read-only. It reads two fixed folders under an injected home, never
// follows a symlink out of them, never runs a command and never touches the
// network. A session that is not inside an added repo is opened for its first
// line only (the line that names its working folder); nothing else of it is
// read, and no session text is ever logged or written anywhere.
package agents

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"

	"pi-monitor/internal/fsx"
	"pi-monitor/internal/lanes"
	"pi-monitor/internal/model"
	"pi-monitor/internal/repos"
	"pi-monitor/internal/sessions"
	"pi-monitor/internal/settings"
)

const (
	// MaxPerGroup is how many sessions of one agent are listed per group.
	MaxPerGroup = 50
	// MaxFileBytes is the largest session file that is listed; a bigger file
	// is skipped before it is opened.
	MaxFileBytes = 64 << 20
)

// The functions the tests swap for counting versions.
var (
	readAgentInfo = sessions.ReadAgentInfo
	summarize     = sessions.SummarizeSession
	maxFileBytes  = MaxFileBytes
)

const (
	agentOmp = "omp"
	agentPi  = "pi"
	dayMs    = 24 * 60 * 60 * 1000
	notAdded = " (not added)"
)

// idRe is the session-id rule: the id is used in a file name and in the
// protocol, so nothing outside these characters is accepted.
var idRe = regexp.MustCompile(`^[\w.-]+$`)

// Options is one listing request.
type Options struct {
	// Home is the folder the two agent roots live under. Tests inject a
	// temporary folder; the app passes the user's home.
	Home string
	// Settings says which roots are read and which sessions are in scope.
	Settings settings.Settings
	// Repos are the added repositories, in the order the client shows them.
	Repos []repos.RepoConfig
	// NowMs is the clock the live rule and the change signature use.
	NowMs int64
}

// RepoRoot is the working folder of a repo: the parent of its plans folder.
func RepoRoot(plansDir string) string {
	return filepath.Dir(filepath.Clean(plansDir))
}

// root is one agent session folder and the agent it belongs to.
type root struct {
	agent string
	dir   string
}

// roots returns the session folders that the settings enable. With both
// toggles off the list is empty, so no folder is read.
func roots(o Options) []root {
	out := make([]root, 0, 2)
	if o.Settings.OmpSessions {
		out = append(out, root{agentOmp, filepath.Join(o.Home, ".omp", "agent", "sessions")})
	}
	if o.Settings.PiSessions {
		out = append(out, root{agentPi, filepath.Join(o.Home, ".pi", "agent", "sessions")})
	}
	return out
}

// fileCache is what was read from one session file at one size and
// modification time. A changed file invalidates the whole entry, so no stale
// header, info or summary survives a write.
type fileCache struct {
	size int64
	mods int64

	header      sessions.SessionHeader
	headerOK    bool
	headerReady bool

	info      sessions.AgentInfo
	infoOK    bool
	infoReady bool

	summary      sessions.SessionSummary
	summaryReady bool
}

// Reader caches the work of listing sessions, keyed by file path and guarded
// by a mutex. One Reader can be reused across change events: an unchanged file
// is not parsed twice.
type Reader struct {
	mu    sync.Mutex
	files map[string]*fileCache
}

// New builds an empty Reader.
func New() *Reader {
	return &Reader{files: make(map[string]*fileCache)}
}

// cacheFor returns the cache entry for file, replacing it when the size or the
// modification time changed. The caller holds the mutex.
func (r *Reader) cacheFor(file string, size, mods int64) *fileCache {
	if r.files == nil {
		r.files = make(map[string]*fileCache)
	}
	entry, ok := r.files[file]
	if !ok || entry.size != size || entry.mods != mods {
		entry = &fileCache{size: size, mods: mods}
		r.files[file] = entry
	}
	return entry
}

// headerFor reads the first line of a session file once per size and
// modification time. Only the header line is read.
func (r *Reader) headerFor(file string, size, mods int64) (sessions.SessionHeader, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	entry := r.cacheFor(file, size, mods)
	if !entry.headerReady {
		entry.header, entry.headerOK = sessions.ReadSessionHeader(file)
		entry.headerReady = true
	}
	return entry.header, entry.headerOK
}

// infoFor streams a listed session file for its latest model and first prompt,
// once per size and modification time.
func (r *Reader) infoFor(file string, size, mods int64) (sessions.AgentInfo, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	entry := r.cacheFor(file, size, mods)
	if !entry.infoReady {
		entry.info, entry.infoOK = readAgentInfo(file)
		entry.infoReady = true
	}
	return entry.info, entry.infoOK
}

// summaryFor summarises a listed session file, once per size and modification
// time. The summary never carries Live: that is computed at list time.
func (r *Reader) summaryFor(file string, size, mods int64) sessions.SessionSummary {
	r.mu.Lock()
	defer r.mu.Unlock()
	entry := r.cacheFor(file, size, mods)
	if !entry.summaryReady {
		entry.summary = summarize(file)
		entry.summaryReady = true
	}
	return entry.summary
}

// fileInfo is one session file found under a root, with the stat data the
// grouping and the signature need.
type fileInfo struct {
	agent   string
	folder  string
	file    string
	name    string
	size    int64
	mods    int64
	mtimeMs float64
}

// listFiles lists the regular .jsonl files directly inside the first-level
// folders of one root. A folder that is not a real directory (a symlink is not)
// or whose real path leaves the root is skipped, and so is a file whose real
// path leaves the root. No file content is read.
func listFiles(rt root) []fileInfo {
	files := make([]fileInfo, 0)
	folders, err := os.ReadDir(rt.dir)
	if err != nil {
		return files
	}
	for _, folderEntry := range folders {
		if !folderEntry.IsDir() {
			continue
		}
		folder := filepath.Join(rt.dir, folderEntry.Name())
		if !fsx.RealInside(rt.dir, folder) {
			continue
		}
		entries, err := os.ReadDir(folder)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if entry.IsDir() {
				continue
			}
			name := entry.Name()
			if !strings.HasSuffix(name, ".jsonl") {
				continue
			}
			file := filepath.Join(folder, name)
			if !fsx.RealInside(rt.dir, file) {
				continue
			}
			info, err := entry.Info()
			if err != nil {
				continue
			}
			if !info.Mode().IsRegular() {
				// A symlink is followed to its target, which RealInside
				// already proved is inside the root; anything else that is
				// not a regular file is skipped.
				if info.Mode()&os.ModeSymlink == 0 {
					continue
				}
				info, err = os.Stat(file)
				if err != nil || !info.Mode().IsRegular() {
					continue
				}
			}
			mods := info.ModTime().UnixNano()
			files = append(files, fileInfo{
				agent:   rt.agent,
				folder:  folderEntry.Name(),
				file:    file,
				name:    name,
				size:    info.Size(),
				mods:    mods,
				mtimeMs: float64(mods) / 1e6,
			})
		}
	}
	return files
}

// repoRoot is one added repo's name and its resolved working folder.
type repoRoot struct {
	name     string
	resolved string
}

// resolveRepoRoots resolves the working folder of every added repo. A folder
// that cannot be resolved is compared cleaned only.
func resolveRepoRoots(list []repos.RepoConfig) []repoRoot {
	out := make([]repoRoot, 0, len(list))
	for _, repo := range list {
		root := RepoRoot(repo.Dir)
		out = append(out, repoRoot{name: repo.Name, resolved: resolvePath(root)})
	}
	return out
}

// resolvePath cleans a path and resolves its symlinks. A path that cannot be
// resolved is returned cleaned, so a missing working folder is still compared.
func resolvePath(path string) string {
	cleaned := filepath.Clean(path)
	resolved, err := filepath.EvalSymlinks(cleaned)
	if err != nil {
		return cleaned
	}
	return resolved
}

// inside reports whether target is root or lies under it.
func inside(root, target string) bool {
	if target == root {
		return true
	}
	return strings.HasPrefix(target, root+string(filepath.Separator))
}

// tailName names a working folder by its last two path parts, or its only part
// when it has one. A path with no parts gives "".
func tailName(cwd string) string {
	parts := make([]string, 0, 2)
	for _, part := range strings.Split(filepath.Clean(cwd), string(filepath.Separator)) {
		if part != "" {
			parts = append(parts, part)
		}
	}
	switch len(parts) {
	case 0:
		return ""
	case 1:
		return parts[0]
	default:
		return parts[len(parts)-2] + "/" + parts[len(parts)-1]
	}
}

// groupOf returns the group a session belongs to and whether an added repo
// matched. The deepest matching repo wins. Under scope all a session with no
// match is grouped by its working folder, with " (not added)" when that name
// is an added repo's name; under scope repos such a session has no group.
func groupOf(cwd, scope string, repoRoots []repoRoot) (string, bool) {
	if strings.TrimSpace(cwd) == "" {
		return "", false
	}
	resolved := resolvePath(cwd)
	best := -1
	bestLen := -1
	for index, repo := range repoRoots {
		if !inside(repo.resolved, resolved) {
			continue
		}
		if len(repo.resolved) > bestLen {
			best = index
			bestLen = len(repo.resolved)
		}
	}
	if best >= 0 {
		return repoRoots[best].name, true
	}
	if scope != settings.ScopeAll {
		return "", false
	}
	name := tailName(cwd)
	for _, repo := range repoRoots {
		if repo.name == name {
			return name + notAdded, false
		}
	}
	return name, false
}

// idFromName is the fallback session id: the part of the file name after the
// last underscore, without the extension.
func idFromName(name string) string {
	base := strings.TrimSuffix(name, ".jsonl")
	index := strings.LastIndexByte(base, '_')
	if index < 0 {
		return ""
	}
	return base[index+1:]
}

// candidate is one session file that has a usable header, before the group cap
// is applied and before its info and summary are read.
type candidate struct {
	agent   string
	file    string
	id      string
	group   string
	size    int64
	mods    int64
	mtimeMs float64
}

// groupKey identifies one agent's list inside one group.
type groupKey struct {
	agent string
	group string
}

// listedSession is a listed session plus the file it came from, which Find
// needs and the client never sees.
type listedSession struct {
	session model.AgentSession
	file    string
}

// listedGroup is one group of the listing.
type listedGroup struct {
	name     string
	sessions []listedSession
}

// List returns the Agent groups of the current options, ordered like the added
// repos and then by newest session. With both toggles off the list is empty.
func (r *Reader) List(o Options) []model.AgentGroup {
	groups := r.list(o)
	out := make([]model.AgentGroup, 0, len(groups))
	for _, group := range groups {
		items := make([]model.AgentSession, 0, len(group.sessions))
		for _, item := range group.sessions {
			items = append(items, item.session)
		}
		out = append(out, model.AgentGroup{Name: group.name, Sessions: items})
	}
	return out
}

// Find returns the file of one listed session. It lists first and never builds
// a path from its arguments: the agent must be omp or pi, the id must match the
// id rule, and the session has to be in the current listing.
func (r *Reader) Find(o Options, agent, group, id string) (string, bool) {
	if agent != agentOmp && agent != agentPi {
		return "", false
	}
	if !idRe.MatchString(id) {
		return "", false
	}
	for _, listed := range r.list(o) {
		if listed.name != group {
			continue
		}
		for _, item := range listed.sessions {
			if item.session.Agent == agent && item.session.ID == id {
				return item.file, true
			}
		}
	}
	return "", false
}

// list is the shared listing: stat and sort first, read the cached first-line
// headers to group, apply the cap, and only then read the info and the summary
// of the sessions that are kept.
func (r *Reader) list(o Options) []listedGroup {
	allRoots := roots(o)
	if len(allRoots) == 0 {
		return nil
	}
	repoRoots := resolveRepoRoots(o.Repos)

	byKey := make(map[groupKey][]candidate)
	for _, rt := range allRoots {
		for _, file := range listFiles(rt) {
			if file.size > int64(maxFileBytes) {
				continue
			}
			header, ok := r.headerFor(file.file, file.size, file.mods)
			if !ok {
				continue
			}
			id := header.ID
			if id == "" {
				id = idFromName(file.name)
			}
			if !idRe.MatchString(id) {
				continue
			}
			group, matched := groupOf(header.Cwd, o.Settings.Scope, repoRoots)
			if !matched && o.Settings.Scope != settings.ScopeAll {
				continue
			}
			key := groupKey{agent: file.agent, group: group}
			byKey[key] = append(byKey[key], candidate{
				agent:   file.agent,
				file:    file.file,
				id:      id,
				group:   group,
				size:    file.size,
				mods:    file.mods,
				mtimeMs: file.mtimeMs,
			})
		}
	}

	perGroup := make(map[string][]listedSession)
	for key, list := range byKey {
		sortCandidates(list)
		if len(list) > MaxPerGroup {
			list = list[:MaxPerGroup]
		}
		for _, item := range list {
			info, ok := r.infoFor(item.file, item.size, item.mods)
			if !ok {
				continue
			}
			summary := r.summaryFor(item.file, item.size, item.mods)
			perGroup[key.group] = append(perGroup[key.group], listedSession{
				session: toSession(o, item, info, summary),
				file:    item.file,
			})
		}
	}

	ordered := make([]listedGroup, 0, len(perGroup))
	seen := make(map[string]bool, len(perGroup))
	for _, repo := range o.Repos {
		if seen[repo.Name] {
			continue
		}
		list, ok := perGroup[repo.Name]
		if !ok {
			continue
		}
		seen[repo.Name] = true
		ordered = append(ordered, listedGroup{name: repo.Name, sessions: sortSessions(list)})
	}
	rest := make([]string, 0, len(perGroup))
	for name := range perGroup {
		if !seen[name] {
			rest = append(rest, name)
		}
	}
	sort.Slice(rest, func(i, j int) bool {
		first, second := newestOf(perGroup[rest[i]]), newestOf(perGroup[rest[j]])
		if first != second {
			return first > second
		}
		return rest[i] < rest[j]
	})
	for _, name := range rest {
		ordered = append(ordered, listedGroup{name: name, sessions: sortSessions(perGroup[name])})
	}
	return ordered
}

// toSession builds the client summary of one listed session. Live is computed
// here from the clock, never cached.
func toSession(o Options, item candidate, info sessions.AgentInfo, summary sessions.SessionSummary) model.AgentSession {
	return model.AgentSession{
		Agent:     item.agent,
		ID:        item.id,
		Title:     info.Title,
		Model:     info.Model,
		Cwd:       info.Cwd,
		Group:     item.group,
		StartedAt: summary.StartedAt,
		MtimeMs:   item.mtimeMs,
		Live:      !summary.Ended && float64(o.NowMs)-item.mtimeMs <= float64(lanes.StallMs),
		Ended:     summary.Ended,
		Tokens:    summary.Tokens,
		Cost:      summary.Cost,
		LastTool:  summary.LastTool,
		Thinking:  summary.Thinking,
	}
}

// sortCandidates orders one agent's candidates newest first, then by id and
// path so the order never depends on the folder walk.
func sortCandidates(list []candidate) {
	sort.SliceStable(list, func(i, j int) bool {
		if list[i].mtimeMs != list[j].mtimeMs {
			return list[i].mtimeMs > list[j].mtimeMs
		}
		if list[i].id != list[j].id {
			return list[i].id < list[j].id
		}
		return list[i].file < list[j].file
	})
}

// sortSessions orders a group's sessions newest first.
func sortSessions(list []listedSession) []listedSession {
	sort.SliceStable(list, func(i, j int) bool {
		first, second := list[i].session, list[j].session
		if first.MtimeMs != second.MtimeMs {
			return first.MtimeMs > second.MtimeMs
		}
		if first.Agent != second.Agent {
			return first.Agent < second.Agent
		}
		return first.ID < second.ID
	})
	return list
}

// newestOf is the newest modification time in a group, or 0 when it is empty.
func newestOf(list []listedSession) float64 {
	newest := float64(0)
	for _, item := range list {
		if item.session.MtimeMs > newest {
			newest = item.session.MtimeMs
		}
	}
	return newest
}

// Signature is the cheap change signature of the enabled roots: one sorted line
// per session file modified in the last 24 hours plus the newest ten of each
// root. It stats the files and never opens one. Both toggles off gives "".
func (r *Reader) Signature(o Options) string {
	allRoots := roots(o)
	if len(allRoots) == 0 {
		return ""
	}
	lines := make([]string, 0)
	for _, rt := range allRoots {
		files := listFiles(rt)
		sort.Slice(files, func(i, j int) bool {
			if files[i].mods != files[j].mods {
				return files[i].mods > files[j].mods
			}
			return files[i].file < files[j].file
		})
		keep := make([]bool, len(files))
		for index := range files {
			if index < 10 || files[index].mtimeMs >= float64(o.NowMs-dayMs) {
				keep[index] = true
			}
		}
		for index, file := range files {
			if !keep[index] {
				continue
			}
			lines = append(lines, file.agent+"|"+file.folder+"/"+file.name+"|"+
				strconv.FormatInt(file.mods, 10)+"|"+strconv.FormatInt(file.size, 10))
		}
	}
	sort.Strings(lines)
	return strings.Join(lines, "\n")
}
