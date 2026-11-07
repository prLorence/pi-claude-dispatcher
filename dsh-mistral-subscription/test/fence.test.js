import assert from "node:assert/strict";
import test from "node:test";

import { fenceRequest } from "../lib/fence.js";

/** A Node-shaped request: lowercase header names, a socket with its local address. */
function stubReq(headers = {}, localAddress = "127.0.0.1") {
  return { method: "POST", headers, socket: { localAddress } };
}

/** A response stub that records each write, so "exactly one response" is checkable. */
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
  };
}

const LOOPBACK_HOST = { host: "127.0.0.1:51306" };

/** Records every call, so a test can prove the fallback never ran. */
function stubConnection(reply) {
  const calls = [];
  return {
    calls,
    requestRejection(req) {
      calls.push(req);
      if (typeof reply === "function") return reply.call(this, req);
      return reply;
    },
  };
}

// --- Host -----------------------------------------------------------------

test("a rebound Host is rejected", () => {
  const res = stubRes();
  const rejected = fenceRequest(
    {},
    stubReq({ host: "attacker.example:51306", "sec-fetch-site": "same-origin" }),
    res,
  );

  assert.equal(rejected, true);
  assert.equal(res.writes.length, 2);
  assert.equal(res.writes[0].status, 403);
  assert.equal(res.writes[0].headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(res.writes[1].body), { error: "forbidden" });
});

test("a loopback Host is admitted", () => {
  const res = stubRes();
  assert.equal(fenceRequest({}, stubReq(LOOPBACK_HOST), res), false);
  assert.deepEqual(res.writes, []);
});

test("localhost and IPv6 loopback Hosts are admitted", () => {
  for (const host of ["localhost:51306", "[::1]:51306"]) {
    const res = stubRes();
    assert.equal(fenceRequest({}, stubReq({ host }), res), false, host);
  }
});

test("a Host naming the socket's own bind address is admitted", () => {
  const res = stubRes();
  const req = stubReq({ host: "192.168.1.5:51306" }, "192.168.1.5");
  assert.equal(fenceRequest({}, req, res), false);
  assert.deepEqual(res.writes, []);
});

test("the bind address is matched in normalized form", () => {
  const res = stubRes();
  const req = stubReq({ host: "[::ffff:127.0.0.1]:51306" }, "::ffff:127.0.0.1");
  assert.equal(fenceRequest({}, req, res), false);
});

test("a missing or unparsable Host is rejected", () => {
  for (const headers of [{}, { host: "" }, { host: "at tacker:51306" }]) {
    const res = stubRes();
    assert.equal(fenceRequest({}, stubReq(headers), res), true, JSON.stringify(headers));
    assert.equal(res.writes[0].status, 403);
  }
});

// --- browser markers ------------------------------------------------------

test("a cross-site Sec-Fetch-Site is rejected", () => {
  const res = stubRes();
  const rejected = fenceRequest({}, stubReq({ ...LOOPBACK_HOST, "sec-fetch-site": "cross-site" }), res);
  assert.equal(rejected, true);
  assert.equal(res.writes[0].status, 403);
});

test("a same-origin Origin is admitted", () => {
  const res = stubRes();
  const req = stubReq({ ...LOOPBACK_HOST, origin: "http://127.0.0.1:51306", "sec-fetch-site": "same-origin" });
  assert.equal(fenceRequest({}, req, res), false);
  assert.deepEqual(res.writes, []);
});

test("an absent Origin with same-origin Sec-Fetch-Site is admitted", () => {
  const res = stubRes();
  const req = stubReq({ ...LOOPBACK_HOST, "sec-fetch-site": "same-origin" });
  assert.equal(fenceRequest({}, req, res), false);
  assert.deepEqual(res.writes, []);
});

test("a request with no browser markers and a loopback Host is admitted", () => {
  const res = stubRes();
  assert.equal(fenceRequest({}, stubReq(LOOPBACK_HOST), res), false);
});

test("a cross-authority Origin is rejected", () => {
  for (const origin of ["http://attacker.example", "http://127.0.0.1:51307", "null", "not a url"]) {
    const res = stubRes();
    const rejected = fenceRequest({}, stubReq({ ...LOOPBACK_HOST, origin }), res);
    assert.equal(rejected, true, origin);
    assert.equal(res.writes[0].status, 403);
  }
});

test("an Origin on the Host's own authority is admitted regardless of scheme", () => {
  // Matches the shipped fence (dsh-client-connection `isSameAuthorityOrigin`):
  // an HTTPS reverse proxy in front of the listener yields an https Origin
  // with the same authority.
  const res = stubRes();
  assert.equal(fenceRequest({}, stubReq({ ...LOOPBACK_HOST, origin: "https://127.0.0.1:51306" }), res), false);
  assert.deepEqual(res.writes, []);
});

// --- repeated headers -----------------------------------------------------

