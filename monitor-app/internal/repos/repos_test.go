package repos

import (
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

func dirs(list []RepoConfig) []string {
	out := make([]string, 0, len(list))
	for _, repo := range list {
		out = append(out, repo.Dir)
	}
	return out
}

func names(list []RepoConfig) []string {
	out := make([]string, 0, len(list))
	for _, repo := range list {
		out = append(out, repo.Name)
	}
	return out
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func requireNames(t *testing.T, got []RepoConfig, want []string) {
	t.Helper()
	if !equalStrings(names(got), want) {
		t.Fatalf("names = %v, want %v", names(got), want)
	}
}

func requireDirs(t *testing.T, got []RepoConfig, want []string) {
	t.Helper()
	if !equalStrings(dirs(got), want) {
		t.Fatalf("dirs = %v, want %v", dirs(got), want)
	}
}

func TestFlagsWinOverListRootAndSingle(t *testing.T) {
	base := t.TempDir()
	a := filepath.Join(base, "a")
	b := filepath.Join(base, "b")
	result, message := ResolveRepos(RepoInput{Flags: []string{a}, List: b, Root: base, Single: base}, base)
	requireNames(t, result, []string{"a"})
	requireDirs(t, result, []string{a})
	if message != nil {
		t.Fatalf("message = %q, want nil", *message)
	}
}

func TestListWinsOverRootAndSingle(t *testing.T) {
	base := t.TempDir()
	a := filepath.Join(base, "a")
	b := filepath.Join(base, "b")
	result, _ := ResolveRepos(RepoInput{List: a + string(filepath.ListSeparator) + b, Root: base, Single: base}, base)
	requireNames(t, result, []string{"a", "b"})
	requireDirs(t, result, []string{a, b})
}

func TestRootWinsOverSingle(t *testing.T) {
	base := t.TempDir()
	if err := os.Mkdir(filepath.Join(base, "one"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(base, "two"), 0o755); err != nil {
		t.Fatal(err)
	}
	result, _ := ResolveRepos(RepoInput{Root: base, Single: base}, base)
	requireNames(t, result, []string{"one", "two"})
}

func TestSingleIsTheFallbackAndTakesNamePath(t *testing.T) {
	base := t.TempDir()
	a := filepath.Join(base, "a")
	result, _ := ResolveRepos(RepoInput{Single: "mine=" + a}, base)
	requireNames(t, result, []string{"mine"})
	requireDirs(t, result, []string{a})
}

func TestEveryConfigurationFormIsEmptyWhenNothingIsConfigured(t *testing.T) {
	base := t.TempDir()
	result, message := ResolveRepos(RepoInput{Flags: []string{}}, base)
	if result == nil {
		t.Fatal("repos is nil, want an empty list")
	}
	if len(result) != 0 {
		t.Fatalf("repos = %v, want empty", result)
	}
	if message != nil {
		t.Fatalf("message = %q, want nil", *message)
	}
}

func TestExplicitNameAndBadNameText(t *testing.T) {
	base := t.TempDir()
	good := filepath.Join(base, "x")
	bad := "bad name=" + filepath.Join(base, "y")
	result, _ := ResolveRepos(RepoInput{Flags: []string{"good=" + good, bad}}, base)
	if result[0].Name != "good" {
		t.Fatalf("first name = %q, want good", result[0].Name)
	}
	if result[1].Dir != filepath.Join(base, bad) {
		t.Fatalf("second dir = %q, want %q", result[1].Dir, filepath.Join(base, bad))
	}
	if result[1].Name != "y" {
		t.Fatalf("second name = %q, want y", result[1].Name)
	}
}

func TestPlansPathIsNamedAfterItsParentFolder(t *testing.T) {
	base := t.TempDir()
	dir := filepath.Join(base, "myrepo", ".plans")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	result, _ := ResolveRepos(RepoInput{Flags: []string{dir}}, base)
	if result[0].Name != "myrepo" {
		t.Fatalf("name = %q, want myrepo", result[0].Name)
	}
	if result[0].Dir != dir {
		t.Fatalf("dir = %q, want %q", result[0].Dir, dir)
	}
}

func TestDefaultNamesAreSanitised(t *testing.T) {
	base := t.TempDir()
	dir := filepath.Join(base, "my repo")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if got, _ := ResolveRepos(RepoInput{Flags: []string{dir}}, base); got[0].Name != "my-repo" {
		t.Fatalf("name = %q, want my-repo", got[0].Name)
	}
	if got, _ := ResolveRepos(RepoInput{Flags: []string{"/"}}, base); got[0].Name != "repo" {
		t.Fatalf("root name = %q, want repo", got[0].Name)
	}
	if got, _ := ResolveRepos(RepoInput{Flags: []string{"/.plans"}}, base); got[0].Name != "repo" {
		t.Fatalf("plans name = %q, want repo", got[0].Name)
	}
}

func TestRootListsSubfoldersSortedSkippingDotFoldersAndFiles(t *testing.T) {
	base := t.TempDir()
	for _, name := range []string{"b", "a", ".hidden"} {
		if err := os.Mkdir(filepath.Join(base, name), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(base, "file.txt"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	result, _ := ResolveRepos(RepoInput{Root: base}, base)
	requireNames(t, result, []string{"a", "b"})
	requireDirs(t, result, []string{filepath.Join(base, "a"), filepath.Join(base, "b")})
}

func TestRootThatIsAPlansFolderIsOneRepoForAnyMarker(t *testing.T) {
	base := t.TempDir()
	for _, marker := range markers {
		root := filepath.Join(base, marker)
		if err := os.MkdirAll(filepath.Join(root, marker), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Mkdir(filepath.Join(root, "ignored-subfolder"), 0o755); err != nil {
			t.Fatal(err)
		}
		result, _ := ResolveRepos(RepoInput{Root: root}, base)
		requireNames(t, result, []string{marker})
		requireDirs(t, result, []string{root})
	}
}

func TestDuplicateNamesBecomeNumbered(t *testing.T) {
	base := t.TempDir()
	result, _ := ResolveRepos(RepoInput{Flags: []string{
		"dup=" + filepath.Join(base, "one"),
		"dup=" + filepath.Join(base, "two"),
		"dup=" + filepath.Join(base, "three"),
	}}, base)
	requireNames(t, result, []string{"dup", "dup-2", "dup-3"})
}

func TestMoreThanTheCapIsCutWithAMessage(t *testing.T) {
	base := t.TempDir()
	flags := make([]string, 0, MaxRepos+3)
	for i := 0; i < MaxRepos+3; i++ {
		flags = append(flags, filepath.Join(base, "r"+strconv.Itoa(i)))
	}
	result, message := ResolveRepos(RepoInput{Flags: flags}, base)
	if len(result) != MaxRepos {
		t.Fatalf("len = %d, want %d", len(result), MaxRepos)
	}
	if message == nil || *message != "3 more repos ignored (limit 24)" {
		t.Fatalf("message = %v, want 3 more repos ignored (limit 24)", message)
	}
}

func TestMissingFolderIsStillARepoAndUnreadableRootGivesNone(t *testing.T) {
	base := t.TempDir()
	missing := filepath.Join(base, "missing")
	result, _ := ResolveRepos(RepoInput{Flags: []string{missing}}, base)
	if len(result) != 1 || result[0].Name != "missing" || result[0].Dir != missing {
		t.Fatalf("repos = %v, want one missing repo", result)
	}

	unreadable, message := ResolveRepos(RepoInput{Root: filepath.Join(base, "nope")}, base)
	if len(unreadable) != 0 {
		t.Fatalf("repos = %v, want empty", unreadable)
	}
	if message != nil {
		t.Fatalf("message = %q, want nil", *message)
	}
}

func TestRelativePathsResolveAgainstTheGivenCwd(t *testing.T) {
	base := t.TempDir()
	if err := os.Mkdir(filepath.Join(base, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	result, _ := ResolveRepos(RepoInput{Flags: []string{"rel", "named=sub"}}, base)
	requireDirs(t, result, []string{filepath.Join(base, "rel"), filepath.Join(base, "sub")})
	if result[1].Name != "named" {
		t.Fatalf("second name = %q, want named", result[1].Name)
	}
}
