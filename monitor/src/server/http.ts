import { isAbsolute, resolve, sep } from "node:path";

export const ID_RE = /^[\w.-]+$/;

const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function checkRequest(req: Request): Response | null {
  const method = req.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    const res = json({ error: "read only" }, 405);
    res.headers.set("Allow", "GET, HEAD");
    return res;
  }

  const host = req.headers.get("host");
  if (host === null) {
    return json({ error: "forbidden host" }, 403);
  }

  let hostname: string;
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    hostname = end === -1 ? host : host.slice(0, end + 1);
  } else {
    const colon = host.lastIndexOf(":");
    hostname = colon === -1 ? host : host.slice(0, colon);
  }

  if (!ALLOWED_HOSTS.has(hostname.toLowerCase())) {
    return json({ error: "forbidden host" }, 403);
  }

  return null;
}

export function withHeaders(res: Response, api: boolean): Response {
  res.headers.set("X-Content-Type-Options", "nosniff");
  if (api) {
    res.headers.set("Cache-Control", "no-store");
  }
  return res;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function resolveInside(base: string, ...parts: string[]): string | null {
  const root = resolve(base);
  for (const part of parts) {
    if (part.includes("\0") || isAbsolute(part)) {
      return null;
    }
    if (part.split(/[\\/]/).includes("..")) {
      return null;
    }
  }

  const target = resolve(root, ...parts);
  if (target === root || target.startsWith(root + sep)) {
    return target;
  }
  return null;
}
