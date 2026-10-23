import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ID_RE, checkRequest, json, resolveInside, withHeaders } from "./http.ts";

function request(url: string, init: { method?: string; host?: string | null } = {}): Request {
  const headers = new Headers();
  if (init.host !== null) {
    headers.set("host", init.host ?? "127.0.0.1:4317");
  }
  return new Request(url, { method: init.method ?? "GET", headers });
}

test("checkRequest accepts allowed hosts", () => {
  for (const host of ["localhost", "localhost:4317", "127.0.0.1", "127.0.0.1:4399", "[::1]", "[::1]:4317"]) {
    expect(checkRequest(request("http://placeholder/api/state", { host }))).toBeNull();
  }
});

test("checkRequest rejects forbidden hosts", () => {
  for (const host of ["evil.example", "localhost.evil.example", "192.168.1.5:4317", "[::2]"]) {
    const res = checkRequest(request("http://placeholder/api/state", { host }));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  }
});

test("checkRequest rejects a missing Host header", () => {
  const res = checkRequest(request("http://placeholder/api/state", { host: null }));
  expect(res).not.toBeNull();
  expect(res!.status).toBe(403);
});

test("checkRequest rejects methods other than GET and HEAD", async () => {
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    const res = checkRequest(request("http://placeholder/api/state", { method }));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(405);
    expect(res!.headers.get("Allow")).toBe("GET, HEAD");
    expect(await res!.json()).toEqual({ error: "read only" });
  }
});

test("checkRequest lets GET and HEAD pass and checks the method before the host", () => {
  expect(checkRequest(request("http://placeholder/api/state", { method: "GET" }))).toBeNull();
  expect(checkRequest(request("http://placeholder/api/state", { method: "HEAD" }))).toBeNull();
  const res = checkRequest(request("http://placeholder/api/state", { method: "POST", host: "evil.example" }));
  expect(res!.status).toBe(405);
});

test("checkRequest responses carry JSON and no CORS headers", async () => {
  const res = checkRequest(request("http://placeholder/api/state", { host: "evil.example" }))!;
  expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
  expect(res.headers.get("access-control-allow-origin")).toBeNull();
  expect(await res.json()).toEqual({ error: "forbidden host" });
});

test("json sets the JSON content type and status", async () => {
  const res = json({ ok: true }, 404);
  expect(res.status).toBe(404);
  expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
  expect(await res.json()).toEqual({ ok: true });
});

test("withHeaders adds nosniff always and no-store only for api", () => {
  const api = withHeaders(json({}), true);
  expect(api.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(api.headers.get("Cache-Control")).toBe("no-store");

  const page = withHeaders(new Response("hi"), false);
  expect(page.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(page.headers.get("Cache-Control")).toBeNull();
});

test("ID_RE accepts safe ids and rejects traversal", () => {
  expect(ID_RE.test("a.b-c_d1")).toBe(true);
  expect(ID_RE.test("../x")).toBe(false);
  expect(ID_RE.test("a/b")).toBe(false);
  expect(ID_RE.test("")).toBe(false);
  expect(ID_RE.test("a b")).toBe(false);
});

test("resolveInside accepts nested paths", () => {
  const base = "/tmp/plans";
  expect(resolveInside(base, "sessions", "p1", "a.jsonl")).toBe("/tmp/plans/sessions/p1/a.jsonl");
  expect(resolveInside(base)).toBe(base);
  expect(resolveInside(base, "a", "b")).toBe("/tmp/plans/a/b");
});

test("resolveInside rejects traversal, absolute parts and sibling prefixes", () => {
  const base = "/tmp/plans";
  expect(resolveInside(base, "..", "etc")).toBeNull();
  expect(resolveInside(base, "a/../../etc")).toBeNull();
  expect(resolveInside(base, "/etc/passwd")).toBeNull();
  expect(resolveInside(base, "a\0b")).toBeNull();
  expect(resolveInside("/tmp/a", "..", "ab")).toBeNull();
});

test("resolveInside does not treat a sibling with the base as a prefix as inside", () => {
  const root = mkdtempSync(join(tmpdir(), "monitor-http-"));
  try {
    const base = join(root, "plans");
    writeFileSync(join(root, "plans-sibling"), "");
    expect(resolveInside(base, "../plans-sibling")).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
