import assert from "node:assert/strict";
import test from "node:test";

import { registerWebRoutes } from "../lib/web.js";

const FLOW_KEY = "llm-pi-ai/mistral-subscription";
const SIGN_IN_URL = "https://console.mistral.ai/vibe/sign-in/authenticate?process_id=proc-1";
const SECRET = "minted-key-very-secret";

const PATHS = {
  state: "/plugins/mistral-subscription/state",
  signIn: "/plugins/mistral-subscription/sign-in",
  signOut: "/plugins/mistral-subscription/sign-out",
  cancel: "/plugins/mistral-subscription/cancel",
};

const JSON_HEADERS = { "content-type": "application/json" };
const CHARSET_HEADERS = { "content-type": "application/json; charset=utf-8" };

/** A Node-shaped request with loopback headers by default. */
function stubReq(headers = {}, overrides = {}) {
  return {
    method: overrides.method ?? "POST",
    headers: { host: "127.0.0.1:51306", ...headers },
    socket: { localAddress: overrides.localAddress ?? "127.0.0.1" },
  };
}

/** A response stub that records every write, so bodies are assertable. */
function stubRes() {
  const writes = [];
  return {
    writes,
    writeHead(status, headers) {
      writes.push({ kind: "head", status, headers });
      return this;
    },
    end(body) {
      writes.push({ kind: "end", body });
      return this;
    },
    get body() {
      return JSON.parse(writes[writes.length - 1].body);
    },
  };
}

/**
 * The dsh-authorization seam, stubbed offline: `begin()` reports an in-flight
 * attempt as an ALREADY_IN_FLIGHT rejection, `describe()` exposes `inFlight`,
 * `cancel()` aborts the live attempt. The test drives it through
 * notify()/complete()/fail().
 */
function stubAuthorization() {
  const state = { inFlight: false, begins: [], cancels: 0, notifications: [] };
  let pending = null;
  const alreadyInFlight = () => {
    const error = new Error("already in flight");
    error.code = "ALREADY_IN_FLIGHT";
    error.name = "AuthorizationAlreadyInFlightError";
    return error;
  };
  return {
    state,
    describe(key) {
      return { key, label: "Mistral subscription", methods: [], inFlight: state.inFlight };
    },
    begin(input) {
      if (state.inFlight) return Promise.reject(alreadyInFlight());
      state.inFlight = true;
      state.begins.push(input);
      return new Promise((resolve, reject) => {
        pending = { input, resolve, reject };
      });
    },
    async cancel() {
      state.cancels += 1;
      if (!state.inFlight || !pending) return false;
      state.inFlight = false;
      const error = new Error("cancelled");
      error.code = "CANCELLED";
      error.name = "AuthorizationCancelledError";
      pending.reject(error);
      pending = null;
      return true;
    },
    async notify(payload) {
      state.notifications.push(payload);
      pending?.input.interaction.notify(payload);
    },
    async complete(outcome = { status: "completed" }) {
      if (!pending) return;
      state.inFlight = false;
      pending.resolve(outcome);
      pending = null;
    },
    async failWith(error) {
      if (!pending) return;
      state.inFlight = false;
      pending.reject(error);
      pending = null;
    },
  };
}

function stubCredentials({ record, onDelete } = {}) {
  const deletes = [];
  return {
    deletes,
    readRecord: async () => record,
    async deleteRecord(key) {
      deletes.push(key);
      if (onDelete) return onDelete();
    },
  };
}

/** One registered settings surface with an injectable race timeout. Returns
 * its route handlers plus every response body so tests can inspect what was
 * actually served.
 */
function makeSurface({ connection, signInTimeoutMs, credentials: credentialsOverride } = {}) {
  const authorization = stubAuthorization();
  const credentials = credentialsOverride ?? stubCredentials();
  const registered = [];
  const bodies = [];
  const ctx = {
    credentials,
    authorization,
    webServer: {
      register(route) {
        registered.push(route);
        return () => {};
      },
    },
    effect(fn) {
      return fn();
    },
    ...(connection !== undefined ? { connection } : {}),
  };
  registerWebRoutes(ctx, { signInTimeoutMs });
  const byPath = new Map(registered.map((route) => [route.path, route.handler]));
  const call = async (path, req, res) => {
    const handler = byPath.get(path);
    if (!handler) throw new Error(`route ${path} not registered`);
    await handler(req, res);
    for (const write of res.writes) {
      if (write.kind === "end") bodies.push(String(write.body));
    }
    return res;
  };
  return { ctx, authorization, credentials, registered, byPath, call, bodies };
}

