import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { MonitorState, SessionPage } from "../shared/types.ts";
import type { RepoConfig } from "./repos.ts";
import { startServer, type ServerHandle } from "./server.ts";
import {
  assistantMsg,
  cleanup,
  ev,
  makePlansDir,
  modelChange,
  sessionHeader,
  textPart,
  userMsg,
  writeEvents,
  writePlan,
  writeSession,
} from "../../test/fixture.ts";

const TS = "2026-10-22T18-02-28-549Z";

interface Harness {
  base: string;
  handle: ServerHandle;
  dirs: string[];
  repos: RepoConfig[];
  staticDir: string;
}

function harness(
  opts: { pollMs?: number; names?: string[]; message?: string | null } = {},
): Harness {
  const dirs: string[] = [];
  const repos: RepoConfig[] = [];
  for (const name of opts.names ?? ["item-a"]) {
    const dir = makePlansDir();
    dirs.push(dir);
    repos.push({ name, dir });
  }
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-monitor-static-"));
  fs.writeFileSync(
    path.join(staticDir, "index.html"),
    "<!doctype html><html><body>monitor</body></html>",
  );
  const handle = startServer({
    repos,
    staticDir,
    port: 0,
    host: "127.0.0.1",
    pollMs: opts.pollMs ?? 500,
    message: opts.message ?? null,
  });
  return { base: `http://127.0.0.1:${handle.port}`, handle, dirs, repos, staticDir };
}

function close(h: Harness): void {
  h.handle.stop();
  for (const dir of h.dirs) {
    cleanup(dir);
  }
  fs.rmSync(h.staticDir, { recursive: true, force: true });
}

