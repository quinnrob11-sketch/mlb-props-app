// ─────────────────────────────────────────────────────────────────────────────
// Proxy for the MLB Stats API (free, keyless — this exists purely to bypass
// CORS). The upstream costs nothing, so the goal here is not cost control but
// (a) not being an open redirect / SSRF hop to arbitrary hosts, and
// (b) caching aggressively, because season stats and venue metadata do not
//     change between two page loads and re-fetching them is the slowest part
//     of a slate load.
//
// The client sends the full upstream path *including* its query string, URL
// encoded, as ?path=… — e.g.
//   /api/mlb?path=%2Fapi%2Fv1%2Fschedule%3FsportId%3D1%26date%3D2026-07-28
// ─────────────────────────────────────────────────────────────────────────────

const UPSTREAM_ORIGIN = "https://statsapi.mlb.com";
const UPSTREAM_TIMEOUT_MS = 20_000;
const MAX_PATH_LEN = 4096;

// Each entry: [pathname matcher, s-maxage, stale-while-revalidate].
// Ordered most-specific first. A path that matches nothing is rejected.
const ROUTES = [
  // Live-ish: changes during games.
  [/^\/api\/v1\/game\/\d+\/boxscore$/, 30, 120],
  [/^\/api\/v1(?:\.1)?\/game\/\d+\/feed\/live$/, 20, 60],
  // Schedule flips as lineups and probables are posted.
  [/^\/api\/v1\/schedule$/, 60, 300],
  // Season aggregates: safe to hold for minutes.
  [/^\/api\/v1\/people$/, 600, 1800],
  [/^\/api\/v1\/teams\/stats$/, 900, 3600],
  [/^\/api\/v1\/teams\/\d+\/roster$/, 900, 3600],
  // Essentially static reference data.
  [/^\/api\/v1\/venues$/, 86_400, 604_800],
  [/^\/api\/v1\/teams$/, 86_400, 604_800],
];

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

  // Resolve against the fixed origin. Anything scheme-relative ("//evil.com"),
  // absolute ("https://evil.com") or traversing ("..") either fails the
  // leading-slash check or lands outside the allowlist below.
  if (!raw.startsWith("/") || raw.startsWith("//")) {
    return fail(res, 400, "path must be origin-relative");
  }

  let target;
  try {
    target = new URL(raw, UPSTREAM_ORIGIN);
  } catch {
    return fail(res, 400, "malformed path");
  }
  if (target.origin !== UPSTREAM_ORIGIN) {
    return fail(res, 400, "path must stay on statsapi.mlb.com");
  }

  const route = ROUTES.find(([re]) => re.test(target.pathname));
  if (!route) return fail(res, 400, `unsupported path: ${target.pathname}`);
  const [, sMaxAge, swr] = route;

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
      timedOut ? "MLB API timed out" : "MLB API unreachable",
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
