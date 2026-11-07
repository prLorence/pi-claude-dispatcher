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
import { registerWebRoutes } from "./web.js";

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

    // The real seam wraps `notify` so it never rejects; a rejection can only
    // come from a hand-written stub or a future seam change. Keep the guard so a
    // human "no" still settles as cancelled rather than failing the attempt.
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
    const record = { kind: "api-key", key: token };

    // The exchange can outlive a cancel; writing after an abort would leave a
    // credential behind for an attempt the person was told did not happen.
    session.signal.throwIfAborted();

    // `session.commit` is the seam's guarded write: it re-checks the signal and
    // refuses a second write, so cancel-during-commit cannot report cancelled for
    // a record that landed. Call it as a method — it needs its `this`. Fall back
    // to the raw store for a session without it (older seam, tests).
    await (typeof session.commit === "function" ? session.commit(record) : credentials.modifyRecord(key, () => record));
  }

  return {
    key,
    label: FLOW_LABEL,
    methods: [{ id: METHOD_ID, label: METHOD_LABEL }],
    run,
  };
}

export const name = "mistral-subscription";
// `connection` belongs to the route-registration scope, not here: a Cordis
// `inject` entry is a hard requirement, and the sign-in flow works without the
// fence. Requiring it would make the plugin inert in compositions lacking it.
export const inject = ["authorization", "credentials"];

/**
 * Registers the flow (here, exactly once — web.js never does) plus the
 * settings surface (state / sign-in / sign-out / cancel routes for the Client
 * card), and returns ONE disposer covering flow + routes.
 *
 * The routes are scoped on `["webServer", "connection"]`: the fence reads the
 * connection service from the injected scope, and a composition without it
 * fails closed (the scope resolves nothing, so no route registers). The
 * top-level `inject` stays `["authorization", "credentials"]` — `connection`
 * must not be a hard requirement of the whole plugin.
 */
export async function apply(ctx, config = {}) {
  void config;
  const flow = createFlow({ key: FLOW_KEY, credentials: ctx.credentials });
  const disposeFlow = ctx.authorization.registerFlow(flow);
  const disposeRoutes = ctx.inject(["webServer", "connection"], (scoped) =>
    registerWebRoutes(scoped),
  );
  return () => {
    let failure;
    try {
      if (typeof disposeRoutes === "function") disposeRoutes();
    } catch (error) {
      failure ??= error;
    }
    try {
      if (typeof disposeFlow === "function") disposeFlow();
    } catch (error) {
      failure ??= error;
    }
    if (failure !== undefined) throw failure;
  };
}
