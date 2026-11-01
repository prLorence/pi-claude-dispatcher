package main

import (
	"encoding/json"
	"fmt"
	"io"

	"vault-search/internal/search"
)

// writeText prints one block per hit: a header line with the fields separated
// by " | ", then each snippet line indented by two spaces.
func writeText(w io.Writer, hits []search.Hit) {
	for _, hit := range hits {
		fmt.Fprintf(w, "%s | %s | %s | %s | %.3f\n", hit.Basename, hit.Type, hit.Repo, hit.Status, hit.Score)
		for _, line := range hit.Snippet {
			fmt.Fprintf(w, "  %s\n", line)
		}
	}
}

// writeJSON prints the hits as an indented JSON array and a trailing newline.
// A nil slice still prints [].
func writeJSON(w io.Writer, hits []search.Hit) error {
	if hits == nil {
		hits = []search.Hit{}
	}
	encoder := json.NewEncoder(w)
	encoder.SetIndent("", "  ")
	return encoder.Encode(hits)
}
