/** HTTP helpers: read-only guard, JSON responses and path containment. */
import { isAbsolute, resolve, sep } from "node:path";

export const ID_RE = /^[\w.-]+$/;
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Node request -> {status, body} when the request is refused, else null. */
export function checkRequest(req) {
	const method = String(req.method ?? "GET").toUpperCase();
	if (method !== "GET" && method !== "HEAD") return { status: 405, body: { error: "read only" }, allow: "GET, HEAD" };
	const host = req.headers?.host;
	if (typeof host !== "string" || host === "") return { status: 403, body: { error: "forbidden host" } };
	let hostname;
	if (host.startsWith("[")) {
		const end = host.indexOf("]");
		hostname = end === -1 ? host : host.slice(0, end + 1);
	} else {
		const colon = host.lastIndexOf(":");
		hostname = colon === -1 ? host : host.slice(0, colon);
	}
	if (!ALLOWED_HOSTS.has(hostname.toLowerCase())) return { status: 403, body: { error: "forbidden host" } };
	return null;
}

export function json(body, status = 200) {
	return { status, headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body) };
}

export function resolveInside(base, ...parts) {
	const root = resolve(base);
	for (const part of parts) {
		if (part.includes("\0") || isAbsolute(part)) return null;
		if (part.split(/[\\/]/).includes("..")) return null;
	}
	const target = resolve(root, ...parts);
	if (target === root || target.startsWith(root + sep)) return target;
	return null;
}

export function withHeaders(res, api) {
	res.headers = res.headers ?? {};
	res.headers["X-Content-Type-Options"] = "nosniff";
	if (api) res.headers["Cache-Control"] = "no-store";
	return res;
}
