// ─────────────────────────────────────────────────────────────────────────────
// Proxy for The Odds API.
//
// Why this file is defensive: the upstream is metered and billed to a single
// key. This endpoint is public, so anything it will happily forward, a stranger
// can spend your credits on. Three layers keep that bounded:
//
//   1. Strict allowlisting  — only two endpoints, one sport, a fixed market
//                             vocabulary, and a 32-hex event id. There is no
//                             way to reach an arbitrary upstream URL.
//   2. Canonical cache keys — markets are lowercased, deduped and sorted and
//                             `books` is resolved to one of three named modes
//                             before either is forwarded, so `k,hits` and
//                             `hits,k` are the same URL and share one entry.
//   3. Edge caching         — repeat traffic is served by Vercel's CDN and
//                             costs zero upstream credits.
//
// Together those cap worst-case burn at (#events x #distinct market sets) per
// cache window rather than "unbounded". Rate limiting below is best-effort
// only: serverless instances do not share memory, so treat it as a speed bump,
// not a guarantee.
// ─────────────────────────────────────────────────────────────────────────────

const UPSTREAM = "https://api.the-odds-api.com/v4";
const SPORT = "baseball_mlb";

// ── book sets ────────────────────────────────────────────────────────────────
// Named, explicit sets so the upstream cost of each one is legible right here.
//
// Billing is per 10 bookmakers = 1 "region-equivalent". A `bookmakers=` list of
// 1..10 keys therefore costs exactly the same as any other list of 1..10 keys:
// `wide` (10 keys) bills identically to `core` (5 keys). The 11th key crosses
// into a second region-equivalent and DOUBLES the cost of every call, so
// `wide` is a hard ceiling — do not add an entry without removing one.
//
// Each list is sorted so the upstream URL (and hence its cache entry) is stable.
const BOOK_SETS = {
  core: ["betmgm", "caesars", "draftkings", "fanduel", "pinnacle"],
  // core + five exchange/DFS venues. Exactly 10 = the quota ceiling.
  wide: [
    "betmgm", "betr_us_dfs", "caesars", "draftkings", "fanduel",
    "kalshi", "novig", "pick6", "pinnacle", "prizepicks",
  ],
};

// `books=all` is kept only for backwards compatibility with callers that still
// send it. It swaps the pinned `bookmakers=` list for whole regions, which
// returns far more than 10 books and so costs MORE than one region-equivalent.
// It is not the default and should not be used by new code.
const ALL_REGIONS = "us,us2";

// Every accepted value of `books`, and the one used when the param is absent.
//
// NOTE: the app still sends `books` explicitly (`sharp ? 'all' : 'core'` in
// src/data/loadSlate.js), so it does not yet pick this default up. That call
// site has to switch to `wide` for the app to see the extra five venues; this
// default only covers callers that omit the param.
const BOOK_MODES = new Set([...Object.keys(BOOK_SETS), "all"]);
const DEFAULT_BOOKS = "wide";

// Fixed extras on every event-odds call. Deliberately NOT caller-controlled:
// making them query params would let anyone mint fresh cache keys by toggling
// them, and neither carries a documented extra cost.
//   includeLinks       - deep links per event/market/outcome, plus `sid`.
//   includeMultipliers - DFS payout multipliers (a line + multiplier rather
//                        than a two-sided price).
const EVENT_ODDS_EXTRAS = {
  includeLinks: "true",
  includeMultipliers: "true",
};

// Every market the app is allowed to ask for. Anything else is rejected before
// it reaches the upstream, which is what bounds the cache-key space.
const MARKETS = new Set([
  // pitcher
  "pitcher_strikeouts", "pitcher_outs", "pitcher_hits_allowed",
  "pitcher_earned_runs", "pitcher_walks",
  "pitcher_strikeouts_alternate", "pitcher_hits_allowed_alternate",
  "pitcher_walks_alternate",
  // batter
  "batter_hits", "batter_home_runs", "batter_runs_scored", "batter_rbis",
  "batter_total_bases", "batter_hits_runs_rbis", "batter_doubles",
  "batter_stolen_bases", "batter_strikeouts", "batter_singles",
  "batter_hits_alternate", "batter_home_runs_alternate",
  "batter_rbis_alternate", "batter_total_bases_alternate",
  // team
  "totals_1st_1_innings",
]);

