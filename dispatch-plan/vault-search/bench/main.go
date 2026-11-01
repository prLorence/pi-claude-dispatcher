// Command bench is the vault-search benchmark. It builds the search binary,
// generates a synthetic vault, runs a fixed query set and reports latency and
// peak resident memory. It never writes outside a temp directory it removes.
package main

import (
	"bytes"
	"flag"
	"fmt"
	"io"
	"math"
	"math/rand"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	repoSlug    = "github.com/acme/app"
	seed        = 20261027
	vocabSize   = 2000
	maxQueries  = 8 // memory runs are capped so the wrapper stays cheap
	latencyGate = 50.0
	rssGateMB   = 100.0
	indexHint   = 250.0
)

var noteFolders = []struct {
	folder string
	typ    string
}{
	{"findings", "finding"},
	{"plans", "plan"},
	{"runs", "run"},
	{"specs", "spec"},
	{"decisions", "decision"},
	{"lessons", "lesson"},
	{"ideas", "idea"},
}

const nodeScript = `const fs = require("fs"), path = require("path");
const root = process.argv[1];
const words = new Set(process.argv.slice(2).map((w) => w.toLowerCase()));
let count = 0;
function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    let text;
    try { text = fs.readFileSync(full, "utf8"); } catch (err) { continue; }
    for (const token of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
      if (words.has(token)) count++;
    }
  }
}
walk(root);
console.log(count);
`

type benchResult struct {
	notes        int
	latencies    []time.Duration
	peakRSSBytes int64
	rssKnown     bool
}

func main() {
	noteCount := flag.Int("notes", 10000, "notes in the default vault")
	queryCount := flag.Int("queries", 40, "queries to run")
	gate := flag.Bool("gate", false, "run the two gated passes")
	keep := flag.Bool("keep", false, "keep the generated temp vault")
	withNode := flag.Bool("node", false, "also run a naive Node scan baseline")
	gateNotes := flag.Int("gate-notes", 1000, "notes in the latency gate vault")
	flag.Parse()

	if *noteCount < 1 || *queryCount < 1 || *gateNotes < 1 {
		fmt.Fprintln(os.Stderr, "notes, queries and gate-notes must be at least 1")
		os.Exit(2)
	}
	os.Exit(run(*noteCount, *queryCount, *gate, *keep, *withNode, *gateNotes))
}

func run(noteCount, queryCount int, gate, keep, withNode bool, gateNotes int) int {
	cwd, err := os.Getwd()
	if err != nil {
		fmt.Fprintf(os.Stderr, "benchmark: %v\n", err)
		return 1
	}
	if _, err := os.Stat(filepath.Join(cwd, "go.mod")); err != nil {
		fmt.Fprintln(os.Stderr, "run the benchmark from the vault-search module root")
		return 1
	}

	tmp, err := os.MkdirTemp("", "vault-search-bench-")
	if err != nil {
		fmt.Fprintf(os.Stderr, "benchmark: %v\n", err)
		return 1
	}
	if keep {
		fmt.Printf("vault directory: %s\n", tmp)
	} else {
		defer os.RemoveAll(tmp)
	}

	bin := filepath.Join(tmp, "vault-search")
	if err := buildBinary(cwd, bin); err != nil {
		fmt.Fprintf(os.Stderr, "benchmark: %v\n", err)
		return 1
	}

	if gate {
		return runGate(bin, tmp, gateNotes, noteCount, queryCount, withNode)
	}

	vaultDir := filepath.Join(tmp, "vault")
	result, err := measurePass(bin, vaultDir, noteCount, queryCount)
	if err != nil {
		fmt.Fprintf(os.Stderr, "benchmark: %v\n", err)
		return 1
	}
	printPass(result)
	if withNode {
		printNodeBaseline(vaultDir, queryCount)
	}
	return 0
}

func runGate(bin, tmp string, gateNotes, noteCount, queryCount int, withNode bool) int {
	failures := []string{}

	smallDir := filepath.Join(tmp, "vault-gate")
	small, err := measurePass(bin, smallDir, gateNotes, queryCount)
	if err != nil {
		fmt.Fprintf(os.Stderr, "benchmark: %v\n", err)
		return 1
	}
	printPass(small)
	if p95(small.latencies) >= latencyGate {
		failures = append(failures, fmt.Sprintf("p95 at %d notes", gateNotes))
	}

	bigDir := filepath.Join(tmp, "vault")
	big, err := measurePass(bin, bigDir, noteCount, queryCount)
	if err != nil {
		fmt.Fprintf(os.Stderr, "benchmark: %v\n", err)
		return 1
	}
	printPass(big)
	if big.rssKnown && float64(big.peakRSSBytes)/(1024*1024) >= rssGateMB {
		failures = append(failures, fmt.Sprintf("peak RSS at %d notes", noteCount))
	}
	if p95(big.latencies) > indexHint {
		fmt.Println("index recommended")
	}
	if withNode {
		printNodeBaseline(bigDir, queryCount)
	}

	if len(failures) > 0 {
		fmt.Printf("GATE FAIL %s\n", strings.Join(failures, ", "))
		return 1
	}
	fmt.Println("GATE PASS")
	return 0
}

