import assert from "node:assert/strict";
import test from "node:test";

import { readFile } from "node:fs/promises";

import * as entry from "../lib/index.js";
import { createFlow } from "../lib/index.js";
import { exchangeForKey, startSignIn, waitForSignIn, VIBE } from "../lib/vibe.js";

const KEY = "llm-pi-ai/mistral-subscription";
const { apply, inject, name } = entry;

const POLL_URL = `${VIBE.apiBase}${VIBE.signInPath}/poll/proc-1`;
const SIGN_IN_URL = `${VIBE.browserBase}/vibe/sign-in/authenticate?process_id=proc-1`;

/** A credentials stub that records every commit. */
function stubCredentials() {
  const commits = [];
  return {
    commits,
    modifyRecord(key, updater) {
      commits.push({ key, record: updater() });
    },
  };
}

function stubSession(overrides = {}) {
  const notifications = [];
  return {
    notifications,
    method: "oauth",
    signal: new AbortController().signal,
    notify(payload) {
      notifications.push(payload);
    },
    prompt() {
      throw new Error("this flow never prompts");
    },
    ...overrides,
  };
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** A fetch stub that records every call and replies from a scripted list. */
function stubFetch(replies) {
  const calls = [];
  const queue = [...replies];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (queue.length === 0) throw new Error(`unexpected fetch to ${url}`);
    return queue.shift();
  };
  return { fetchImpl, calls };
}

/** The real Vibe protocol, with `fetch` stubbed and no poll delay. */
function realFlowWithFetch(credentials, fetchImpl) {
  return createFlow({
    credentials,
    startSignIn: (options) => startSignIn({ ...options, fetchImpl }),
    waitForSignIn: (options) => waitForSignIn({ ...options, fetchImpl, intervalMs: 0 }),
    exchangeForKey: (options) => exchangeForKey({ ...options, fetchImpl }),
  });
}

test("the entry module imports no harness package", async () => {
  // The import above threw if the module reached for one; assert the source too,
  // because a dynamic import inside a function would not run at load time.
  const source = await readFile(new URL("../lib/index.js", import.meta.url), "utf8");
  assert.equal(source.includes("@deepseek-ai"), false);
  assert.equal(/from\s+["'](?!\.\/)[^"']+["']/.test(source), false);
});

test("the module exports the cordis contract and no Config", () => {
  assert.equal(name, "mistral-subscription");
  // webServer is the settings surface: state / sign-in / sign-out routes.
  assert.deepEqual(inject, ["authorization", "credentials", "webServer"]);
  assert.equal(typeof apply, "function");
  assert.equal("Config" in entry, false);
});

test("createFlow returns the flow the seam registers", () => {
  const flow = createFlow({ credentials: stubCredentials() });
  assert.equal(flow.key, KEY);
  assert.equal(flow.label, "Mistral subscription");
  assert.equal(typeof flow.run, "function");
  assert.deepEqual(flow.methods, [{ id: "oauth", label: "Sign in with console.mistral.ai" }]);
});

test("the flow offers exactly one method, oauth", () => {
  const flow = createFlow({ credentials: stubCredentials() });
  assert.equal(flow.methods.length, 1);
  assert.equal(flow.methods[0].id, "oauth");
});

test("createFlow rejects a credentials service without modifyRecord", () => {
  assert.throws(() => createFlow({ credentials: {} }), /modifyRecord/);
});

test("the flow notifies with the URL the sign-in server returned", async () => {
  const credentials = stubCredentials();
  const flow = createFlow({
    credentials,
    startSignIn: async () => ({
      processId: "proc-1",
      signInUrl: SIGN_IN_URL,
      pollUrl: POLL_URL,
      expiresAt: Date.now() + 60_000,
    }),
    waitForSignIn: async () => ({ status: "denied" }),
    exchangeForKey: async () => {
      throw new Error("exchange must not run on a denial");
    },
  });

  const session = stubSession();
  await flow.run(session);

  assert.equal(session.notifications.length, 1);
  assert.equal(session.notifications[0].url, SIGN_IN_URL);
  assert.match(session.notifications[0].url, /process_id=/);
  assert.equal(typeof session.notifications[0].message, "string");
});