function rawRequest(port: number, requestPath: string, host: string): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let text = "";
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      socket.destroy();
      resolvePromise(text);
    };
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`GET ${requestPath} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    });
    socket.on("data", (chunk: string) => {
      text += chunk;
    });
    socket.on("end", finish);
    socket.on("error", reject);
    timer = setTimeout(finish, 3000);
  });
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  needle: string,
  buffer: { text: string },
): Promise<boolean> {
  const decoder = new TextDecoder();
  const deadline = Date.now() + 5000;
  while (!buffer.text.includes(needle)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return false;
    }
    const result = await Promise.race([
      reader.read(),
      new Promise<null>((resolvePromise) => setTimeout(() => resolvePromise(null), remaining)),
    ]);
    if (result === null || result.done === true) {
      return false;
    }
    buffer.text += decoder.decode(result.value, { stream: true });
  }
  return true;
}

test("GET /api/state shows the running plan of one repo", async () => {
  const h = harness();
  try {
    writePlan(h.dirs[0], "running", "p1", [{ id: "t1", pair: "review" }]);
    writeEvents(h.dirs[0], "p1", [
      ev("task.start", "p1", TS, { task: "t1", attempt: 1, data: { role: "implement" } }),
    ]);

    const res = await fetch(`${h.base}/api/state`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as MonitorState;
    expect(body.message).toBeNull();
    expect(body.repos.length).toBe(1);
    expect(body.repos[0].name).toBe("item-a");
    expect(body.repos[0].active).toBe(true);
    const plan = body.repos[0].plan;
    expect(plan).not.toBeNull();
    expect(plan?.id).toBe("p1");
    expect(plan?.trace).toBe("p1");
    expect(plan?.state).toBe("running");
    expect(plan?.total).toBe(1);
    expect(plan?.done).toBe(0);
    expect(plan?.gate).toBeNull();
    expect(plan?.tasks.length).toBe(1);
    expect(plan?.tasks[0].id).toBe("t1");
    expect(plan?.tasks[0].reviewer).not.toBeNull();
    expect(typeof body.now).toBe("string");
  } finally {
    close(h);
  }
});

test("GET /api/state on an empty plans dir has no plan", async () => {
  const h = harness();
  try {
    const res = await fetch(`${h.base}/api/state`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as MonitorState;
    expect(body.repos.length).toBe(1);
    expect(body.repos[0].plan).toBeNull();
    expect(body.repos[0].active).toBe(false);
    expect(body.repos[0].message).toBe("No plan has run yet");
    expect(body.message).toBeNull();
  } finally {
    close(h);
  }
});

test("GET /api/state reports a missing plans folder and stays up", async () => {
  const h = harness();
  try {
    fs.rmSync(h.dirs[0], { recursive: true, force: true });
    const res = await fetch(`${h.base}/api/state`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as MonitorState;
    expect(body.repos[0].plan).toBeNull();
    expect(body.repos[0].message).toBe("No plans folder found");
    expect(body.message).toBeNull();
  } finally {
    close(h);
  }
});

test("GET /api/state lists two repos with the running one first", async () => {
  const h = harness({ names: ["item-a", "item-b"] });
  try {
    writePlan(h.dirs[0], "done", "p1", [{ id: "t1" }]);
    writeEvents(h.dirs[0], "p1", [
      ev("plan.start", "p1", "2026-10-22T10:00:00.000Z"),
      ev("plan.end", "p1", "2026-10-22T10:05:00.000Z"),
    ]);

    writePlan(h.dirs[1], "running", "p2", [{ id: "t1" }]);
    writeEvents(h.dirs[1], "p2", [
      ev("plan.start", "p2", "2026-10-22T11:00:00.000Z"),
      ev("task.start", "p2", "2026-10-22T11:01:00.000Z", { task: "t1", attempt: 1 }),
    ]);

    const res = await fetch(`${h.base}/api/state`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as MonitorState;
    expect(body.repos.map((repo) => repo.name)).toEqual(["item-b", "item-a"]);
    expect(body.repos[0].active).toBe(true);
    expect(body.repos[0].plan?.id).toBe("p2");
    expect(body.repos[1].active).toBe(false);
    expect(body.repos[1].plan?.id).toBe("p1");
  } finally {
    close(h);
  }
});

test("GET /api/state reports the configuration message once, on the state", async () => {
  const h = harness({ message: "2 more repos ignored (limit 24)" });
  try {
    const res = await fetch(`${h.base}/api/state`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as MonitorState;
    expect(body.message).toBe("2 more repos ignored (limit 24)");
    expect(body.repos[0].message).toBe("No plan has run yet");
  } finally {
    close(h);
  }
});

test("GET /api/session returns entries and resumes from after", async () => {
  const h = harness();
  try {
    writeSession(h.dirs[0], "p1", "p1.t1.a1", [
      sessionHeader("p1.t1.a1"),
      modelChange("opencode-go/beam-free", TS),
      userMsg("do the thing", TS),
      assistantMsg([textPart("done")], TS, { stopReason: "stop" }),
    ]);

    const first = await fetch(`${h.base}/api/session/item-a/p1/p1.t1.a1`);
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    const page = (await first.json()) as SessionPage;
    expect(page.id).toBe("p1.t1.a1");
    expect(page.ended).toBe(true);
    expect(page.live).toBe(false);
    expect(page.entries.length).toBeGreaterThan(0);
    expect(page.next).toBeGreaterThan(0);

    const second = await fetch(
      `${h.base}/api/session/item-a/p1/p1.t1.a1?after=${page.next}`,
    );
    expect(second.status).toBe(200);
    const rest = (await second.json()) as SessionPage;
    expect(rest.entries).toEqual([]);
    expect(rest.next).toBe(page.next);
  } finally {
    close(h);
  }
});

test("GET /api/session reads each repo from its own plans folder", async () => {
  const h = harness({ names: ["item-a", "item-b"] });
  try {
    writeSession(h.dirs[1], "p2", "p2.t1.a1", [
      sessionHeader("p2.t1.a1"),
      userMsg("second repo", TS),
    ]);

    const one = await fetch(`${h.base}/api/session/item-a/p2/p2.t1.a1`);
    expect(one.status).toBe(404);
    const two = await fetch(`${h.base}/api/session/item-b/p2/p2.t1.a1`);
    expect(two.status).toBe(200);
    const page = (await two.json()) as SessionPage;
    expect(page.id).toBe("p2.t1.a1");
  } finally {
    close(h);
  }
});

test("GET /api/session for an unknown repo is 404 without echoing the name", async () => {
  const h = harness();
  try {
    const res = await fetch(`${h.base}/api/session/nope/p1/p1.t1.a1`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not found");
    expect(JSON.stringify(body)).not.toContain("nope");
  } finally {
    close(h);
  }
});

test("GET /api/session with a bad id is 400", async () => {
  const h = harness();
  try {
    const res = await fetch(`${h.base}/api/session/item-a/p1/bad%20id`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe("string");

    const badPlan = await fetch(`${h.base}/api/session/item-a/bad%20plan/p1.t1.a1`);
    expect(badPlan.status).toBe(400);
  } finally {
    close(h);
  }
});

test("GET /api/session with a missing session is 404", async () => {
  const h = harness();
  try {
    const res = await fetch(`${h.base}/api/session/item-a/p1/p1.t1.a9`);
    expect(res.status).toBe(404);
  } finally {
    close(h);
  }
});

test("a repo segment with .. or %2f never reads outside its folder", async () => {
  const h = harness();
  try {
    writeSession(h.dirs[0], "p1", "p1.t1.a1", [sessionHeader("p1.t1.a1")]);

    const dots = await fetch(`${h.base}/api/session/../p1/p1.t1.a1`);
    expect(dots.status === 404 || dots.status === 400).toBe(true);

    const encoded = await fetch(`${h.base}/api/session/item-a%2f..%2fitem-a/p1/p1.t1.a1`);
    expect(encoded.status === 404 || encoded.status === 400).toBe(true);

    const nested = await fetch(`${h.base}/api/session/item-a/p1/..%2fp1.t1.a1`);
    expect(nested.status === 400 || nested.status === 404).toBe(true);

    const body = (await encoded.json()) as { error: string };
    expect(typeof body.error).toBe("string");
  } finally {
    close(h);
  }
});

test("a prototype key as repo name is 404, not 500", async () => {
  const h = harness();
  try {
    const res = await fetch(`${h.base}/api/session/constructor/p/p1.t1.a1`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not found");
  } finally {
    close(h);
  }
});

test("POST is refused with 405", async () => {
  const h = harness();
  try {
    const res = await fetch(`${h.base}/api/state`, { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
  } finally {
    close(h);
  }
});

test("a foreign Host is refused with 403", async () => {
  const h = harness();
  try {
    const text = await rawRequest(h.handle.port, "/api/state", "evil.example");
    expect(text.startsWith("HTTP/1.1 403")).toBe(true);
  } finally {
    close(h);
  }
});

test("responses carry nosniff, and API responses no-store", async () => {
  const h = harness();
  try {
    const api = await fetch(`${h.base}/api/state`);
    expect(api.headers.get("x-content-type-options")).toBe("nosniff");
    expect(api.headers.get("cache-control")).toBe("no-store");

    const page = await fetch(`${h.base}/`);
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(page.headers.get("cache-control")).toBeNull();
  } finally {
    close(h);
  }
});

test("static / serves index.html and a traversal path is 404", async () => {
  const h = harness();
  try {
    const index = await fetch(`${h.base}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toContain("text/html");
    expect(await index.text()).toContain("monitor");

    const traversal = await fetch(`${h.base}/..%2f..%2fpackage.json`);
    expect(traversal.status).toBe(404);
    const body = (await traversal.json()) as { error: string };
    expect(body.error).toBe("not found");
  } finally {
    close(h);
  }
});