func buildBinary(dir, output string) error {
	cmd := exec.Command("go", "build", "-o", output, ".")
	cmd.Dir = dir
	var outputBuffer bytes.Buffer
	cmd.Stdout = &outputBuffer
	cmd.Stderr = &outputBuffer
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("go build failed: %v: %s", err, strings.TrimSpace(outputBuffer.String()))
	}
	return nil
}

func measurePass(bin, vaultDir string, noteCount, queryCount int) (benchResult, error) {
	if err := generateVault(vaultDir, noteCount, rand.New(rand.NewSource(seed))); err != nil {
		return benchResult{}, fmt.Errorf("generate vault: %w", err)
	}
	queries := generateQueries(rand.New(rand.NewSource(seed+1)), vocabulary(), queryCount)

	result := benchResult{notes: noteCount}
	for _, words := range queries {
		start := time.Now()
		if err := runSearch(bin, vaultDir, words); err != nil {
			return result, err
		}
		result.latencies = append(result.latencies, time.Since(start))
	}

	memoryRuns := len(queries)
	if memoryRuns > maxQueries {
		memoryRuns = maxQueries
	}
	for i := 0; i < memoryRuns; i++ {
		peak, known, err := measurePeakRSS(bin, vaultDir, queries[i])
		if err != nil {
			return result, err
		}
		if known {
			result.rssKnown = true
			if peak > result.peakRSSBytes {
				result.peakRSSBytes = peak
			}
		}
	}
	return result, nil
}

func searchArgs(vaultDir string, words []string) []string {
	args := []string{"--vault", vaultDir, "--repo", repoSlug, "--json", "--"}
	return append(args, words...)
}

func runSearch(bin, vaultDir string, words []string) error {
	cmd := exec.Command(bin, searchArgs(vaultDir, words)...)
	var stderr bytes.Buffer
	cmd.Stdout = io.Discard
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("vault-search failed: %v: %s", err, strings.TrimSpace(stderr.String()))
	}
	return nil
}

// measurePeakRSS runs one search under the platform time tool and reads its
// peak resident size. The wrapper is used only here, never for a latency run.
func measurePeakRSS(bin, vaultDir string, words []string) (int64, bool, error) {
	var timeFlag string
	switch runtime.GOOS {
	case "darwin":
		timeFlag = "-l"
	case "linux":
		timeFlag = "-v"
	default:
		return 0, false, nil
	}
	timePath := "/usr/bin/time"
	if _, err := os.Stat(timePath); err != nil {
		return 0, false, nil
	}

	args := append([]string{timeFlag, bin}, searchArgs(vaultDir, words)...)
	cmd := exec.Command(timePath, args...)
	var stderr bytes.Buffer
	cmd.Stdout = io.Discard
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return 0, false, fmt.Errorf("memory run failed: %v: %s", err, strings.TrimSpace(stderr.String()))
	}

	for _, line := range strings.Split(stderr.String(), "\n") {
		if runtime.GOOS == "darwin" && strings.Contains(line, "maximum resident set size") {
			fields := strings.Fields(line)
			if len(fields) == 0 {
				continue
			}
			value, err := strconv.ParseInt(fields[0], 10, 64)
			if err == nil {
				return value, true, nil
			}
		}
		if runtime.GOOS == "linux" && strings.Contains(line, "Maximum resident set size (kbytes):") {
			index := strings.Index(line, ":")
			if index < 0 {
				continue
			}
			value, err := strconv.ParseInt(strings.TrimSpace(line[index+1:]), 10, 64)
			if err == nil {
				return value * 1024, true, nil
			}
		}
	}
	return 0, false, nil
}

func printPass(result benchResult) {
	median, tail := percentiles(result.latencies)
	fmt.Printf("notes: %d\n", result.notes)
	fmt.Printf("p50 ms: %.1f\n", median)
	fmt.Printf("p95 ms: %.1f\n", tail)
	if result.rssKnown {
		fmt.Printf("peak RSS MB: %.1f\n", float64(result.peakRSSBytes)/(1024*1024))
	} else {
		fmt.Println("peak RSS: unavailable")
	}
}

func printNodeBaseline(vaultDir string, queryCount int) {
	median, tail, err := nodeBaseline(vaultDir, queryCount)
	if err != nil {
		fmt.Printf("node scan baseline: unavailable (%v)\n", err)
		return
	}
	fmt.Println("node scan baseline")
	fmt.Printf("node p50 ms: %.1f\n", median)
	fmt.Printf("node p95 ms: %.1f\n", tail)
}