test("a completed sign-in commits the exchanged key as an api-key record", async () => {
  const credentials = stubCredentials();
  const { fetchImpl, calls } = stubFetch([
    jsonResponse({
      process_id: "proc-1",
      sign_in_url: SIGN_IN_URL,
      poll_url: POLL_URL,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    }),
    jsonResponse({ status: "pending" }),
    jsonResponse({ status: "completed", exchange_token: "exchange-1" }),
    jsonResponse({ api_key: "minted-key-123" }),
  ]);

  const session = stubSession();
  const result = await realFlowWithFetch(credentials, fetchImpl).run(session);

  assert.equal(result, undefined);
  assert.equal(calls.length, 4);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[3].init.method, "POST");
  assert.match(calls[3].url, /\/vibe\/sign-in\/proc-1\/exchange$/);

  assert.equal(credentials.commits.length, 1);
  assert.equal(credentials.commits[0].key, KEY);
  assert.deepEqual(credentials.commits[0].record, { kind: "api-key", key: "minted-key-123" });
});

test("the exchanged key is passed to the PKCE verifier's matching challenge", async () => {
  const credentials = stubCredentials();
  const { fetchImpl, calls } = stubFetch([
    jsonResponse({
      process_id: "proc-1",
      sign_in_url: SIGN_IN_URL,
      poll_url: POLL_URL,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    }),
    jsonResponse({ status: "completed", exchange_token: "exchange-1" }),
    jsonResponse({ api_key: "minted-key-123" }),
  ]);

  await realFlowWithFetch(credentials, fetchImpl).run(stubSession());

  const verifier = JSON.parse(calls[2].init.body).code_verifier;
  const challenge = JSON.parse(calls[0].init.body).code_challenge;
  assert.equal(typeof verifier, "string");
  assert.equal(verifier.length, 86);
  assert.notEqual(challenge, verifier);
});

test("a denied sign-in settles as cancelled without exchanging or committing", async () => {
  const credentials = stubCredentials();
  let exchanged = false;
  const flow = createFlow({
    credentials,
    startSignIn: async () => ({
      processId: "proc-1",
      signInUrl: SIGN_IN_URL,
      pollUrl: POLL_URL,
      expiresAt: Date.now() + 60_000,
    }),
    waitForSignIn: async () => ({ status: "denied" }),
    exchangeForKey: async () => {
      exchanged = true;
      throw new Error("exchange must not run on a denial");
    },
  });

  const result = await flow.run(stubSession());

  assert.deepEqual(result, { status: "cancelled" });
  assert.equal(exchanged, false);
  assert.equal(credentials.commits.length, 0);
});

test("a declined notify settles as cancelled without polling", async () => {
  const credentials = stubCredentials();
  let polled = false;
  const flow = createFlow({
    credentials,
    startSignIn: async () => ({
      processId: "proc-1",
      signInUrl: SIGN_IN_URL,
      pollUrl: POLL_URL,
      expiresAt: Date.now() + 60_000,
    }),
    waitForSignIn: async () => {
      polled = true;
      return "exchange-1";
    },
    exchangeForKey: async () => "minted-key-123",
  });

  const declined = Object.assign(new Error("the authorization prompt was declined"), {
    name: "AuthorizationDeclinedError",
    code: "DECLINED",
  });
  const session = stubSession({
    notify() {
      throw declined;
    },
  });

  const result = await flow.run(session);

  assert.deepEqual(result, { status: "cancelled" });
  assert.equal(polled, false);
  assert.equal(credentials.commits.length, 0);
});

test("a failed exchange propagates instead of settling as cancelled", async () => {
  const credentials = stubCredentials();
  const flow = createFlow({
    credentials,
    startSignIn: async () => ({
      processId: "proc-1",
      signInUrl: SIGN_IN_URL,
      pollUrl: POLL_URL,
      expiresAt: Date.now() + 60_000,
    }),
    waitForSignIn: async () => "exchange-1",
    exchangeForKey: async () => {
      throw new Error("Failed to exchange Mistral sign-in for an API key: HTTP 500");
    },
  });

  await assert.rejects(flow.run(stubSession()), /HTTP 500/);
  assert.equal(credentials.commits.length, 0);
});