test("SSE sends hello, then change when the plans folder changes", async () => {
  const h = harness({ pollMs: 50 });
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    writePlan(h.dirs[0], "running", "p1", [{ id: "t1" }]);
    writeEvents(h.dirs[0], "p1", [ev("task.start", "p1", TS, { task: "t1", attempt: 1 })]);

    const res = await fetch(`${h.base}/api/events`, { signal: controller.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    reader = res.body?.getReader() ?? null;
    expect(reader).not.toBeNull();
    if (reader === null) {
      return;
    }

    const buffer = { text: "" };
    expect(await readUntil(reader, "event: hello", buffer)).toBe(true);

    writeEvents(h.dirs[0], "p1", [
      ev("task.end", "p1", TS, { task: "t1", attempt: 1, data: { state: "done", ok: true } }),
    ]);

    expect(await readUntil(reader, "event: change", buffer)).toBe(true);
  } finally {
    controller.abort();
    if (reader !== null) {
      await reader.cancel().catch(() => undefined);
    }
    close(h);
  }
});

test("SSE sends change when a file of the second repo changes", async () => {
  const h = harness({ pollMs: 50, names: ["item-a", "item-b"] });
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    writePlan(h.dirs[0], "running", "p1", [{ id: "t1" }]);
    writeEvents(h.dirs[0], "p1", [ev("task.start", "p1", TS, { task: "t1", attempt: 1 })]);
    writePlan(h.dirs[1], "running", "p2", [{ id: "t1" }]);
    writeEvents(h.dirs[1], "p2", [ev("task.start", "p2", TS, { task: "t1", attempt: 1 })]);

    const res = await fetch(`${h.base}/api/events`, { signal: controller.signal });
    expect(res.status).toBe(200);
    reader = res.body?.getReader() ?? null;
    expect(reader).not.toBeNull();
    if (reader === null) {
      return;
    }

    const buffer = { text: "" };
    expect(await readUntil(reader, "event: hello", buffer)).toBe(true);

    writeEvents(h.dirs[1], "p2", [
      ev("task.end", "p2", TS, { task: "t1", attempt: 1, data: { state: "done", ok: true } }),
    ]);

    expect(await readUntil(reader, "event: change", buffer)).toBe(true);
  } finally {
    controller.abort();
    if (reader !== null) {
      await reader.cancel().catch(() => undefined);
    }
    close(h);
  }
});

test("static file content type follows the extension", async () => {
  const h = harness();
  try {
    fs.writeFileSync(path.join(h.staticDir, "app.js"), "console.log(1);\n");
    const res = await fetch(`${h.base}/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(await res.text()).toContain("console.log");
  } finally {
    close(h);
  }
});