func nodeBaseline(vaultDir string, queryCount int) (float64, float64, error) {
	if _, err := exec.LookPath("node"); err != nil {
		return 0, 0, fmt.Errorf("node not found")
	}
	queries := generateQueries(rand.New(rand.NewSource(seed+1)), vocabulary(), queryCount)
	latencies := make([]time.Duration, 0, len(queries))
	for _, words := range queries {
		args := append([]string{"-e", nodeScript, vaultDir}, words...)
		cmd := exec.Command("node", args...)
		var stderr bytes.Buffer
		cmd.Stdout = io.Discard
		cmd.Stderr = &stderr
		start := time.Now()
		if err := cmd.Run(); err != nil {
			return 0, 0, fmt.Errorf("node scan failed: %v: %s", err, strings.TrimSpace(stderr.String()))
		}
		latencies = append(latencies, time.Since(start))
	}
	median, tail := percentiles(latencies)
	return median, tail, nil
}

func percentiles(latencies []time.Duration) (float64, float64) {
	if len(latencies) == 0 {
		return 0, 0
	}
	sorted := append([]time.Duration(nil), latencies...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	return nearestRank(sorted, 0.50), nearestRank(sorted, 0.95)
}

func p95(latencies []time.Duration) float64 {
	_, tail := percentiles(latencies)
	return tail
}

func nearestRank(sorted []time.Duration, percentile float64) float64 {
	rank := int(math.Ceil(percentile * float64(len(sorted))))
	if rank < 1 {
		rank = 1
	}
	if rank > len(sorted) {
		rank = len(sorted)
	}
	return float64(sorted[rank-1]) / float64(time.Millisecond)
}

func vocabulary() []string {
	words := make([]string, vocabSize)
	for i := range words {
		words[i] = fmt.Sprintf("pw%04d", i)
	}
	return words
}

func generateQueries(rng *rand.Rand, vocab []string, count int) [][]string {
	if count < 1 {
		count = 1
	}
	queries := make([][]string, 0, count)
	for i := 0; i < count; i++ {
		size := 2 + rng.Intn(3)
		seen := make(map[int]bool, size)
		words := make([]string, 0, size)
		for len(words) < size {
			index := rng.Intn(len(vocab))
			if seen[index] {
				continue
			}
			seen[index] = true
			words = append(words, vocab[index])
		}
		queries = append(queries, words)
	}
	return queries
}

func generateVault(dir string, noteCount int, rng *rand.Rand) error {
	vocab := vocabulary()
	for _, folder := range noteFolders {
		if err := os.MkdirAll(filepath.Join(dir, folder.folder), 0o755); err != nil {
			return err
		}
	}

	base := time.Date(2025, time.January, 1, 0, 0, 0, 0, time.UTC)
	for i := 0; i < noteCount; i++ {
		note := noteFolders[i%len(noteFolders)]
		repo := repoSlug
		if i%7 == 0 {
			repo = "-"
		}
		created := base.AddDate(0, 0, rng.Intn(400))
		updated := created.AddDate(0, 0, rng.Intn(120))

		var text strings.Builder
		fmt.Fprintf(&text, "---\ntype: %s\ncreated: %s\nupdated: %s\nrepo: %s\nstatus: %s\n---\n\n",
			note.typ,
			created.Format("2006-01-02"),
			updated.Format("2006-01-02"),
			yamlRepo(repo),
			noteStatus(note.typ, rng),
		)
		text.WriteString(buildBody(rng, vocab, 4096, 10240, true))

		name := fmt.Sprintf("%s-%05d.md", note.typ, i)
		if err := os.WriteFile(filepath.Join(dir, note.folder, name), []byte(text.String()), 0o644); err != nil {
			return err
		}
	}

	workCount := noteCount / 20
	for i := 0; i < workCount; i++ {
		folder := filepath.Join(dir, "work", fmt.Sprintf("trace-%05d", i))
		if err := os.MkdirAll(folder, 0o755); err != nil {
			return err
		}
		body := buildBody(rng, vocab, 20*1024, 100*1024, false)
		if err := os.WriteFile(filepath.Join(folder, "report.md"), []byte(body), 0o644); err != nil {
			return err
		}
	}
	return nil
}

func yamlRepo(repo string) string {
	if repo == "-" {
		return `"-"`
	}
	return repo
}

func noteStatus(typ string, rng *rand.Rand) string {
	switch typ {
	case "finding":
		if rng.Intn(5) == 0 {
			return "closed"
		}
		return "open"
	case "decision", "lesson":
		if rng.Intn(8) == 0 {
			return "superseded"
		}
		return "active"
	default:
		return "active"
	}
}

func buildBody(rng *rand.Rand, vocab []string, minBytes, maxBytes int, withTitle bool) string {
	target := minBytes + rng.Intn(maxBytes-minBytes+1)
	var text strings.Builder
	text.Grow(target + 128)
	if withTitle {
		words := 6 + rng.Intn(7)
		for i := 0; i < words; i++ {
			if i > 0 {
				text.WriteByte(' ')
			}
			text.WriteString(vocab[rng.Intn(len(vocab))])
		}
		text.WriteString("\n\n")
	}
	for text.Len() < target {
		text.WriteString(vocab[rng.Intn(len(vocab))])
		text.WriteByte(' ')
	}
	return text.String()
}