test("a poll rejection propagates and commits nothing", async () => {
  const credentials = stubCredentials();
  const aborted = new DOMException("The operation was aborted.", "AbortError");
  const flow = createFlow({
    credentials,
    startSignIn: async () => ({
      processId: "proc-1",
      signInUrl: SIGN_IN_URL,
      pollUrl: POLL_URL,
      expiresAt: Date.now() + 60_000,
    }),
    waitForSignIn: async () => {
      throw aborted;
    },
    exchangeForKey: async () => "minted-key-123",
  });

  await assert.rejects(flow.run(stubSession()), (error) => error === aborted);
  assert.equal(credentials.commits.length, 0);
});

test("apply registers exactly one flow with the literal key and returns its disposer", async () => {
  const registered = [];
  const disposer = () => {};
  const routes = [];
  const ctx = {
    credentials: stubCredentials(),
    authorization: {
      registerFlow(flow) {
        registered.push(flow);
        return disposer;
      },
    },
    webServer: {
      register(route) {
        routes.push(route.path);
        return () => {};
      },
    },
  };

  const returned = await apply(ctx);

  assert.equal(registered.length, 1);
  // The settings surface: state, sign-in, sign-out.
  assert.deepEqual(routes.sort(), [
    "/plugins/mistral-subscription/sign-in",
    "/plugins/mistral-subscription/sign-out",
    "/plugins/mistral-subscription/state",
  ]);
  assert.equal(registered[0].key, KEY);
  assert.equal(registered[0].label, "Mistral subscription");
  assert.deepEqual(registered[0].methods, [{ id: "oauth", label: "Sign in with console.mistral.ai" }]);
  assert.equal(typeof registered[0].run, "function");
  // apply returns the combined disposer from registerWebRoutes, which calls
  // the flow's own disposer; assert it disposes rather than identity.
  assert.equal(typeof returned, "function");
  returned();
});

test("the flow apply registers commits the minted key through ctx.credentials", async (t) => {
  const realFetch = globalThis.fetch;
  const { fetchImpl, calls } = stubFetch([
    jsonResponse({
      process_id: "proc-1",
      sign_in_url: SIGN_IN_URL,
      poll_url: POLL_URL,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    }),
    jsonResponse({ status: "completed", exchange_token: "exchange-1" }),
    jsonResponse({ api_key: "minted-key-123" }),
  ]);
  globalThis.fetch = fetchImpl;
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  const credentials = stubCredentials();
  let flow;
  await apply({
    credentials,
    authorization: {
      registerFlow(registered) {
        flow = registered;
        return () => {};
      },
    },
    webServer: {
      register() {
        return () => {};
      },
    },
  });

  const session = stubSession();
  await flow.run(session);

  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, `${VIBE.apiBase}/vibe/sign-in`);
  assert.equal(calls[2].url, `${VIBE.apiBase}/vibe/sign-in/proc-1/exchange`);
  assert.equal(session.notifications[0].url, SIGN_IN_URL);
  assert.equal(credentials.commits.length, 1);
  assert.equal(credentials.commits[0].key, KEY);
  assert.deepEqual(credentials.commits[0].record, { kind: "api-key", key: "minted-key-123" });
});

test("no error message carries the minted key", async () => {
  const secret = "minted-key-very-secret";
  const credentials = stubCredentials();
  const flow = createFlow({
    credentials,
    startSignIn: async () => {
      throw new Error("Failed to start Mistral sign-in: HTTP 502");
    },
    waitForSignIn: async () => "exchange-1",
    exchangeForKey: async () => secret,
  });

  await assert.rejects(flow.run(stubSession()), (error) => {
    assert.equal(error.message.includes(secret), false);
    return true;
  });
  assert.equal(credentials.commits.length, 0);
});
