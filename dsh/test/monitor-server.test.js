import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { startServer } from "../plugins/harness-monitor/server.js";
import { assistantMsg, cleanup, ev, makePlansDir, sessionHeader, userMsg, writeEvents, writePlan, writeSession } from "../fixtures/monitor-fixture.js";

async function harness(names = ["item-a"], opts = {}) {
	const dirs = [];
	const repos = [];
	for (const name of names) {
		const dir = makePlansDir();
		dirs.push(dir);
		repos.push({ name, dir });
	}
	const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-monitor-static-"));
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-monitor-home-"));
	fs.writeFileSync(path.join(staticDir, "index.html"), "<!doctype html><html><body>monitor</body></html>");
	fs.writeFileSync(path.join(staticDir, "app.js"), "console.log(1)");
	const handle = await startServer({ repos, staticDir, port: 0, host: "127.0.0.1", pollMs: 50, home, now: () => 1792749900000 });
	return {
		base: `http://127.0.0.1:${handle.port}`,
		handle,
		dirs,
		repos,
		staticDir,
		async close() {
			await handle.stop();
			for (const dir of dirs) cleanup(dir);
			fs.rmSync(staticDir, { recursive: true, force: true });
			fs.rmSync(home, { recursive: true, force: true });
		},
	};
}

function raw(port, requestPath, host) {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: "127.0.0.1", port, path: requestPath, method: "GET", headers: { Host: host } }, (res) => {
			let text = "";
			res.on("data", (d) => (text += d));
			res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
		});
		req.on("error", reject);
		req.end();
	});
}

function snapshot(dir) {
	const out = {};
	const walk = (d) => {
		for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
			const full = path.join(d, entry.name);
			if (entry.isDirectory()) walk(full);
			else out[path.relative(dir, full)] = `${createHash("sha1").update(fs.readFileSync(full)).digest("hex")}:${fs.statSync(full).mtimeMs}`;
		}
	};
	walk(dir);
	return out;
}

test("GET /api/state shows the running plan and its lanes", async () => {
	const h = await harness();
	try {
		writePlan(h.dirs[0], "running", "p1", [{ id: "t1", pair: "review" }]);
		writeEvents(h.dirs[0], "p1", [ev("task.start", "p1", "2026-10-23T10:00:00Z", { task: "t1", attempt: 1, data: { role: "implement" } })]);
		const res = await fetch(`${h.base}/api/state`);
		assert.equal(res.status, 200);
		const state = await res.json();
		assert.equal(state.repos.length, 1);
		assert.equal(state.repos[0].active, true);
		assert.equal(state.repos[0].plan.id, "p1");
		assert.equal(state.repos[0].plan.tasks[0].pair, "review");
	} finally {
		await h.close();
	}
});

test("GET /api/state reports a missing plans folder without failing", async () => {
	const h = await harness();
	try {
		h.repos[0].dir = "/definitely/missing/plans";
		const res = await fetch(`${h.base}/api/state`);
		assert.equal(res.status, 200);
		const state = await res.json();
		assert.equal(state.repos[0].plan, null);
		assert.match(state.repos[0].message, /No plans folder/);
	} finally {
		await h.close();
	}
});

test("GET /api/session returns entries and resumes from after", async () => {
	const h = await harness();
	try {
		writeSession(h.dirs[0], "p1", "p1.t1.a1", [sessionHeader(), userMsg("hello"), assistantMsg("hi")]);
		const first = await (await fetch(`${h.base}/api/session/item-a/p1/p1.t1.a1`)).json();
		assert.equal(first.entries.length, 2);
		assert.equal(first.next, 3);
		const second = await (await fetch(`${h.base}/api/session/item-a/p1/p1.t1.a1?after=${first.next}`)).json();
		assert.equal(second.entries.length, 0);
	} finally {
		await h.close();
	}
});

