import * as fs from "node:fs";
import { extname } from "node:path";
import type { SessionPage } from "../shared/types.ts";
import { ID_RE, checkRequest, json, resolveInside, withHeaders } from "./http.ts";
import { STALL_MS } from "./lanes.ts";
import type { RepoConfig } from "./repos.ts";
import { findSessionFile, parseSessionLines, summarizeSession } from "./sessions.ts";
import { readState } from "./state.ts";
import { signature } from "./watch.ts";

export interface ServerOptions {
  repos: RepoConfig[];
  message?: string | null;
  staticDir: string;
  port: number;
  host: string;
  pollMs?: number;
}

export interface ServerHandle {
  port: number;
  stop: () => void;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const PING_MS = 15000;

type Client = ReadableStreamDefaultController<Uint8Array>;

const encoder = new TextEncoder();

function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function sessionPage(
  plansDir: string,
  planId: string,
  sessionId: string,
  after: number,
): Response {
  const file = findSessionFile(plansDir, planId, sessionId);
  if (file === null) {
    return json({ error: "not found" }, 404);
  }

  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return json({ error: "not found" }, 404);
  }

  const parsed = parseSessionLines(text, after);
  const summary = summarizeSession(file);
  const live = !summary.ended && Date.now() - summary.mtimeMs <= STALL_MS;
  const page: SessionPage = {
    id: sessionId,
    live,
    ended: summary.ended,
    entries: parsed.entries,
    next: parsed.next,
  };
  return json(page);
}

function staticFile(staticDir: string, pathname: string): Response {
  let relative: string;
  if (pathname === "/" || pathname === "") {
    relative = "index.html";
  } else {
    const decoded = decodeSegment(pathname);
    if (decoded === null) {
      return json({ error: "not found" }, 404);
    }
    relative = decoded.replace(/^\/+/, "");
  }

  const file = resolveInside(staticDir, relative);
  if (file === null) {
    return json({ error: "not found" }, 404);
  }

  let data: Buffer;
  try {
    data = fs.readFileSync(file);
  } catch {
    return json({ error: "not found" }, 404);
  }

  const type = CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
  return new Response(new Uint8Array(data), {
    headers: { "content-type": type },
  });
}

export function startServer(opts: ServerOptions): ServerHandle {
  const { repos, staticDir, host } = opts;
  const message = opts.message ?? null;
  const pollMs = opts.pollMs ?? 500;
  const clients = new Set<Client>();
  const byName = new Map<string, RepoConfig>(repos.map((repo) => [repo.name, repo]));

  const write = (client: Client, text: string): void => {
    try {
      client.enqueue(encoder.encode(text));
    } catch {
      clients.delete(client);
    }
  };

  const broadcast = (text: string): void => {
    for (const client of clients) {
      write(client, text);
    }
  };

  const events = (): Response => {
    let client: Client | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        client = controller;
        clients.add(controller);
        write(controller, "event: hello\ndata: {}\n\n");
      },
      cancel() {
        if (client !== null) {
          clients.delete(client);
        }
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  };

  const route = (url: URL): Response => {
    const pathname = url.pathname;

    if (pathname === "/api/state") {
      return json(readState(repos, Date.now(), message));
    }

    if (pathname === "/api/events") {
      return events();
    }

    if (pathname.startsWith("/api/session/")) {
      const parts = pathname.split("/");
      if (parts.length !== 6) {
        return json({ error: "not found" }, 404);
      }
      const repoName = decodeSegment(parts[3]);
      const planId = decodeSegment(parts[4]);
      const sessionId = decodeSegment(parts[5]);
      if (repoName === null || planId === null || sessionId === null) {
        return json({ error: "bad id" }, 400);
      }
      const repo = byName.get(repoName);
      if (repo === undefined) {
        return json({ error: "not found" }, 404);
      }
      if (!ID_RE.test(planId) || !ID_RE.test(sessionId)) {
        return json({ error: "bad id" }, 400);
      }

      const rawAfter = url.searchParams.get("after");
      let after = 0;
      if (rawAfter !== null) {
        if (!/^\d+$/.test(rawAfter)) {
          return json({ error: "bad after" }, 400);
        }
        after = Number.parseInt(rawAfter, 10);
      }

      return sessionPage(repo.dir, planId, sessionId, after);
    }

    if (pathname.startsWith("/api/")) {
      return json({ error: "not found" }, 404);
    }

    return staticFile(staticDir, pathname);
  };

  const server = Bun.serve({
    port: opts.port,
    hostname: host,
    idleTimeout: 0,
    fetch(req) {
      const url = new URL(req.url, `http://${req.headers.get("host") ?? "localhost"}`);
      const api = url.pathname === "/api" || url.pathname.startsWith("/api/");
      const guard = checkRequest(req);
      if (guard !== null) {
        return withHeaders(guard, api);
      }
      return withHeaders(route(url), api);
    },
  });

  let last = signature(repos);
  let lastPing = Date.now();

  const poll = setInterval(() => {
    try {
      const now = Date.now();
      if (now - lastPing >= PING_MS) {
        lastPing = now;
        broadcast(": ping\n\n");
      }
      const current = signature(repos);
      if (current !== last) {
        last = current;
        broadcast("event: change\ndata: {}\n\n");
      }
    } catch {
      // Keep polling: a transient read error must not stop the clock.
    }
  }, pollMs);

  return {
    port: server.port ?? opts.port,
    stop: () => {
      clearInterval(poll);
      for (const client of clients) {
        try {
          client.close();
        } catch {
          // Already closed by the reader.
        }
      }
      clients.clear();
      void server.stop(true);
    },
  };
}
