package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"vault-search/internal/search"
)

const version = "vault-search 0.1.0"

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

// run parses the command line, runs one search and writes the result. Exit
// codes: 0 for a result (including no hits), 1 for a runtime error and 2 for
// a usage error.
func run(args []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("vault-search", flag.ContinueOnError)
	flags.SetOutput(stderr)

	vault := flags.String("vault", "", "vault root directory")
	repo := flags.String("repo", "", "current repo slug")
	all := flags.Bool("all", false, "search every repo")
	status := flags.String("status", "active", "active or any")
	includeWork := flags.Bool("include-work", false, "also search work/")
	limit := flags.Int("limit", 5, "maximum number of results")
	asJSON := flags.Bool("json", false, "print a JSON array")
	index := flags.Bool("index", false, "reserved, not built")
	showVersion := flags.Bool("version", false, "print the version")

	if err := flags.Parse(args); err != nil {
		return 2
	}
	if *showVersion {
		fmt.Fprintln(stdout, version)
		return 0
	}
	if *index {
		fmt.Fprintln(stderr, "vault-search: --index is not built yet")
		return 2
	}
	if *status != "active" && *status != "any" {
		fmt.Fprintln(stderr, "vault-search: --status must be active or any")
		return 2
	}
	if *limit < 1 {
		fmt.Fprintln(stderr, "vault-search: --limit must be at least 1")
		return 2
	}
	if *vault == "" {
		fmt.Fprintln(stderr, "vault-search: --vault is required")
		return 2
	}

	query := strings.Join(flags.Args(), " ")
	if strings.TrimSpace(query) == "" {
		fmt.Fprintln(stderr, "vault-search: a query is required")
		return 2
	}

	hits, err := search.Run(search.Options{
		Vault:       *vault,
		Repo:        *repo,
		All:         *all,
		AnyStatus:   *status == "any",
		IncludeWork: *includeWork,
		Limit:       *limit,
	}, query)
	if err != nil {
		fmt.Fprintf(stderr, "vault-search: %v\n", err)
		return 1
	}

	if *asJSON {
		if err := writeJSON(stdout, hits); err != nil {
			fmt.Fprintf(stderr, "vault-search: %v\n", err)
			return 1
		}
		return 0
	}
	writeText(stdout, hits)
	return 0
}