test("a repeated browser marker is rejected instead of read as absent", () => {
  // Node delivers a repeated header as an array. Absent Origin and absent
  // sec-fetch-site both mean admit, so an unread shape must fail closed.
  for (const headers of [
    { ...LOOPBACK_HOST, "sec-fetch-site": ["cross-site", "same-origin"] },
    { ...LOOPBACK_HOST, "sec-fetch-site": ["same-origin", "cross-site"] },
    { ...LOOPBACK_HOST, origin: ["http://127.0.0.1:51306", "http://attacker.example"] },
    { host: ["127.0.0.1:51306", "attacker.example"] },
  ]) {
    const res = stubRes();
    const rejected = fenceRequest({}, stubReq(headers), res);
    assert.equal(rejected, true, JSON.stringify(headers));
    assert.equal(res.writes[0].status, 403);
  }
});

test("a repeated non-fence header still passes the fence", () => {
  // Headers the fence does not read are the route's business, not its own.
  const res = stubRes();
  assert.equal(fenceRequest({}, stubReq({ ...LOOPBACK_HOST, cookie: ["a=1", "b=2"] }), res), false);
  assert.deepEqual(res.writes, []);
});

// --- the connection path --------------------------------------------------

test("a connection fence that passes admits a request the fallback would reject", () => {
  const connection = stubConnection(undefined);
  const res = stubRes();
  // A forged Host and a cross-site marker: only the connection service can
  // admit this, so an admitted request proves the fallback never ran.
  const req = stubReq({ host: "attacker.example:51306", "sec-fetch-site": "cross-site" });

  assert.equal(fenceRequest({ connection }, req, res), false);
  assert.equal(connection.calls.length, 1);
  assert.equal(connection.calls[0], req);
  assert.deepEqual(res.writes, []);
});

test("the connection service is called as a method", () => {
  const connection = {
    calls: 0,
    requestRejection() {
      this.calls += 1;
      return undefined;
    },
  };
  const res = stubRes();

  assert.equal(fenceRequest({ connection }, stubReq(LOOPBACK_HOST), res), false);
  assert.equal(connection.calls, 1);
});

test("a connection fence returning 403 rejects with 403", () => {
  const connection = stubConnection(403);
  const res = stubRes();

  assert.equal(fenceRequest({ connection }, stubReq(LOOPBACK_HOST), res), true);
  assert.equal(connection.calls.length, 1);
  assert.equal(res.writes.length, 2);
  assert.equal(res.writes[0].status, 403);
  assert.equal(res.writes[0].headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(res.writes[1].body), { error: "forbidden" });
});

test("a connection fence returning 401 rejects with 401", () => {
  const res = stubRes();
  assert.equal(fenceRequest({ connection: stubConnection(401) }, stubReq(LOOPBACK_HOST), res), true);
  assert.equal(res.writes[0].status, 401);
  assert.deepEqual(JSON.parse(res.writes[1].body), { error: "unauthenticated" });
});

test("a connection fence that throws rejects with 403 and fails closed", () => {
  const connection = stubConnection(() => {
    throw new Error("fence unavailable");
  });
  const res = stubRes();

  assert.equal(fenceRequest({ connection }, stubReq(LOOPBACK_HOST), res), true);
  assert.equal(connection.calls.length, 1);
  assert.equal(res.writes.length, 2);
  assert.equal(res.writes[0].status, 403);
  assert.deepEqual(JSON.parse(res.writes[1].body), { error: "forbidden" });
});

test("a connection fence returning an unknown shape fails closed", () => {
  const res = stubRes();
  assert.equal(fenceRequest({ connection: stubConnection({ rejection: 200 }) }, stubReq(LOOPBACK_HOST), res), true);
  assert.equal(res.writes[0].status, 403);
});

test("a connection service without requestRejection falls back", () => {
  for (const connection of [{}, { requestRejection: undefined }, null]) {
    const res = stubRes();
    const rejected = fenceRequest({ connection }, stubReq({ host: "attacker.example:51306" }), res);
    assert.equal(rejected, true);
    assert.equal(res.writes[0].status, 403);
  }
});

test("a fence ctx without connection takes the fallback", () => {
  for (const deps of [{}, { connection: undefined }]) {
    const res = stubRes();
    assert.equal(fenceRequest(deps, stubReq(LOOPBACK_HOST), res), false);
    assert.deepEqual(res.writes, []);
  }
});

// --- shape of a refusal ---------------------------------------------------

test("a rejection writes exactly one response", () => {
  for (const [deps, req] of [
    [{}, stubReq({ host: "attacker.example:51306" })],
    [{ connection: stubConnection(403) }, stubReq(LOOPBACK_HOST)],
    [
      {
        connection: {
          requestRejection() {
            throw new Error("boom");
          },
        },
      },
      stubReq(LOOPBACK_HOST),
    ],
  ]) {
    const res = stubRes();
    assert.equal(fenceRequest(deps, req, res), true);
    assert.equal(res.writes.filter((w) => w.kind === "head").length, 1);
    assert.equal(res.writes.filter((w) => w.kind === "end").length, 1);
  }
});

test("no refusal body carries request header material", () => {
  const res = stubRes();
  const req = stubReq({ host: "attacker.example:51306", cookie: "dsh-auth-secret-value" });
  fenceRequest({}, req, res);
  const body = res.writes[1].body;
  assert.equal(body.includes("attacker.example"), false);
  assert.equal(body.includes("dsh-auth-secret-value"), false);
});
