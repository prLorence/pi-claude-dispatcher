import { test, expect } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { MonitorState, SessionPage } from "../shared/types.ts";
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
  dir: string;
  staticDir: string;
}

function harness(pollMs?: number): Harness {
  const dir = makePlansDir();
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-monitor-static-"));
  fs.writeFileSync(
    path.join(staticDir, "index.html"),
    "<!doctype html><html><body>monitor</body></html>",
  );
  const handle = startServer({
    plansDir: dir,
    staticDir,
    port: 0,
    host: "127.0.0.1",
    pollMs: pollMs ?? 500,
  });
  return { base: `http://127.0.0.1:${handle.port}`, handle, dir, staticDir };
}

function close(h: Harness): void {
  h.handle.stop();
  cleanup(h.dir);
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

test("GET /api/state shows the running plan", async () => {
  const h = harness();
  try {
    writePlan(h.dir, "running", "p1", [{ id: "t1", pair: "review" }]);
    writeEvents(h.dir, "p1", [
      ev("task.start", "p1", TS, { task: "t1", attempt: 1, data: { role: "implement" } }),
    ]);

    const res = await fetch(`${h.base}/api/state`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as MonitorState;
    expect(body.message).toBeNull();
    expect(body.plan).not.toBeNull();
    expect(body.plan?.id).toBe("p1");
    expect(body.plan?.trace).toBe("p1");
    expect(body.plan?.state).toBe("running");
    expect(body.plan?.total).toBe(1);
    expect(body.plan?.done).toBe(0);
    expect(body.plan?.gate).toBeNull();
    expect(body.plan?.tasks.length).toBe(1);
    expect(body.plan?.tasks[0].id).toBe("t1");
    expect(body.plan?.tasks[0].reviewer).not.toBeNull();
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
    expect(body.plan).toBeNull();
    expect(typeof body.message).toBe("string");
    expect(body.message).toBe("No plan has run yet");
  } finally {
    close(h);
  }
});

test("GET /api/state reports a missing plans folder and stays up", async () => {
  const h = harness();
  try {
    fs.rmSync(h.dir, { recursive: true, force: true });
    const res = await fetch(`${h.base}/api/state`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as MonitorState;
    expect(body.plan).toBeNull();
    expect(body.message).toBe("No plans folder found");
  } finally {
    close(h);
  }
});

test("GET /api/session returns entries and resumes from after", async () => {
  const h = harness();
  try {
    writeSession(h.dir, "p1", "p1.t1.a1", [
      sessionHeader("p1.t1.a1"),
      modelChange("opencode-go/beam-free", TS),
      userMsg("do the thing", TS),
      assistantMsg([textPart("done")], TS, { stopReason: "stop" }),
    ]);

    const first = await fetch(`${h.base}/api/session/p1/p1.t1.a1`);
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    const page = (await first.json()) as SessionPage;
    expect(page.id).toBe("p1.t1.a1");
    expect(page.ended).toBe(true);
    expect(page.live).toBe(false);
    expect(page.entries.length).toBeGreaterThan(0);
    expect(page.next).toBeGreaterThan(0);

    const second = await fetch(`${h.base}/api/session/p1/p1.t1.a1?after=${page.next}`);
    expect(second.status).toBe(200);
    const rest = (await second.json()) as SessionPage;
    expect(rest.entries).toEqual([]);
    expect(rest.next).toBe(page.next);
  } finally {
    close(h);
  }
});

test("GET /api/session with a bad id is 400", async () => {
  const h = harness();
  try {
    const res = await fetch(`${h.base}/api/session/p1/bad%20id`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe("string");
  } finally {
    close(h);
  }
});

test("GET /api/session with a missing session is 404", async () => {
  const h = harness();
  try {
    const res = await fetch(`${h.base}/api/session/p1/p1.t1.a9`);
    expect(res.status).toBe(404);
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
  const h = harness(50);
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    writePlan(h.dir, "running", "p1", [{ id: "t1" }]);
    writeEvents(h.dir, "p1", [ev("task.start", "p1", TS, { task: "t1", attempt: 1 })]);

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

    writeEvents(h.dir, "p1", [
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
