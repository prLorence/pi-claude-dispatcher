import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkRequest, json, resolveInside, withHeaders, ID_RE } from "../plugins/harness-monitor/http.js";

test("checkRequest accepts loopback hosts and GET/HEAD", () => {
	for (const host of ["localhost", "127.0.0.1:4317", "[::1]:80"]) assert.equal(checkRequest({ method: "GET", headers: { host } }), null);
	assert.equal(checkRequest({ method: "HEAD", headers: { host: "127.0.0.1" } }), null);
});

test("checkRequest rejects a missing or foreign host and non-GET methods", () => {
	assert.equal(checkRequest({ method: "GET", headers: {} }).status, 403);
	assert.equal(checkRequest({ method: "GET", headers: { host: "evil.example" } }).status, 403);
	const post = checkRequest({ method: "POST", headers: { host: "127.0.0.1" } });
	assert.equal(post.status, 405);
	assert.equal(post.allow, "GET, HEAD");
});

test("json and withHeaders set the expected headers and no CORS", () => {
	const out = withHeaders(json({ ok: true }), true);
	assert.equal(out.status, 200);
	assert.match(out.headers["content-type"], /application\/json/);
	assert.equal(out.headers["X-Content-Type-Options"], "nosniff");
	assert.equal(out.headers["Cache-Control"], "no-store");
	assert.equal(out.headers["Access-Control-Allow-Origin"], undefined);
	assert.equal(withHeaders(json({}), false).headers["Cache-Control"], undefined);
});

test("resolveInside rejects traversal and absolute parts", () => {
	const base = "/tmp/base";
	assert.equal(resolveInside(base, "a", "b"), "/tmp/base/a/b");
	assert.equal(resolveInside(base, "..", "etc"), null);
	assert.equal(resolveInside(base, "a/../../etc"), null);
	assert.equal(resolveInside(base, "/etc"), null);
	assert.equal(resolveInside(base, "a\0b"), null);
});

test("ID_RE only accepts safe ids", () => {
	assert.equal(ID_RE.test("20261023-0958-pair-r1"), true);
	assert.equal(ID_RE.test("../etc"), false);
	assert.equal(ID_RE.test("a/b"), false);
});
