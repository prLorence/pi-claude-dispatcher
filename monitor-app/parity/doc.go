// Package parity holds the golden-file parity check of the Go monitor port.
//
// The TypeScript server in monitor/ is the oracle: the fixtures and the golden
// JSON under testdata/ were produced by it, and parity_test.go rebuilds each
// fixture tree in a temporary folder from the manifest and compares the Go
// state and session pages with those files. The package has no production
// code; it exists so the parity check lives in its own buildable package.
package parity
