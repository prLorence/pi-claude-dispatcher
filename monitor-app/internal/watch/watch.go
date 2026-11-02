// Package watch builds the poll signature the app compares every 500 ms.
//
// It is a port of monitor/src/server/watch.ts. A signature includes each
// configured repo's name and the names, sizes and modification times of the
// plan and session files of its shown plan, so a change in any of them moves
// the signature. Name order inside a folder is deterministic but not the
// TypeScript's ICU collation; the signature is only ever compared with itself.
package watch

import (
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"pi-monitor/internal/fsx"
	"pi-monitor/internal/plans"
	"pi-monitor/internal/repos"
)

// names lists a folder's entries in a deterministic order, or nothing when
// the folder cannot be read.
func names(dir string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return []string{}
	}
	found := make([]string, 0, len(entries))
	for _, entry := range entries {
		found = append(found, entry.Name())
	}
	sort.Strings(found)
	return found
}

// filePart is one file's path, size and rounded modification time, or a
// "missing" marker when it cannot be stat'ed.
func filePart(file string) string {
	info, err := os.Stat(file)
	if err != nil {
		return file + ":missing"
	}
	size := strconv.FormatInt(info.Size(), 10)
	mtime := strconv.FormatFloat(math.Round(float64(info.ModTime().UnixNano())/1e6), 'f', -1, 64)
	return file + ":" + size + ":" + mtime
}

// entries is filePart for every name of a folder that passes the filter.
func entries(dir string, filter func(name string) bool) []string {
	parts := make([]string, 0)
	for _, name := range names(dir) {
		if filter != nil && !filter(name) {
			continue
		}
		parts = append(parts, filePart(filepath.Join(dir, name)))
	}
	return parts
}

// RepoSignature is the signature of one plans folder for its shown plan id,
// or "" when the folder is not a directory.
func RepoSignature(plansDir string, planID *string) string {
	info, err := os.Stat(plansDir)
	if err != nil || !info.IsDir() {
		return ""
	}

	parts := make([]string, 0)

	if traces, ok := fsx.ResolveInside(plansDir, "traces"); ok {
		parts = append(parts, entries(traces, func(name string) bool {
			return strings.HasSuffix(name, ".jsonl")
		})...)
	}

	if running, ok := fsx.ResolveInside(plansDir, "running"); ok {
		parts = append(parts, entries(running, nil)...)
	}

	if done, ok := fsx.ResolveInside(plansDir, "done"); ok {
		parts = append(parts, "done:["+strings.Join(names(done), ",")+"]")
	}

	if planID != nil {
		if sessions, ok := fsx.ResolveInside(plansDir, "sessions", *planID); ok {
			parts = append(parts, entries(sessions, nil)...)
		}
	}

	return strings.Join(parts, "|")
}

// Signature is one line per repo: its name and the signature of its shown
// plan.
func Signature(list []repos.RepoConfig) string {
	lines := make([]string, 0, len(list))
	for _, repo := range list {
		var planID *string
		if plan := plans.SelectPlan(repo.Dir).Plan; plan != nil {
			planID = &plan.ID
		}
		lines = append(lines, repo.Name+"="+RepoSignature(repo.Dir, planID))
	}
	return strings.Join(lines, "\n")
}
