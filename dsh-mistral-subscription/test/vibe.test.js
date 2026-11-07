import assert from "node:assert/strict";
import test from "node:test";

import { exchangeForKey, pollSignIn, startSignIn, waitForSignIn, VIBE } from "../lib/vibe.js";

const SIGN_IN_ENDPOINT = `${VIBE.apiBase}${VIBE.signInPath}`;
const POLL_URL = `${VIBE.apiBase}${VIBE.signInPath}/poll/abc`;

/** A fetch stub that records every call and replies from a scripted list. */
function stubFetch(replies) {
  const calls = [];
  const queue = [...replies];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (queue.length === 0) throw new Error(`unexpected fetch to ${url}`);
    const next = queue.shift();
    return typeof next === "function" ? next() : next;
  };
  return { fetchImpl, calls };
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function startReply(overrides = {}) {
  return jsonResponse({
    process_id: "proc-1",
    sign_in_url: `${VIBE.browserBase}/vibe/sign-in/abc`,
    poll_url: POLL_URL,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  });
}

function sleepFor(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("VIBE constants match the console.mistral.ai sign-in surface", () => {
  assert.equal(VIBE.apiBase, "https://console.mistral.ai/api");
  assert.equal(VIBE.browserBase, "https://console.mistral.ai");
  assert.equal(VIBE.signInPath, "/vibe/sign-in");
  assert.equal(VIBE.pollIntervalMs, 3000);
});

test("startSignIn posts the S256 challenge and returns the four fields", async () => {
  const { fetchImpl, calls } = stubFetch([startReply()]);
  const result = await startSignIn({ codeChallenge: "challenge-abc", fetchImpl });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${VIBE.apiBase}/vibe/sign-in`);
  assert.equal(calls[0].init.method, "POST");

  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body, { code_challenge: "challenge-abc", code_challenge_method: "S256" });
  assert.deepEqual(Object.keys(body).sort(), ["code_challenge", "code_challenge_method"]);

  assert.equal(result.processId, "proc-1");
  assert.equal(result.signInUrl, `${VIBE.browserBase}/vibe/sign-in/abc`);
  assert.equal(result.pollUrl, POLL_URL);
  assert.equal(typeof result.expiresAt, "number");
  assert.ok(result.expiresAt > Date.now());
  assert.equal("exchangeToken" in result, false);
});

test("startSignIn rejects a sign_in_url off the console origin", async () => {
  const { fetchImpl } = stubFetch([startReply({ sign_in_url: "https://evil.example/vibe/sign-in" })]);
  await assert.rejects(startSignIn({ codeChallenge: "c", fetchImpl }), (error) => {
    assert.match(error.message, /sign_in_url/);
    return true;
  });
});

test("startSignIn rejects a poll_url outside /api", async () => {
  const { fetchImpl } = stubFetch([startReply({ poll_url: `${VIBE.browserBase}/vibe/sign-in/poll/abc` })]);
  await assert.rejects(startSignIn({ codeChallenge: "c", fetchImpl }), (error) => {
    assert.match(error.message, /poll_url/);
    return true;
  });
});

test("startSignIn rejects a sibling path that merely shares the /api prefix", async () => {
  const { fetchImpl } = stubFetch([startReply({ poll_url: `${VIBE.browserBase}/api-evil/poll` })]);
  await assert.rejects(startSignIn({ codeChallenge: "c", fetchImpl }), /poll_url/);
});

test("startSignIn rejects a missing field and an unparseable expires_at", async () => {
  const missing = stubFetch([startReply({ process_id: undefined })]);
  await assert.rejects(startSignIn({ codeChallenge: "c", fetchImpl: missing.fetchImpl }), /process_id/);

  const badDate = stubFetch([startReply({ expires_at: "not-a-date" })]);
  await assert.rejects(startSignIn({ codeChallenge: "c", fetchImpl: badDate.fetchImpl }), /expires_at/);
});

test("startSignIn requires a code challenge", async () => {
  await assert.rejects(startSignIn({}), TypeError);
  await assert.rejects(startSignIn({ codeChallenge: "" }), TypeError);
  await assert.rejects(startSignIn(), TypeError);
});

test("startSignIn surfaces the status code without the reply body", async () => {
  const { fetchImpl } = stubFetch([jsonResponse({ exchange_token: "exchange-secret-do-not-leak" }, 502)]);
  await assert.rejects(startSignIn({ codeChallenge: "c", fetchImpl }), (error) => {
    assert.match(error.message, /502/);
    assert.doesNotMatch(error.message, /exchange-secret-do-not-leak/);
    return true;
  });
});

test("pollSignIn maps 410 to expired", async () => {
  const { fetchImpl, calls } = stubFetch([jsonResponse({}, 410)]);
  assert.deepEqual(await pollSignIn({ pollUrl: POLL_URL, fetchImpl }), { status: "expired" });
  assert.equal(calls[0].url, POLL_URL);
});

test("pollSignIn returns the exchange token on completion", async () => {
  const { fetchImpl } = stubFetch([jsonResponse({ status: "completed", exchange_token: "exchange-xyz" })]);
  assert.deepEqual(await pollSignIn({ pollUrl: POLL_URL, fetchImpl }), {
    status: "completed",
    exchangeToken: "exchange-xyz",
  });
});

test("pollSignIn omits an empty exchange token and surfaces the server message", async () => {
  const { fetchImpl } = stubFetch([jsonResponse({ status: "pending", exchange_token: "", message: "waiting" })]);
  assert.deepEqual(await pollSignIn({ pollUrl: POLL_URL, fetchImpl }), { status: "pending", message: "waiting" });
});

test("pollSignIn throws on an unknown status", async () => {
  const { fetchImpl } = stubFetch([jsonResponse({ status: "signed-in" })]);
  await assert.rejects(pollSignIn({ pollUrl: POLL_URL, fetchImpl }), /unknown status/);
});

test("pollSignIn rejects a poll_url off the api origin", async () => {
  const { fetchImpl } = stubFetch([jsonResponse({ status: "pending" })]);
  await assert.rejects(pollSignIn({ pollUrl: "https://evil.example/api/poll", fetchImpl }), /poll_url/);
});

test("pollSignIn requires a poll URL", async () => {
  await assert.rejects(pollSignIn(), TypeError);
  await assert.rejects(pollSignIn({}), TypeError);
});

test("waitForSignIn polls past pending and returns the token on completed", async () => {
  const { fetchImpl, calls } = stubFetch([
    jsonResponse({ status: "pending" }),
    jsonResponse({ status: "pending" }),
    jsonResponse({ status: "completed", exchange_token: "exchange-xyz" }),
  ]);
  const token = await waitForSignIn({ pollUrl: POLL_URL, expiresAt: Date.now() + 60_000, fetchImpl, intervalMs: 0 });

  assert.equal(token, "exchange-xyz");
  assert.equal(calls.length, 3);
});

test("waitForSignIn settles denied without throwing", async () => {
  const { fetchImpl, calls } = stubFetch([jsonResponse({ status: "denied" })]);
  assert.deepEqual(
    await waitForSignIn({ pollUrl: POLL_URL, expiresAt: Date.now() + 60_000, fetchImpl, intervalMs: 0 }),
    { status: "denied" },
  );
  assert.equal(calls.length, 1);
});

test("waitForSignIn throws on expired", async () => {
  const { fetchImpl } = stubFetch([jsonResponse({ status: "expired" })]);
  await assert.rejects(
    waitForSignIn({ pollUrl: POLL_URL, expiresAt: Date.now() + 60_000, fetchImpl, intervalMs: 0 }),
    /expired/,
  );
});

test("waitForSignIn throws when completed arrives without an exchange token", async () => {
  const { fetchImpl } = stubFetch([jsonResponse({ status: "completed" })]);
  await assert.rejects(
    waitForSignIn({ pollUrl: POLL_URL, expiresAt: Date.now() + 60_000, fetchImpl, intervalMs: 0 }),
    /without an exchange token/,
  );
});

test("waitForSignIn surfaces the server message on error", async () => {
  const { fetchImpl } = stubFetch([jsonResponse({ status: "error", message: "quota mismatch" })]);
  await assert.rejects(
    waitForSignIn({ pollUrl: POLL_URL, expiresAt: Date.now() + 60_000, fetchImpl, intervalMs: 0 }),
    /quota mismatch/,
  );
});

test("waitForSignIn throws when the deadline has passed", async () => {
  const { fetchImpl, calls } = stubFetch([]);
  await assert.rejects(
    waitForSignIn({ pollUrl: POLL_URL, expiresAt: Date.now() - 1, fetchImpl, intervalMs: 0 }),
    /timed out/,
  );
  assert.equal(calls.length, 0);
});

test("waitForSignIn rejects when the signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  const { fetchImpl, calls } = stubFetch([]);
  await assert.rejects(
    waitForSignIn({
      pollUrl: POLL_URL,
      expiresAt: Date.now() + 60_000,
      fetchImpl,
      signal: controller.signal,
      intervalMs: 0,
    }),
    (error) => error.name === "AbortError",
  );
  assert.equal(calls.length, 0);
});

test("waitForSignIn rejects promptly when aborted mid wait", async () => {
  const controller = new AbortController();
  const { fetchImpl } = stubFetch([jsonResponse({ status: "pending" })]);
  const pending = waitForSignIn({
    pollUrl: POLL_URL,
    expiresAt: Date.now() + 60_000,
    fetchImpl,
    signal: controller.signal,
    intervalMs: 60_000,
  });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, (error) => error.name === "AbortError");
});

test("waitForSignIn waits the server cadence by default, not zero", async () => {
  const controller = new AbortController();
  const { fetchImpl, calls } = stubFetch([jsonResponse({ status: "pending" })]);
  const pending = waitForSignIn({
    pollUrl: POLL_URL,
    expiresAt: Date.now() + 60_000,
    fetchImpl,
    signal: controller.signal,
  });

  const outcome = await Promise.race([
    pending.then(() => "settled", () => "settled"),
    sleepFor(30).then(() => "waiting"),
  ]);
  assert.equal(outcome, "waiting");
  assert.equal(calls.length, 1);

  controller.abort();
  await assert.rejects(pending, (error) => error.name === "AbortError");
});

test("waitForSignIn requires a poll URL and a deadline", async () => {
  await assert.rejects(waitForSignIn(), TypeError);
  await assert.rejects(waitForSignIn({ expiresAt: Date.now() + 1000 }), TypeError);
  await assert.rejects(waitForSignIn({ pollUrl: POLL_URL }), TypeError);
});

test("exchangeForKey posts the exact exchange body and returns the key", async () => {
  const { fetchImpl, calls } = stubFetch([jsonResponse({ api_key: "sk-minted-key" })]);
  const key = await exchangeForKey({
    processId: "proc-1",
    exchangeToken: "exchange-xyz",
    codeVerifier: "verifier-abc",
    fetchImpl,
  });

  assert.equal(key, "sk-minted-key");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${VIBE.apiBase}/vibe/sign-in/proc-1/exchange`);
  assert.equal(calls[0].init.method, "POST");

  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body, { exchange_token: "exchange-xyz", code_verifier: "verifier-abc" });
  assert.deepEqual(Object.keys(body).sort(), ["code_verifier", "exchange_token"]);
});

