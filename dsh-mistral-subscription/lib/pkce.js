import { createHash, randomBytes } from "node:crypto";

/**
 * Creates a PKCE code verifier: base64url of 64 random bytes, padding stripped.
 * 86 characters, inside the RFC 7636 range of 43-128.
 */
export function createVerifier() {
  return randomBytes(64).toString("base64url");
}

/**
 * Derives the S256 code challenge for a verifier: base64url(sha256(verifier)),
 * without padding.
 */
export function challengeFor(verifier) {
  if (typeof verifier !== "string" || verifier.length === 0) {
    throw new TypeError("PKCE verifier must be a non-empty string");
  }
  return createHash("sha256").update(verifier).digest("base64url");
}
