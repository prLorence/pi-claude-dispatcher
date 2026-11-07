/**
 * Cordis plugin entry for the Mistral subscription sign-in flow.
 *
 * The flow claims the credential record `llm-pi-ai/mistral-subscription`, which
 * the `llm-pi-ai` Mistral route reads. No harness package is imported here: a
 * linked plugin cannot resolve them, so every DSH service arrives on `ctx` and
 * the flow is built through the argument-taking `createFlow` seam.
 */

import { challengeFor, createVerifier } from "./pkce.js";
import { exchangeForKey, startSignIn, waitForSignIn } from "./vibe.js";

/** Credential record this flow writes. `<scope>/<id>`, id lowercase-hyphenated. */
const FLOW_KEY = "llm-pi-ai/mistral-subscription";
const FLOW_LABEL = "Mistral subscription";
const METHOD_ID = "oauth";
const METHOD_LABEL = "Sign in with console.mistral.ai";
const NOTIFY_MESSAGE = "Continue in your browser to approve the sign-in";

/**
 * The seam's rejection when the human declines a prompt, matched by name and
 * code because its class lives in a harness package this plugin cannot import.
 */
const DECLINED_NAME = "AuthorizationDeclinedError";
const DECLINED_CODE = "DECLINED";

const CANCELLED = Object.freeze({ status: "cancelled" });

function isDeclined(error) {
  if (typeof error !== "object" || error === null) return false;
  return error.name === DECLINED_NAME || error.code === DECLINED_CODE;
}

/**
 * Builds one flow from its dependencies, so a test can supply stubs instead of
 * the network and the credential store, and `apply` can supply the real ones.
 *
 * `credentials` is the `ctx.credentials` service (it supplies `modifyRecord`).
 * `startSignIn`, `waitForSignIn` and `exchangeForKey` default to the real Vibe
 * protocol in `./vibe.js`.
 */
export function createFlow({
  key = FLOW_KEY,
  credentials,
  startSignIn: start = startSignIn,
  waitForSignIn: wait = waitForSignIn,
  exchangeForKey: exchange = exchangeForKey,
} = {}) {
  if (typeof key !== "string" || key.length === 0) {
    throw new TypeError("createFlow requires a non-empty key");
  }
  if (credentials === null || typeof credentials !== "object" || typeof credentials.modifyRecord !== "function") {
    throw new TypeError("createFlow requires a credentials service with modifyRecord()");
  }
  for (const [field, fn] of [
    ["startSignIn", start],
    ["waitForSignIn", wait],
    ["exchangeForKey", exchange],
  ]) {
    if (typeof fn !== "function") throw new TypeError(`createFlow requires a ${field} function`);
  }

  /** Runs one authorization attempt. Commits before resolving; never logs the key. */
  async function run(session) {
    const verifier = createVerifier();
    const codeChallenge = challengeFor(verifier);

    const started = await start({ codeChallenge, signal: session.signal });

    // Only this call is guarded: a declined notify is a human "no", while a
    // failed exchange or commit must still surface as an error.
    try {
      await session.notify({ message: NOTIFY_MESSAGE, url: started.signInUrl });
    } catch (error) {
      if (isDeclined(error)) return CANCELLED;
      throw error;
    }

    const polled = await wait({
      pollUrl: started.pollUrl,
      expiresAt: started.expiresAt,
      signal: session.signal,
    });
    // `waitForSignIn` yields the exchange token, or `{ status: "denied" }`.
    if (typeof polled !== "string") return CANCELLED;

    const token = await exchange({
      processId: started.processId,
      exchangeToken: polled,
      codeVerifier: verifier,
      signal: session.signal,
    });

    // `api-key` is the record shape dsh-llm-pi-ai maps to pi-ai's
    // `{ type: "api_key", key }`, which the harness auth resolver reads into the
    // Authorization header. A `grant` record would reach pi-ai as a raw payload
    // with no `type`, resolving to no auth at all.
    await credentials.modifyRecord(key, () => ({ kind: "api-key", key: token }));
  }

  return {
    key,
    label: FLOW_LABEL,
    methods: [{ id: METHOD_ID, label: METHOD_LABEL }],
    run,
  };
}

export const name = "mistral-subscription";
export const inject = ["authorization", "credentials", "webServer"];

/**
 * Registers the flow plus the settings surface (state / sign-in / sign-out
 * routes for the Client card). Returns the disposer so everything unregisters
 * with the plugin and no attempt outlives it.
 */
export async function apply(ctx, config = {}) {
  void config;
  const { registerWebRoutes } = await import("./web.js");
  return registerWebRoutes(ctx);
}
