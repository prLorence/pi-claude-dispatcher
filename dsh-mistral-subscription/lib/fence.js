/**
 * Request fence for the plugin's settings routes.
 *
 * DSH's web server enforces no origin policy of its own: every route owner
 * states its own. This helper states the one these routes need, in two layers,
 * strongest first:
 *
 * 1. `ctx.connection.requestRejection(req)` — the Host/Origin fence plus the
 *    browser-session check `/api` uses. It returns an HTTP status when the
 *    request is refused and `undefined` when it passes.
 * 2. A cookie-free Host/Origin fence for a composition without the connection
 *    service: an absent connection is not a reason to serve settings writes to
 *    any origin that can reach the port.
 *
 * The helper deliberately says nothing about the request body. A route that
 * writes adds its own `content-type: application/json` rule, so a cross-site
 * write would have to pass a preflight that never succeeds.
 *
 * The credential never crosses here: every refusal carries a fixed code.
 */

/** Host names a loopback client dials: `localhost`, IPv6 `::1`, and 127/8. */
function isLoopbackHostname(hostname) {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const parts = hostname.split(".");
  return (
    parts.length === 4 &&
    parts[0] === "127" &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}

/**
 * One raw request header, string-valued only. Node types a header value as
 * `string | string[]`: a repeated header is the array form, and that shape is
 * not one this fence reads.
 */
function headerOf(req, name) {
  const value = req?.headers?.[name];
  return typeof value === "string" ? value : undefined;
}

/**
 * Whether a fence input arrived in a shape this helper does not read. An
 * unread value must never be treated as an absent one: absent Origin and
 * absent sec-fetch-site both mean ADMIT below, so a repeated marker read as
 * absent would turn a forged request into a pass.
 */
function hasUnreadFenceHeader(req) {
  for (const name of ["host", "origin", "sec-fetch-site"]) {
    const value = req?.headers?.[name];
    if (value !== undefined && typeof value !== "string") return true;
  }
  return false;
}

/** WHATWG-normalized hostname of a bare authority, or undefined. */
function hostnameOf(authority, scheme = "http:") {
  try {
    return new URL(`${scheme}//${authority}`).hostname;
  } catch {
    return undefined;
  }
}

/**
 * The local address of this connection in the same normalized form Host is
 * read in, so an IPv6 literal or a `%zone` suffix compares correctly.
 */
function localAddressHostname(req) {
  const address = req?.socket?.localAddress;
  if (typeof address !== "string" || address.length === 0) return undefined;
  const zoneAt = address.indexOf("%");
  const bare = zoneAt === -1 ? address : address.slice(0, zoneAt);
  return hostnameOf(bare.includes(":") ? `[${bare}]` : bare);
}

/**
 * Whether an Origin names the Host's own authority. The Host is read under the
 * Origin's scheme so a default port normalizes the same way on both sides.
 */
function isSameAuthorityOrigin(origin, host) {
  let originUrl;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }
  const scheme =
    originUrl.protocol === "https:" || originUrl.protocol === "http:" ? originUrl.protocol : undefined;
  if (scheme === undefined) return false;
  try {
    return originUrl.host === new URL(`${scheme}//${host}`).host;
  } catch {
    return false;
  }
}

/** True when the cookie-free fence refuses the request. */
function fallbackRejects(req) {
  if (hasUnreadFenceHeader(req)) return true;

  const host = headerOf(req, "host");
  if (host === undefined) return true;

  const hostname = hostnameOf(host);
  if (hostname === undefined) return true;
  if (!isLoopbackHostname(hostname) && hostname !== localAddressHostname(req)) return true;

  // A browser marks a request from another site; a non-browser client simply
  // omits the header, and the Host and Origin rules still apply to it.
  if ((headerOf(req, "sec-fetch-site") ?? "").toLowerCase() === "cross-site") return true;

  const origin = headerOf(req, "origin");
  if (origin !== undefined && !isSameAuthorityOrigin(origin, host)) return true;

  return false;
}

/** Writes the one refusal response. The body carries a code, never material. */
function reject(res, status) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: status === 401 ? "unauthenticated" : "forbidden" }));
}

/**
 * Applies the fence. Returns true when the request was REJECTED, in which case
 * the response has already been written and the caller must return.
 *
 * `deps` is a plain object carrying the connection service — at the call site
 * the `ctx.inject(["webServer", "connection"], …)` scope read with
 * `Reflect.get(scope, "connection")`, or `{}` where the service is absent.
 */
export function fenceRequest({ connection } = {}, req, res) {
  if (typeof connection?.requestRejection === "function") {
    let status;
    try {
      // Method call: the service's own `this` matters.
      status = connection.requestRejection(req);
    } catch {
      // A fence that cannot answer has not admitted the request.
      reject(res, 403);
      return true;
    }
    if (status === undefined) return false;
    // Only a pass is `undefined`. Anything else — including a shape this
    // helper does not know — is a refusal, so a changed return contract cannot
    // silently open the route.
    reject(res, Number.isInteger(status) && status >= 400 && status <= 599 ? status : 403);
    return true;
  }

  // No usable connection service: the cookie-free fence stands in for it.
  if (!fallbackRejects(req)) return false;
  reject(res, 403);
  return true;
}
