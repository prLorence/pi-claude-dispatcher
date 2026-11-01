package search

import (
	"math"
	"sort"
	"strings"
	"unicode"
)

const (
	bm25K1            = 1.2
	bm25B             = 0.75
	weightTitle       = 3
	weightFingerprint = 3
	weightBody        = 1
)

// Tokenize lowercases s and splits it on every rune that is not a letter or
// a digit.
func Tokenize(s string) []string {
	tokens := make([]string, 0, 8)
	forEachToken(s, func(token string) {
		tokens = append(tokens, token)
	})
	return tokens
}

// forEachToken scans s without building a slice of every token, so a large
// file body never has to be materialised as tokens.
func forEachToken(s string, fn func(string)) {
	var builder strings.Builder
	flush := func() {
		if builder.Len() == 0 {
			return
		}
		fn(builder.String())
		builder.Reset()
	}
	for _, r := range s {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			builder.WriteRune(unicode.ToLower(r))
			continue
		}
		flush()
	}
	flush()
}

type docSummary struct {
	rel      string
	basename string
	typ      string
	repo     string
	status   string
	tf       map[string]int
	length   int
}

type scoredDoc struct {
	doc   docSummary
	score float64
}

// scoreDocuments ranks docs with BM25 over the query terms. Only scores above
// zero survive; ties sort by relative path so the worker order never matters.
func scoreDocuments(docs []docSummary, terms []string) []scoredDoc {
	if len(docs) == 0 {
		return nil
	}
	totalLength := 0
	docFreq := map[string]int{}
	for _, doc := range docs {
		totalLength += doc.length
		for _, term := range terms {
			if doc.tf[term] > 0 {
				docFreq[term]++
			}
		}
	}
	docCount := len(docs)
	averageLength := float64(totalLength) / float64(docCount)
	if averageLength == 0 {
		averageLength = 1
	}

	scored := make([]scoredDoc, 0, len(docs))
	for _, doc := range docs {
		score := 0.0
		length := float64(doc.length)
		for _, term := range terms {
			tf := doc.tf[term]
			if tf == 0 {
				continue
			}
			idf := math.Log(1 + (float64(docCount-docFreq[term])+0.5)/(float64(docFreq[term])+0.5))
			denominator := float64(tf) + bm25K1*(1-bm25B+bm25B*length/averageLength)
			score += idf * (float64(tf) * (bm25K1 + 1)) / denominator
		}
		if score > 0 {
			scored = append(scored, scoredDoc{doc: doc, score: score})
		}
	}

	sort.Slice(scored, func(i, j int) bool {
		if scored[i].score != scored[j].score {
			return scored[i].score > scored[j].score
		}
		return scored[i].doc.rel < scored[j].doc.rel
	})
	return scored
}