test("exchangeForKey requires the reply to carry an api_key", async () => {
  const { fetchImpl } = stubFetch([jsonResponse({ access_token: "something" })]);
  await assert.rejects(
    exchangeForKey({ processId: "p", exchangeToken: "t", codeVerifier: "v", fetchImpl }),
    /api_key/,
  );
});

test("exchangeForKey reports the status code and never the token or key", async () => {
  const exchangeToken = "exchange-secret-do-not-leak";
  const { fetchImpl } = stubFetch([
    jsonResponse({ exchange_token: exchangeToken, api_key: "sk-secret-do-not-leak" }, 500),
  ]);

  await assert.rejects(
    exchangeForKey({ processId: "proc-1", exchangeToken, codeVerifier: "verifier-abc", fetchImpl }),
    (error) => {
      assert.match(error.message, /500/);
      assert.doesNotMatch(error.message, /exchange-secret-do-not-leak/);
      assert.doesNotMatch(error.message, /sk-secret-do-not-leak/);
      return true;
    },
  );
});

test("pollSignIn reports the endpoint and status without echoing the body", async () => {
  const { fetchImpl } = stubFetch([jsonResponse({ exchange_token: "exchange-secret-do-not-leak" }, 503)]);
  await assert.rejects(pollSignIn({ pollUrl: POLL_URL, fetchImpl }), (error) => {
    assert.match(error.message, /503/);
    assert.match(error.message, /console\.mistral\.ai/);
    assert.doesNotMatch(error.message, /exchange-secret-do-not-leak/);
    return true;
  });
});

test("exchangeForKey requires every argument", async () => {
  await assert.rejects(exchangeForKey({ exchangeToken: "t", codeVerifier: "v" }), TypeError);
  await assert.rejects(exchangeForKey({ processId: "p", codeVerifier: "v" }), TypeError);
  await assert.rejects(exchangeForKey({ processId: "p", exchangeToken: "t" }), TypeError);
});

test("every entry point rejects a pre-aborted signal without fetching", async () => {
  const controller = new AbortController();
  controller.abort();
  const { fetchImpl, calls } = stubFetch([]);

  await assert.rejects(startSignIn({ codeChallenge: "c", fetchImpl, signal: controller.signal }));
  await assert.rejects(pollSignIn({ pollUrl: POLL_URL, fetchImpl, signal: controller.signal }));
  await assert.rejects(
    exchangeForKey({
      processId: "p",
      exchangeToken: "t",
      codeVerifier: "v",
      fetchImpl,
      signal: controller.signal,
    }),
  );
  assert.equal(calls.length, 0);
});

test("the sign-in endpoint is built from the verified constants", () => {
  assert.equal(SIGN_IN_ENDPOINT, "https://console.mistral.ai/api/vibe/sign-in");
});
