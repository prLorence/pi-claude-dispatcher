/**
 * Vibe Code browser sign-in protocol, ported from the OMP extension
 * `omp-mistral-subscription`. Endpoints, paths and cadence come from that
 * extension; this module adds argument validation and abort plumbing.
 */

/** Origin and endpoints of the Mistral console sign-in service. */
export const VIBE = Object.freeze({
  apiBase: "https://console.mistral.ai/api",
  browserBase: "https://console.mistral.ai",
  signInPath: "/vibe/sign-in",
  pollIntervalMs: 3000,
});

const SIGN_IN_ENDPOINT = `${VIBE.apiBase}${VIBE.signInPath}`;

const START_FAILED = "Failed to start Mistral sign-in";
const POLL_FAILED = "Mistral sign-in status unavailable";
const EXCHANGE_FAILED = "Failed to exchange Mistral sign-in for an API key";

const STATUSES = new Set(["pending", "completed", "expired", "denied", "error"]);

function requireString(value, field, message) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${message}: "${field}" must be a non-empty string`);
  }
  return value;
}

function requireFiniteNumber(value, field, message) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${message}: "${field}" must be a finite number`);
  }
  return value;
}

/** Reject as soon as the owning flow aborts, before any further work. */
function checkAborted(signal) {
  signal?.throwIfAborted();
}

/** Narrow a decoded JSON body at the network boundary, once per response. */
function asRecord(value, message) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${message}: malformed JSON response`);
  }
  return value;
}

function requiredString(record, field, message) {
  const value = record[field];
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error(`${message}: response is missing "${field}"`);
}

/**
 * Reject any URL the sign-in server returns outside its own origin. Without
 * this, a tampered reply could send the browser somewhere else.
 */
function assertUnder(value, baseUrl, field, message) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${message}: "${field}" is not an absolute URL`);
  }
  const base = new URL(baseUrl);
  const basePath = base.pathname.replace(/\/$/, "");
  const pathMatches = basePath === "" || url.pathname === basePath || url.pathname.startsWith(`${basePath}/`);
  if (url.origin !== base.origin || !pathMatches) {
    throw new Error(`${message}: "${field}" is not under ${baseUrl}`);
  }
  return value;
}

/**
 * Read a response body, failing with the endpoint and status code only.
 * The parse error is deliberately not attached as a cause: a JSON parser's
 * message can quote the input, and the input may hold token material.
 */
async function readJson(response, endpoint, message) {
  if (!response.ok) throw new Error(`${message}: HTTP ${response.status} from ${endpoint}`);
  try {
    return await response.json();
  } catch {
    throw new Error(`${message}: malformed JSON response from ${endpoint}`);
  }
}

function abortError(signal) {
  return signal?.reason ?? new DOMException("Mistral sign-in aborted", "AbortError");
}

/** Abortable sleep, so a poll interval never outlives a cancelled attempt. */
function sleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Starts a sign-in process. Returns the four fields the server issued; the
 * exchange token is not part of this reply and arrives on the poll.
 */
export async function startSignIn({ codeChallenge, fetchImpl = fetch, signal } = {}) {
  requireString(codeChallenge, "codeChallenge", START_FAILED);
  checkAborted(signal);

  const response = await fetchImpl(SIGN_IN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code_challenge: codeChallenge, code_challenge_method: "S256" }),
    signal,
  });
  checkAborted(signal);

  const payload = asRecord(await readJson(response, SIGN_IN_ENDPOINT, START_FAILED), START_FAILED);

  const expiresAt = Date.parse(requiredString(payload, "expires_at", START_FAILED));
  if (!Number.isFinite(expiresAt)) throw new Error(`${START_FAILED}: invalid "expires_at"`);

  return {
    processId: requiredString(payload, "process_id", START_FAILED),
    signInUrl: assertUnder(
      requiredString(payload, "sign_in_url", START_FAILED),
      VIBE.browserBase,
      "sign_in_url",
      START_FAILED,
    ),
    pollUrl: assertUnder(requiredString(payload, "poll_url", START_FAILED), VIBE.apiBase, "poll_url", START_FAILED),
    expiresAt,
  };
}

/** Reads one poll of a sign-in process. A 410 means the process has expired. */
export async function pollSignIn({ pollUrl, fetchImpl = fetch, signal } = {}) {
  requireString(pollUrl, "pollUrl", POLL_FAILED);
  checkAborted(signal);

  const endpoint = assertUnder(pollUrl, VIBE.apiBase, "poll_url", POLL_FAILED);
  const response = await fetchImpl(endpoint, { signal });
  if (response.status === 410) return { status: "expired" };
  checkAborted(signal);

  const payload = asRecord(await readJson(response, endpoint, POLL_FAILED), POLL_FAILED);
  const status = payload.status;
  if (!STATUSES.has(status)) throw new Error(`${POLL_FAILED}: unknown status from ${endpoint}`);

  const result = { status };
  const exchangeToken = payload.exchange_token;
  if (typeof exchangeToken === "string" && exchangeToken.length > 0) result.exchangeToken = exchangeToken;
  const message = payload.message;
  if (typeof message === "string" && message.length > 0) result.message = message;
  return result;
}

/**
 * Polls at the server's cadence until a terminal state. Returns the exchange
 * token on "completed", `{ status: "denied" }` on a denial (a normal outcome the
 * caller settles as cancelled), and throws on expiry, error or the deadline.
 */
export async function waitForSignIn({
  pollUrl,
  expiresAt,
  fetchImpl = fetch,
  signal,
  intervalMs = VIBE.pollIntervalMs,
} = {}) {
  requireString(pollUrl, "pollUrl", POLL_FAILED);
  requireFiniteNumber(expiresAt, "expiresAt", POLL_FAILED);
  requireFiniteNumber(intervalMs, "intervalMs", POLL_FAILED);
  if (intervalMs < 0) throw new TypeError(`${POLL_FAILED}: "intervalMs" must not be negative`);

  for (;;) {
    checkAborted(signal);
    if (Date.now() >= expiresAt) throw new Error("Mistral sign-in timed out");

    const result = await pollSignIn({ pollUrl, fetchImpl, signal });
    switch (result.status) {
      case "pending":
        await sleep(intervalMs, signal);
        break;
      case "completed":
        if (result.exchangeToken) return result.exchangeToken;
        throw new Error("Mistral sign-in completed without an exchange token");
      case "denied":
        return { status: "denied" };
      case "expired":
        throw new Error("Mistral sign-in expired, start the sign-in again");
      case "error":
        // Server prose only, never token material.
        throw new Error(result.message ?? "Mistral sign-in failed");
    }
  }
}

/** Exchanges a completed sign-in plus the PKCE verifier for an API key. */
export async function exchangeForKey({ processId, exchangeToken, codeVerifier, fetchImpl = fetch, signal } = {}) {
  requireString(processId, "processId", EXCHANGE_FAILED);
  requireString(exchangeToken, "exchangeToken", EXCHANGE_FAILED);
  requireString(codeVerifier, "codeVerifier", EXCHANGE_FAILED);
  checkAborted(signal);

  const endpoint = `${SIGN_IN_ENDPOINT}/${encodeURIComponent(processId)}/exchange`;
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ exchange_token: exchangeToken, code_verifier: codeVerifier }),
    signal,
  });
  checkAborted(signal);

  const payload = asRecord(await readJson(response, endpoint, EXCHANGE_FAILED), EXCHANGE_FAILED);
  return requiredString(payload, "api_key", EXCHANGE_FAILED);
}