test("unknown repos, bad ids and missing sessions return 400/404 without echoing", async () => {
	const h = await harness();
	try {
		assert.equal((await fetch(`${h.base}/api/session/nope/p1/p1.a1`)).status, 404);
		assert.equal((await fetch(`${h.base}/api/session/item-a/..%2F..%2Fetc/p1.a1`)).status, 400);
		assert.equal((await fetch(`${h.base}/api/session/item-a/p1/nope`)).status, 404);
		assert.equal((await fetch(`${h.base}/api/session/item-a/p1/p1.a1?after=x`)).status, 400);
		const unknown = await (await fetch(`${h.base}/api/session/nope/p1/p1.a1`)).json();
		assert.equal(unknown.error, "not found");
	} finally {
		await h.close();
	}
});

test("path traversal in a session id never reads outside the folder", async () => {
	const h = await harness();
	try {
		const res = await fetch(`${h.base}/api/session/item-a/p1/..%2F..%2F..%2Fetc%2Fpasswd`);
		assert.ok(res.status === 400 || res.status === 404);
	} finally {
		await h.close();
	}
});

test("POST is 405 and a foreign Host is 403", async () => {
	const h = await harness();
	try {
		const post = await fetch(`${h.base}/api/state`, { method: "POST" });
		assert.equal(post.status, 405);
		assert.equal(post.headers.get("allow"), "GET, HEAD");
		const forbidden = await raw(new URL(h.base).port, "/api/state", "evil.example");
		assert.equal(forbidden.status, 403);
		assert.equal(forbidden.headers["access-control-allow-origin"], undefined);
	} finally {
		await h.close();
	}
});

test("static / serves index.html and a traversal path is 404", async () => {
	const h = await harness();
	try {
		const index = await fetch(`${h.base}/`);
		assert.equal(index.status, 200);
		assert.match(await index.text(), /monitor/);
		const js = await fetch(`${h.base}/app.js`);
		assert.match(js.headers.get("content-type"), /javascript/);
		const bad = await fetch(`${h.base}/..%2F..%2Fsecret.txt`);
		assert.equal(bad.status, 404);
	} finally {
		await h.close();
	}
});

test("SSE sends hello and then change when the tree changes", async () => {
	const h = await harness();
	try {
		const controller = new AbortController();
		const killer = setTimeout(() => controller.abort(), 3000);
		const res = await fetch(`${h.base}/api/events`, { signal: controller.signal });
		assert.equal(res.status, 200);
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let text = "";
		const deadline = Date.now() + 3000;
		while (!text.includes("event: hello") && Date.now() < deadline) {
			const chunk = await reader.read();
			if (chunk.done) break;
			text += decoder.decode(chunk.value, { stream: true });
		}
		assert.match(text, /event: hello/);
		writePlan(h.dirs[0], "running", "later", [{ id: "a" }]);
		while (!text.includes("event: change") && Date.now() < deadline) {
			const chunk = await reader.read();
			if (chunk.done) break;
			text += decoder.decode(chunk.value, { stream: true });
		}
		assert.match(text, /event: change/);
		clearTimeout(killer);
		controller.abort();
		try {
			await reader.cancel();
		} catch {}
	} finally {
		await h.close();
	}
});

test("the monitor is read-only: the tree is byte-identical after every route", async () => {
	const h = await harness();
	try {
		writePlan(h.dirs[0], "running", "p1", [{ id: "t1", pair: "review" }]);
		writeEvents(h.dirs[0], "p1", [ev("task.start", "p1", "2026-10-23T10:00:00Z", { task: "t1", attempt: 1 })]);
		writeSession(h.dirs[0], "p1", "p1.t1.a1", [sessionHeader(), userMsg("hi"), assistantMsg("ok")]);
		const before = snapshot(h.dirs[0]);
		await fetch(`${h.base}/api/state`);
		await fetch(`${h.base}/api/session/item-a/p1/p1.t1.a1`);
		await fetch(`${h.base}/api/agents?scope=all`);
		await fetch(`${h.base}/`);
		await new Promise((r) => setTimeout(r, 30));
		const after = snapshot(h.dirs[0]);
		assert.deepEqual(after, before);
	} finally {
		await h.close();
	}
});
