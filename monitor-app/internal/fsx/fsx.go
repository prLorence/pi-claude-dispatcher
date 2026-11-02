// Package fsx builds and checks the paths the monitor reads.
package fsx

import (
	"path/filepath"
	"strings"
)

// ResolveInside is the port of resolveInside in monitor/src/server/http.ts.
// It is a path-text check only: it rejects a NUL byte, an absolute part and a
// ".." segment, joins the parts under base and reports whether the result is
// base or a path under it. It follows no symlink, exactly like the TypeScript.
func ResolveInside(base string, parts ...string) (string, bool) {
	root, err := filepath.Abs(base)
	if err != nil {
		return "", false
	}
	for _, part := range parts {
		if strings.ContainsRune(part, 0) || filepath.IsAbs(part) {
			return "", false
		}
		if hasParentSegment(part) {
			return "", false
		}
	}

	target := filepath.Join(append([]string{root}, parts...)...)
	if target == root || strings.HasPrefix(target, root+string(filepath.Separator)) {
		return target, true
	}
	return "", false
}

// RealInside reports whether target, after resolving symlinks on both base and
// target, is base or a path under it. A base or target that cannot be resolved,
// including a missing target, is reported as outside.
func RealInside(base, target string) bool {
	realBase, err := filepath.EvalSymlinks(base)
	if err != nil {
		return false
	}
	realTarget, err := filepath.EvalSymlinks(target)
	if err != nil {
		return false
	}
	rel, err := filepath.Rel(realBase, realTarget)
	if err != nil {
		return false
	}
	if rel == "." {
		return true
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

// hasParentSegment reports whether a part contains a ".." segment, splitting on
// both "/" and "\" as the TypeScript does.
func hasParentSegment(part string) bool {
	for _, segment := range strings.FieldsFunc(part, func(r rune) bool { return r == '/' || r == '\\' }) {
		if segment == ".." {
			return true
		}
	}
	return false
}