const EVENT_ID = /^[a-f0-9]{32}$/;

// How long the CDN may serve a response without revalidating.
const TTL = {
  events: { s: 120, swr: 300 },
  "event-odds": { s: 60, swr: 180 },
};

const UPSTREAM_TIMEOUT_MS = 15_000;

// ── best-effort per-IP limiter ───────────────────────────────────────────────
// Per-instance only. Vercel may run many instances, so this catches a single
// noisy client hitting one warm instance and nothing more. The real protection
// is the allowlist + cache above.
const RATE_LIMIT = { windowMs: 60_000, max: 120 };
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now > rec.reset) {
    hits.set(ip, { count: 1, reset: now + RATE_LIMIT.windowMs });
    if (hits.size > 5000) {
      for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
    }
    return false;
  }
  rec.count += 1;
  return rec.count > RATE_LIMIT.max;
}

// ── helpers ──────────────────────────────────────────────────────────────────

// Read params via WHATWG URL. `req.query` routes through the legacy
// `url.parse()`, which is what fills the runtime logs with DEP0169.
function params(req) {
  return new URL(req.url, "http://localhost").searchParams;
}

function normalizeMarkets(raw) {
  const wanted = (raw || "")
    .split(",")
    .map((m) => m.trim().toLowerCase())
    .filter(Boolean);
  if (!wanted.length) return { error: "markets is required" };

  const bad = wanted.filter((m) => !MARKETS.has(m));
  if (bad.length) return { error: `unsupported market(s): ${bad.join(", ")}` };

  // Dedupe + sort so callers cannot fragment the cache by reordering.
  return { value: [...new Set(wanted)].sort().join(",") };
}

// `books` is part of the canonical URL, so it gets the same treatment as
// `markets`: trimmed and lowercased (idempotent, so the canonical form can
// never itself redirect), then checked against a closed set. An unrecognised
// value is a 400 rather than a silent fallback — a typo that quietly served
// the wrong book set would be invisible until the numbers looked wrong.
function normalizeBooks(raw) {
  if (raw === null) return { value: DEFAULT_BOOKS };
  const mode = raw.trim().toLowerCase();
  if (!mode) return { value: DEFAULT_BOOKS };
  if (!BOOK_MODES.has(mode)) {
    return { error: `unsupported books value: ${mode}` };
  }
  return { value: mode };
}

function fail(res, status, message) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json({ error: message });
}

