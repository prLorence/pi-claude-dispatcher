package search

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

const (
	defaultLimit        = 5
	defaultMaxFileBytes = 262144
	maxWorkers          = 4
	snippetMaxLines     = 2
	snippetMaxRunes     = 160
)

var typeFolders = []struct {
	folder string
	typ    string
}{
	{"plans", "plan"},
	{"runs", "run"},
	{"findings", "finding"},
	{"decisions", "decision"},
	{"lessons", "lesson"},
	{"projects", "project"},
	{"codebases", "codebase"},
	{"specs", "spec"},
	{"ideas", "idea"},
}

var workExtensions = map[string]bool{
	".md":    true,
	".json":  true,
	".jsonl": true,
	".txt":   true,
}

// Options configures one search.
type Options struct {
	Vault        string
	Repo         string
	All          bool
	AnyStatus    bool
	IncludeWork  bool
	Limit        int
	MaxFileBytes int64
}

// Hit is one ranked result.
type Hit struct {
	Basename string   `json:"basename"`
	Type     string   `json:"type"`
	Repo     string   `json:"repo"`
	Status   string   `json:"status"`
	Path     string   `json:"path"`
	Score    float64  `json:"score"`
	Snippet  []string `json:"snippet"`
}

type job struct {
	path     string
	rel      string
	basename string
	typ      string
	title    string
	work     bool
}

type scanResult struct {
	doc docSummary
	ok  bool
}

// Run ranks the notes in opts.Vault against query. It never writes.
func Run(opts Options, query string) ([]Hit, error) {
	if opts.Vault == "" {
		return nil, errors.New("vault is required")
	}
	info, err := os.Stat(opts.Vault)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("vault is not a directory: %s", opts.Vault)
	}

	queryTerms := dedupe(Tokenize(query))
	if len(queryTerms) == 0 {
		return nil, errors.New("query has no searchable words")
	}
	if opts.Limit == 0 {
		opts.Limit = defaultLimit
	}
	if opts.Limit < 0 {
		return nil, errors.New("limit must not be negative")
	}
	if opts.MaxFileBytes == 0 {
		opts.MaxFileBytes = defaultMaxFileBytes
	}
	if opts.MaxFileBytes < 0 {
		return nil, errors.New("max file size must not be negative")
	}

	querySet := make(map[string]bool, len(queryTerms))
	for _, term := range queryTerms {
		querySet[term] = true
	}

	docs := scanJobs(opts, collectJobs(opts), querySet)
	scored := scoreDocuments(docs, queryTerms)

	limit := opts.Limit
	if limit > len(scored) {
		limit = len(scored)
	}
	hits := make([]Hit, 0, limit)
	for _, entry := range scored[:limit] {
		repo := entry.doc.repo
		if repo == "" {
			repo = "-"
		}
		status := entry.doc.status
		if status == "" {
			status = "-"
		}
		hits = append(hits, Hit{
			Basename: entry.doc.basename,
			Type:     entry.doc.typ,
			Repo:     repo,
			Status:   status,
			Path:     entry.doc.rel,
			Score:    entry.score,
			Snippet:  snippetFor(opts.Vault, entry.doc, querySet),
		})
	}
	return hits, nil
}

func dedupe(tokens []string) []string {
	seen := make(map[string]bool, len(tokens))
	out := make([]string, 0, len(tokens))
	for _, token := range tokens {
		if seen[token] {
			continue
		}
		seen[token] = true
		out = append(out, token)
	}
	return out
}

func collectJobs(opts Options) []job {
	jobs := make([]job, 0, 32)
	for _, folder := range typeFolders {
		dir := filepath.Join(opts.Vault, folder.folder)
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			name := entry.Name()
			if strings.HasPrefix(name, ".") || !strings.HasSuffix(name, ".md") {
				continue
			}
			if !entry.Type().IsRegular() {
				continue
			}
			jobs = append(jobs, job{
				path:     filepath.Join(dir, name),
				rel:      filepath.ToSlash(filepath.Join(folder.folder, name)),
				basename: strings.TrimSuffix(name, ".md"),
				typ:      folder.typ,
			})
		}
	}
	if !opts.IncludeWork {
		return jobs
	}

	workRoot := filepath.Join(opts.Vault, "work")
	_ = filepath.WalkDir(workRoot, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return nil
		}
		if entry.Type()&fs.ModeSymlink != 0 || !entry.Type().IsRegular() {
			return nil
		}
		if !workExtensions[strings.ToLower(filepath.Ext(path))] {
			return nil
		}
		rel, relErr := filepath.Rel(opts.Vault, path)
		if relErr != nil {
			return nil
		}
		base := filepath.Base(path)
		jobs = append(jobs, job{
			path:  path,
			rel:   filepath.ToSlash(rel),
			title: strings.TrimSuffix(base, filepath.Ext(base)),
			typ:   "work",
			work:  true,
		})
		return nil
	})
	return jobs
}

