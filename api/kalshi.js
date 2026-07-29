// ─────────────────────────────────────────────────────────────────────────────
// Proxy for Kalshi's public trade API.
//
// Kalshi's REST API is free and unauthenticated, so — exactly like `/api/mlb`
// and unlike `/api/odds` — this file is not here to protect a credit balance.
// It exists because Kalshi serves no CORS headers: a direct `fetch` from the
// app origin is blocked before it leaves the page. There is no API key here and
// no secret to leak; the only jobs are
//
//   (a) not being an open redirect / SSRF hop to arbitrary hosts, and
//   (b) caching, because an order book that is 5 seconds stale is still a far
//       better answer than one that costs a round trip on every render.
//
// Same client contract as `/api/mlb`: the whole upstream path *below the API
// version prefix*, query string included, arrives URL-encoded as ?path= —
//   /api/kalshi?path=%2Fmarkets%3Fseries_ticker%3DKXMLBHRR%26status%3Dopen
// ─────────────────────────────────────────────────────────────────────────────

const UPSTREAM_ORIGIN = "https://external-api.kalshi.com";
const UPSTREAM_PREFIX = "/trade-api/v2";
const UPSTREAM_TIMEOUT_MS = 15_000;
const MAX_PATH_LEN = 1024;

// Each entry: [pathname matcher (below the version prefix), s-maxage, swr].
// Ordered most-specific first. A path matching nothing is rejected.
const ROUTES = [
  // Order books move tick by tick; hold them barely at all.
  [/^\/markets\/[A-Za-z0-9._-]{1,128}\/orderbook$/, 5, 20],
  // Market lists carry prices, so they are live-ish too.
  [/^\/markets$/, 15, 60],
  // Events are the game/series skeleton: stable for the length of a slate.
  [/^\/events$/, 60, 300],
];

// Query parameters allowed through. Anything else is dropped rather than
// rejected — an unknown param cannot reach the upstream, so it cannot mint a
// fresh cache key either.
const ALLOWED_PARAMS = new Set([
  "series_ticker",
  "event_ticker",
  "tickers",
  "status",
  "limit",
  "cursor",
  "depth",
  "min_close_ts",
  "max_close_ts",
]);

const MAX_PARAM_LEN = 256;

function params(req) {
  // WHATWG URL rather than `req.query`, which routes through the deprecated
  // `url.parse()` and floods the runtime logs with DEP0169.
  return new URL(req.url, "http://localhost").searchParams;
}

function fail(res, status, message) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json({ error: message });
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return fail(res, 405, "method not allowed");
  }

  const raw = params(req).get("path");
  if (!raw) return fail(res, 400, "missing path");
  if (raw.length > MAX_PATH_LEN) return fail(res, 414, "path too long");

  // Anything scheme-relative ("//evil.com"), absolute ("https://evil.com") or
  // traversing ("..") either fails this check or lands outside the allowlist.
  if (!raw.startsWith("/") || raw.startsWith("//")) {
    return fail(res, 400, "path must be origin-relative");
  }

  let target;
  try {
    // Joined onto the version prefix explicitly: resolving a root-relative path
    // against a base URL would discard `/trade-api/v2` and point at the origin.
    target = new URL(UPSTREAM_PREFIX + raw, UPSTREAM_ORIGIN);
  } catch {
    return fail(res, 400, "malformed path");
  }
  if (target.origin !== UPSTREAM_ORIGIN) {
    return fail(res, 400, "path must stay on external-api.kalshi.com");
  }
  if (!target.pathname.startsWith(`${UPSTREAM_PREFIX}/`)) {
    return fail(res, 400, "path must stay under the trade-api version prefix");
  }

  const suffix = target.pathname.slice(UPSTREAM_PREFIX.length);
  const route = ROUTES.find(([re]) => re.test(suffix));
  if (!route) return fail(res, 400, `unsupported path: ${suffix}`);
  const [, sMaxAge, swr] = route;

  // Canonical query: allowlisted keys only, sorted, so two spellings of the
  // same request share one CDN cache entry.
  const clean = new URLSearchParams();
  for (const [key, value] of [...target.searchParams].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    if (!ALLOWED_PARAMS.has(key)) continue;
    if (value.length > MAX_PARAM_LEN) {
      return fail(res, 400, `parameter too long: ${key}`);
    }
    clean.append(key, value);
  }
  target.search = clean.toString();

  let resp, body;
  try {
    resp = await fetch(target.toString(), {
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    body = await resp.text();
  } catch (e) {
    const timedOut = e.name === "TimeoutError" || e.name === "AbortError";
    return fail(
      res,
      timedOut ? 504 : 502,
      timedOut ? "Kalshi API timed out" : "Kalshi API unreachable",
    );
  }

  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (!resp.ok) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(resp.status).send(body);
  }

  res.setHeader(
    "Cache-Control",
    `public, s-maxage=${sMaxAge}, stale-while-revalidate=${swr}`,
  );
  return res.status(200).send(body);
}

export const config = { runtime: "nodejs", maxDuration: 20 };