// ── handler ──────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return fail(res, 405, "method not allowed");
  }

  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (rateLimited(ip)) {
    res.setHeader("Retry-After", "60");
    return fail(res, 429, "rate limit exceeded");
  }

  const q = params(req);
  const endpoint = (q.get("endpoint") || "").trim();

  let upstream;

  if (endpoint === "events") {
    upstream = new URL(`${UPSTREAM}/sports/${SPORT}/events`);
    upstream.searchParams.set("dateFormat", "iso");
  } else if (endpoint === "event-odds") {
    const eventId = (q.get("eventId") || "").trim().toLowerCase();
    if (!EVENT_ID.test(eventId)) {
      return fail(res, 400, "eventId must be 32 hex characters");
    }

    const markets = normalizeMarkets(q.get("markets"));
    if (markets.error) return fail(res, 400, markets.error);

    const booksMode = normalizeBooks(q.get("books"));
    if (booksMode.error) return fail(res, 400, booksMode.error);
    const books = booksMode.value;

    // The CDN keys on the *incoming* URL, not the upstream one we build below.
    // So canonicalising markets only for the upstream call does nothing to stop
    // someone permuting `markets` to mint a fresh cache entry on every request
    // and bill each one to the key — 15 markets is 15! distinct URLs for one
    // identical response.
    //
    // Redirecting to the canonical form collapses every permutation onto a
    // single cache key. The app already sends canonical requests, so it never
    // sees this hop. Sorting/deduping/lowercasing is idempotent, so the
    // redirect target can never itself redirect.
    //
    // `books` is part of that key: `core` and `wide` are different responses
    // and must not share an entry. Every input that resolves to the same mode
    // (absent, empty, `WIDE`, ` wide `) lands on the same single target, and
    // the resolved mode is always one of the literals in BOOK_MODES — so the
    // canonical URL re-parses to itself. The include flags are fixed, so they
    // stay out of the key entirely.
    const canonical =
      `/api/odds?endpoint=event-odds&eventId=${eventId}` +
      `&markets=${encodeURIComponent(markets.value)}&books=${books}`;
    const incoming = new URL(req.url, "http://localhost");
    if (incoming.pathname + incoming.search !== canonical) {
      // Cache the redirect too, or the redirect itself becomes the hot path.
      res.setHeader("Cache-Control", "public, s-maxage=600");
      res.setHeader("Location", canonical);
      return res.status(308).end();
    }

    upstream = new URL(`${UPSTREAM}/sports/${SPORT}/events/${eventId}/odds`);
    upstream.searchParams.set("markets", markets.value);
    upstream.searchParams.set("oddsFormat", "american");
    upstream.searchParams.set("dateFormat", "iso");

    // Always-on extras. Set before the book selection so nothing below can be
    // shadowed by them.
    for (const [k, v] of Object.entries(EVENT_ODDS_EXTRAS)) {
      upstream.searchParams.set(k, v);
    }

    // `core`/`wide` pin an explicit book list; `all` widens to whole regions.
    // All three are fixed strings chosen from a closed set, so none can be used
    // to inflate upstream cost beyond what the app itself would request.
    //
    // `bookmakers` takes priority over `regions` upstream, so the two are never
    // sent together — the pinned lists would silently win and make `all` a lie.
    if (books === "all") {
      upstream.searchParams.set("regions", ALL_REGIONS);
    } else {
      upstream.searchParams.set("bookmakers", BOOK_SETS[books].join(","));
    }
  } else {
    return fail(res, 400, "endpoint must be 'events' or 'event-odds'");
  }

  // Key resolution happens *after* the request is known to be well formed, so
  // a malformed request gets a useful 400 rather than a 500 that reveals
  // whether the deployment is configured.
  //
  // A caller-supplied key lets someone bring their own quota. Responses for
  // those requests must never enter the shared CDN cache.
  const byoKey = (req.headers["x-odds-key"] || "").trim();
  const key = byoKey || process.env.ODDS_API_KEY;
  if (!key) return fail(res, 500, "ODDS_API_KEY not configured");

  upstream.searchParams.set("apiKey", key);

  let resp, body;
  try {
    resp = await fetch(upstream.toString(), {
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    body = await resp.text();
  } catch (e) {
    const timedOut = e.name === "TimeoutError" || e.name === "AbortError";
    return fail(
      res,
      timedOut ? 504 : 502,
      timedOut ? "odds API timed out" : "odds API unreachable",
    );
  }

  // Surface remaining quota so the UI can show it and so you notice drain early.
  for (const h of ["x-requests-remaining", "x-requests-used", "x-requests-last"]) {
    const v = resp.headers.get(h);
    if (v) res.setHeader(h, v);
  }

  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (!resp.ok) {
    // Never echo the upstream URL — it carries the API key.
    res.setHeader("Cache-Control", "no-store");
    return res.status(resp.status).send(body);
  }

  if (byoKey) {
    res.setHeader("Cache-Control", "private, no-store");
  } else {
    const ttl = TTL[endpoint];
    res.setHeader(
      "Cache-Control",
      `public, s-maxage=${ttl.s}, stale-while-revalidate=${ttl.swr}`,
    );
  }

  return res.status(200).send(body);
}

export const config = { runtime: "nodejs", maxDuration: 20 };
