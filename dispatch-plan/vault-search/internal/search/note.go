package search

import (
	"encoding/json"
	"strings"
)

var retiredStatuses = map[string]bool{
	"closed":     true,
	"superseded": true,
	"stale":      true,
	"dropped":    true,
}

// IsActive reports whether a note status counts as active. A note with no
// status is active; the four retired statuses are not.
func IsActive(status string) bool {
	return !retiredStatuses[strings.ToLower(strings.TrimSpace(status))]
}

// parseFrontmatter reads a note's properties, list properties and body. A
// file without a first line of --- and a closing --- line has no frontmatter
// and is skipped by the caller.
func parseFrontmatter(text string) (map[string]string, map[string][]string, string, bool) {
	lines := strings.Split(text, "\n")
	for i := range lines {
		lines[i] = strings.TrimSuffix(lines[i], "\r")
	}
	if len(lines) == 0 || lines[0] != "---" {
		return nil, nil, "", false
	}
	closeIndex := -1
	for i := 1; i < len(lines); i++ {
		if lines[i] == "---" {
			closeIndex = i
			break
		}
	}
	if closeIndex < 0 {
		return nil, nil, "", false
	}

	props := map[string]string{}
	lists := map[string][]string{}
	listKey := ""
	for i := 1; i < closeIndex; i++ {
		line := lines[i]
		if strings.HasPrefix(line, "  - ") {
			if listKey == "" {
				continue
			}
			lists[listKey] = append(lists[listKey], parseScalar(line[4:]))
			continue
		}
		sep := strings.Index(line, ":")
		if sep <= 0 {
			continue
		}
		key := strings.TrimSpace(line[:sep])
		rest := strings.TrimSpace(line[sep+1:])
		if rest == "" {
			lists[key] = []string{}
			listKey = key
			continue
		}
		props[key] = parseScalar(rest)
		listKey = ""
	}

	body := strings.Join(lines[closeIndex+1:], "\n")
	return props, lists, body, true
}

func parseScalar(raw string) string {
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "\"") {
		var value string
		if err := json.Unmarshal([]byte(raw), &value); err == nil {
			return value
		}
	}
	return raw
}

// inScope applies the repo rules: every note under --all, otherwise a note
// whose repo is the current one or "-". A note with a repos list is a project
// note and is in scope when that list holds the current repo.
func inScope(opts Options, repo string, repos []string, hasRepos bool) bool {
	if opts.All {
		return true
	}
	if hasRepos {
		if opts.Repo == "" {
			return false
		}
		for _, entry := range repos {
			if entry == opts.Repo {
				return true
			}
		}
		return false
	}
	if repo == "-" {
		return true
	}
	return opts.Repo != "" && repo == opts.Repo
}
