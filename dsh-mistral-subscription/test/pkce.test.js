import assert from "node:assert/strict";
import test from "node:test";

import { challengeFor, createVerifier } from "../lib/pkce.js";

test("createVerifier returns base64url within the allowed length", () => {
  const verifier = createVerifier();
  assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/);
});

test("createVerifier returns a fresh verifier each call", () => {
  assert.notEqual(createVerifier(), createVerifier());
});

test("challengeFor matches the RFC 7636 appendix B vector", () => {
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  assert.equal(challengeFor(verifier), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});

test("challengeFor rejects non-string and empty verifiers", () => {
  assert.throws(() => challengeFor(""), TypeError);
  assert.throws(() => challengeFor(null), TypeError);
  assert.throws(() => challengeFor(42), TypeError);
});