func scanJobs(opts Options, jobs []job, querySet map[string]bool) []docSummary {
	if len(jobs) == 0 {
		return nil
	}
	workers := maxWorkers
	if len(jobs) < workers {
		workers = len(jobs)
	}
	jobCh := make(chan job)
	resultCh := make(chan scanResult)

	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for item := range jobCh {
				resultCh <- scanOne(opts, item, querySet)
			}
		}()
	}
	go func() {
		for _, item := range jobs {
			jobCh <- item
		}
		close(jobCh)
		wg.Wait()
		close(resultCh)
	}()

	docs := make([]docSummary, 0, len(jobs))
	for result := range resultCh {
		if result.ok {
			docs = append(docs, result.doc)
		}
	}
	return docs
}

func scanOne(opts Options, item job, querySet map[string]bool) scanResult {
	info, err := os.Lstat(item.path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > opts.MaxFileBytes {
		return scanResult{}
	}
	data, err := os.ReadFile(item.path)
	if err != nil {
		return scanResult{}
	}
	text := string(data)

	if item.work {
		title := item.title
		doc := buildDoc(item.rel, item.rel, "work", "-", "-", title, "", text, querySet)
		return scanResult{doc: doc, ok: true}
	}

	props, lists, body, ok := parseFrontmatter(text)
	if !ok {
		return scanResult{}
	}
	// parseFrontmatter hands back substrings of the file text, and a substring
	// keeps that whole text alive. Clone the three values the summary keeps so
	// each scanned note's text can be collected; measured with bench -gate at
	// 10000 notes on macOS arm64, peak RSS fell from 127.9 MB to 22.6 MB.
	repo := strings.Clone(props["repo"])
	status := strings.Clone(props["status"])
	typ := strings.Clone(props["type"])
	if typ == "" {
		typ = item.typ
	}
	repos, hasRepos := lists["repos"]
	if !inScope(opts, repo, repos, hasRepos) {
		return scanResult{}
	}
	if !opts.AnyStatus && !IsActive(status) {
		return scanResult{}
	}

	title := noteTitle(item.basename, body)
	doc := buildDoc(item.rel, item.basename, typ, repo, status, title, props["fingerprint"], body, querySet)
	return scanResult{doc: doc, ok: true}
}

func buildDoc(rel, basename, typ, repo, status, title, fingerprint, body string, querySet map[string]bool) docSummary {
	tf := map[string]int{}
	length := 0
	addText := func(text string, weight int) {
		forEachToken(text, func(token string) {
			length += weight
			if querySet[token] {
				tf[token] += weight
			}
		})
	}
	if title != "" {
		addText(title, weightTitle)
	}
	if fingerprint != "" {
		addText(fingerprint, weightFingerprint)
	}
	addText(body, weightBody)
	return docSummary{
		rel:      rel,
		basename: basename,
		typ:      typ,
		repo:     repo,
		status:   status,
		tf:       tf,
		length:   length,
	}
}

// noteTitle is the basename plus the first non-empty body line without its
// leading heading markers.
func noteTitle(basename, body string) string {
	for _, raw := range strings.Split(body, "\n") {
		line := strings.TrimSpace(strings.TrimSuffix(raw, "\r"))
		if line == "" {
			continue
		}
		line = strings.TrimSpace(strings.TrimLeft(line, "#"))
		if line == "" {
			continue
		}
		return basename + "\n" + line
	}
	return basename
}

func snippetFor(vault string, doc docSummary, querySet map[string]bool) []string {
	data, err := os.ReadFile(filepath.Join(vault, filepath.FromSlash(doc.rel)))
	if err != nil {
		return []string{}
	}
	body := string(data)
	if doc.typ != "work" {
		_, _, parsedBody, ok := parseFrontmatter(body)
		if !ok {
			return []string{}
		}
		body = parsedBody
	}
	return makeSnippet(body, querySet)
}

func makeSnippet(body string, querySet map[string]bool) []string {
	type candidate struct {
		index int
		count int
		text  string
	}
	candidates := make([]candidate, 0, 4)
	firstLine := ""
	for index, raw := range strings.Split(body, "\n") {
		line := strings.TrimSpace(strings.TrimSuffix(raw, "\r"))
		if line == "" {
			continue
		}
		if firstLine == "" {
			firstLine = line
		}
		matched := map[string]bool{}
		forEachToken(line, func(token string) {
			if querySet[token] {
				matched[token] = true
			}
		})
		if len(matched) > 0 {
			candidates = append(candidates, candidate{index: index, count: len(matched), text: line})
		}
	}

	if len(candidates) == 0 {
		if firstLine == "" {
			return []string{}
		}
		return []string{cutRunes(firstLine, snippetMaxRunes)}
	}

	sort.SliceStable(candidates, func(i, j int) bool {
		if candidates[i].count != candidates[j].count {
			return candidates[i].count > candidates[j].count
		}
		return candidates[i].index < candidates[j].index
	})
	if len(candidates) > snippetMaxLines {
		candidates = candidates[:snippetMaxLines]
	}
	sort.Slice(candidates, func(i, j int) bool {
		return candidates[i].index < candidates[j].index
	})

	snippet := make([]string, 0, len(candidates))
	for _, item := range candidates {
		snippet = append(snippet, cutRunes(item.text, snippetMaxRunes))
	}
	return snippet
}

func cutRunes(s string, limit int) string {
	runes := []rune(s)
	if len(runes) <= limit {
		return s
	}
	return string(runes[:limit])
}