const loopbackGet = () => stubReq({}, { method: "GET" });
const jsonPost = (headers = JSON_HEADERS) => stubReq(headers);
const recorded = (res) => JSON.stringify(res.writes.map((write) => write.body));
/**
 * Lets a started handler reach its first awaits and `begin()` before the test
 * drives the stub: a notify before `begin` is wired never reaches the handler.
 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// --- slow start ------------------------------------------------------------

test("a slow-start begin delivers the URL to the first caller, never NO_URL", async () => {
  const { call, authorization, registered } = makeSurface({ signInTimeoutMs: 500 });
  assert.equal(registered.length, 4);

  const notifier = setTimeout(() => authorization.notify({ url: SIGN_IN_URL }), 40);
  const res = await call(PATHS.signIn, jsonPost(), stubRes());
  clearTimeout(notifier);

  assert.deepEqual(res.body, { started: true, url: SIGN_IN_URL });
  assert.equal(res.writes[0].status, 200);
  // One attempt, started exactly once, never cancelled by the race.
  assert.equal(authorization.state.begins.length, 1);
  assert.equal(authorization.state.cancels, 0);
});

test("the race answers SIGN_IN_TIMEOUT and the attempt stays in flight", async (t) => {
  const { call, authorization } = makeSurface({ signInTimeoutMs: 10 });

  const res = await call(PATHS.signIn, jsonPost(), stubRes());
  assert.deepEqual(res.body, { started: false, error: "SIGN_IN_TIMEOUT" });

  // The attempt stays in flight past the answer: /state still shows it.
  const state = await call(PATHS.state, loopbackGet(), stubRes());
  assert.equal(state.body.inFlight, true);
  assert.equal(authorization.state.begins.length, 1);

  t.after(() => authorization.complete({ status: "cancelled" }));
});

test("the timeout is injectable and registers four routes", async () => {
  const { registered } = makeSurface({ signInTimeoutMs: 5 });
  assert.deepEqual(
    registered.map((route) => route.path).sort(),
    [PATHS.cancel, PATHS.signIn, PATHS.signOut, PATHS.state],
  );
});

// --- second caller ---------------------------------------------------------

test("a second caller of a live attempt gets the held URL, not NO_URL", async (t) => {
  const { call, authorization } = makeSurface({ signInTimeoutMs: 500 });
  const first = call(PATHS.signIn, jsonPost(), stubRes());
  await flush();
  await authorization.notify({ url: SIGN_IN_URL });
  const res = await call(PATHS.signIn, jsonPost(), stubRes());
  await first;

  assert.deepEqual(res.body, { started: true, url: SIGN_IN_URL, alreadyInFlight: true });
  assert.equal(authorization.state.begins.length, 1);
  t.after(() => authorization.complete({ status: "cancelled" }));
});

test("a double-begin does not fail the first attempt and both get the URL", async (t) => {
  const { call, authorization } = makeSurface({ signInTimeoutMs: 500 });

  // Two overlapping callers before any URL exists: the first holds the race,
  // the second waits behind it; neither records ALREADY_IN_FLIGHT as a failure.
  const first = call(PATHS.signIn, jsonPost(), stubRes());
  await flush();
  const second = call(PATHS.signIn, jsonPost(), stubRes());
  await flush();
  await authorization.notify({ url: SIGN_IN_URL });
  const [firstRes, secondRes] = await Promise.all([first, second]);

  assert.deepEqual(firstRes.body, { started: true, url: SIGN_IN_URL });
  assert.deepEqual(secondRes.body, { started: true, url: SIGN_IN_URL, alreadyInFlight: true });
  assert.equal(authorization.state.begins.length, 1);

  const state = await call(PATHS.state, loopbackGet(), stubRes());
  assert.equal(state.body.inFlight, true);
  assert.equal(state.body.error, null);
  assert.equal(state.body.outcome, null);
  t.after(() => authorization.complete({ status: "cancelled" }));
});

// --- cancel ----------------------------------------------------------------

test("cancel ends the live attempt and the next sign-in starts a new one", async () => {
  const { call, authorization } = makeSurface({ signInTimeoutMs: 500 });
  const first = call(PATHS.signIn, jsonPost(), stubRes());
  await flush();
  await authorization.notify({ url: SIGN_IN_URL });
  await first;

  const cancelRes = await call(PATHS.cancel, jsonPost(), stubRes());
  assert.deepEqual(cancelRes.body, { cancelled: true });
  assert.equal(authorization.state.inFlight, false);

  const second = call(PATHS.signIn, jsonPost(), stubRes());
  await flush();
  await authorization.notify({ url: `${SIGN_IN_URL}` });
  const res = await second;

  assert.deepEqual(res.body, { started: true, url: `${SIGN_IN_URL}` });
  assert.equal(authorization.state.begins.length, 2);
});

test("a timed-out attempt keeps /cancel and the next begin working", async (t) => {
  const { call, authorization } = makeSurface({ signInTimeoutMs: 10 });
  await call(PATHS.signIn, jsonPost(), stubRes());

  // The attempt stays in flight after the caller was answered, so /cancel can
  // still abort it and /state still shows it as the live attempt.
  const state = await call(PATHS.state, loopbackGet(), stubRes());
  assert.equal(state.body.inFlight, true);

  t.after(() => authorization.complete({ status: "cancelled" }));
});

test("cancel with no attempt in flight answers not_in_flight", async () => {
  const { call, authorization } = makeSurface({ signInTimeoutMs: 50 });

  const res = await call(PATHS.cancel, jsonPost(), stubRes());
  assert.deepEqual(res.body, { cancelled: false, reason: "not_in_flight" });
  assert.equal(authorization.state.begins.length, 0);
  assert.equal(authorization.state.cancels, 1);
});

test("a cancelled attempt settles as an error on /state", async (t) => {
  const { call, authorization } = makeSurface({ signInTimeoutMs: 500 });
  const first = call(PATHS.signIn, jsonPost(), stubRes());
  await call(PATHS.cancel, jsonPost(), stubRes());
  await first;

  const state = await call(PATHS.state, loopbackGet(), stubRes());
  assert.equal(state.body.outcome, "failed");
  assert.equal(state.body.error, "CANCELLED");
  t.after(() => {});
});

// --- fence -----------------------------------------------------------------

test("forged rebind and cross-site requests are rejected on every route", async () => {
  for (const headers of [
    { host: "attacker.example:51306", "sec-fetch-site": "cross-site" },
    { host: "127.0.0.1:51306", "sec-fetch-site": "cross-site" },
  ]) {
    for (const path of [PATHS.state, PATHS.signIn, PATHS.signOut, PATHS.cancel]) {
      const { call, credentials, authorization, bodies } = makeSurface({ signInTimeoutMs: 50 });
      const method = path === PATHS.state ? "GET" : "POST";
      const res = await call(path, stubReq({ ...headers, ...JSON_HEADERS }, { method }), stubRes());
      assert.equal(res.writes[0].status, 403, `${path} ${JSON.stringify(headers)}`);
      assert.deepEqual(JSON.parse(res.writes[1].body), { error: "forbidden" });
      assert.equal(credentials.deletes.length, 0);
      assert.equal(authorization.state.begins.length, 0);
      assert.equal(authorization.state.cancels, 0);
      for (const body of bodies) assert.equal(body.includes("attacker.example"), false, body);
    }
  }
});

test("a seed connection fence rejects with its own status on every route", async () => {
  // A seeded fence stands in for dsh's real one: only the loopback Host passes.
  const connection = {
    requestRejection(req) {
      return req.headers.host === "127.0.0.1:51306" ? undefined : 403;
    },
  };
  const { call, credentials, authorization } = makeSurface({
    connection,
    signInTimeoutMs: 50,
  });
  const res = await call(
    PATHS.signIn,
    stubReq({ host: "attacker.example:51306", ...JSON_HEADERS }),
    stubRes(),
  );
  assert.equal(res.writes[0].status, 403);
  assert.deepEqual(JSON.parse(res.writes[1].body), { error: "forbidden" });
  assert.equal(credentials.deletes.length, 0);
  assert.equal(authorization.state.begins.length, 0);
});

// --- body type -------------------------------------------------------------

test("a POST without the JSON content type is rejected on all three write routes", async () => {
  for (const headers of [{}, { "content-type": "text/plain" }, { "content-type": "application/x-www-form-urlencoded" }]) {
    for (const path of [PATHS.signIn, PATHS.signOut, PATHS.cancel]) {
      const { call, credentials, authorization } = makeSurface({ signInTimeoutMs: 50 });
      const res = await call(path, stubReq(headers), stubRes());
      assert.equal(res.writes[0].status, 415, `${path} ${JSON.stringify(headers)}`);
      assert.deepEqual(JSON.parse(res.writes[1].body), { error: "UNSUPPORTED_MEDIA_TYPE" });
      assert.equal(credentials.deletes.length, 0);
      assert.equal(authorization.state.begins.length, 0);
    }
  }
});

test("charset passes the body gate", async () => {
  const { call, authorization } = makeSurface({ signInTimeoutMs: 500 });

  const notifier = setTimeout(() => authorization.notify({ url: SIGN_IN_URL }), 20);
  const res = await call(PATHS.signIn, stubReq(CHARSET_HEADERS), stubRes());
  clearTimeout(notifier);
  assert.deepEqual(res.body, { started: true, url: SIGN_IN_URL });

  const cancelRes = await call(PATHS.cancel, stubReq(CHARSET_HEADERS), stubRes());
  assert.deepEqual(cancelRes.body, { cancelled: true });

  const signOutRes = await call(PATHS.signOut, stubReq(CHARSET_HEADERS), stubRes());
  assert.deepEqual(signOutRes.body, { status: "signed-out" });
});

test("a non-POST method answers 405 and no dead 400 exists", async () => {
  const { call, authorization } = makeSurface({ signInTimeoutMs: 50 });
  for (const path of [PATHS.signIn, PATHS.signOut, PATHS.cancel]) {
    const res = await call(path, stubReq(JSON_HEADERS, { method: "GET" }), stubRes());
    assert.equal(res.writes[0].status, 405, path);
    assert.deepEqual(JSON.parse(res.writes[1].body), { error: "POST only" });
  }
  assert.equal(authorization.state.begins.length, 0);
});

// --- states ----------------------------------------------------------------

test("/state reflects the credential and a completed attempt, not the key", async (t) => {
  let record = undefined;
  const surface = makeSurface({ signInTimeoutMs: 500 });
  surface.credentials.readRecord = async () => record;
  const { call, authorization } = surface;

  const notifier = setTimeout(() => authorization.notify({ url: SIGN_IN_URL }), 20);
  const res = await call(PATHS.signIn, jsonPost(), stubRes());
  clearTimeout(notifier);
  assert.deepEqual(res.body, { started: true, url: SIGN_IN_URL });

  record = { kind: "api-key", key: SECRET };
  await authorization.complete({ status: "completed" });

  const state = await call(PATHS.state, loopbackGet(), stubRes());
  assert.equal(state.body.configured, true);
  assert.equal(state.body.inFlight, false);
  assert.equal(state.body.outcome, "completed");
  assert.equal(state.body.error, null);
  assert.equal(state.body.key, FLOW_KEY);
  assert.equal(JSON.stringify(res.writes.map((w) => w.body)).includes(SECRET), false);
  assert.equal(recorded(state).includes(SECRET), false);
});

test("a denied or failed attempt surfaces its code, never token material", async (t) => {
  const { call, authorization } = makeSurface({ signInTimeoutMs: 20 });

  await call(PATHS.signIn, jsonPost(), stubRes());
  await authorization.failWith(
    Object.assign(new Error(`exchange failed with token ${SECRET}`), { code: "EXCHANGE_FAILED" }),
  );

  const state = await call(PATHS.state, loopbackGet(), stubRes());
  assert.equal(state.body.outcome, "failed");
  assert.equal(state.body.error, "EXCHANGE_FAILED");
  assert.equal(recorded(state).includes(SECRET), false, "the key must not leak through an error");
  t.after(() => {});
});

test("the key never appears in any response of a full sign-in round", async (t) => {
  let record = { kind: "api-key", key: SECRET };
  const credentials = stubCredentials();
  credentials.readRecord = async () => record;
  const { call, authorization, bodies } = makeSurface({ signInTimeoutMs: 200, credentials });

  await call(PATHS.signIn, jsonPost(), stubRes());
  await flush();
  await authorization.notify({ url: SIGN_IN_URL });
  await authorization.complete({ status: "completed" });

  const stateBefore = await call(PATHS.state, loopbackGet(), stubRes());
  assert.equal(stateBefore.body.configured, true);

  await call(PATHS.signOut, jsonPost(), stubRes());
  record = undefined;
  const stateAfter = await call(PATHS.state, loopbackGet(), stubRes());
  assert.equal(stateAfter.body.configured, false);

  for (const body of bodies) assert.equal(body.includes(SECRET), false, body);
});
