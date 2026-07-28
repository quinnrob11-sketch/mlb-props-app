/**
 * Network access. Two same-origin proxies stand in front of the two upstreams
 * so that neither the MLB base URL nor the Odds API key is ever exposed to the
 * browser.
 *
 * Reconstructed from the minified bundle (`/tmp/work/app.js`, lines 588-621).
 * Minified origins: `zn` = mlbFetch, `Ua` = oddsFetch, `en` = SEASON,
 * `nl` = PRIOR_SEASON.
 *
 * The proxy contracts themselves live in `/tmp/work/api/mlb.js` and
 * `/tmp/work/api/odds.js`; the notes below mirror what those handlers accept.
 */

/**
 * Current MLB season.
 *
 * TODO(recon): this is evaluated once, at module load, from the *browser's
 * local* clock. Two consequences the original does not guard against: (a) any
 * date in Jan-Mar resolves to a season with no stats yet, so every shrunk rate
 * falls back to the league prior; (b) a user whose clock has rolled over to
 * Jan 1 in their timezone gets a different SEASON from a user who has not.
 *
 * @type {number}
 */
export const SEASON = new Date().getFullYear();

/**
 * The season before `SEASON`, used as the empirical-Bayes prior (weighted 0.6
 * against the current year in `shrunkRate`).
 *
 * @type {number}
 */
export const PRIOR_SEASON = SEASON - 1;

/** Both proxies are given 25 seconds before the client gives up. */
const REQUEST_TIMEOUT_MS = 25_000;

/**
 * Fetch a path from the MLB Stats API through the `/api/mlb` proxy.
 *
 * Contract: the *entire* upstream path including its query string is passed as
 * a single URL-encoded `path` parameter, e.g.
 *
 *   mlbFetch("/api/v1/schedule?sportId=1&date=2026-07-28")
 *     -> GET /api/mlb?path=%2Fapi%2Fv1%2Fschedule%3FsportId%3D1%26date%3D2026-07-28
 *
 * The proxy rejects anything that is not origin-relative, that escapes
 * statsapi.mlb.com, or whose pathname does not match its route allowlist.
 *
 * @param {string} path - Origin-relative upstream path, query string included.
 * @returns {Promise<object>} Parsed JSON body.
 * @throws {Error} `MLB API <status> on <path>` on any non-2xx response, or the
 *   underlying TimeoutError after 25s.
 */
export async function mlbFetch(path) {
  const res = await fetch("/api/mlb?path=" + encodeURIComponent(path), {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`MLB API ${res.status} on ${path}`);
  return res.json();
}

/**
 * @typedef {object} OddsResponse
 * @property {*} body - Parsed JSON body, or null if the response was not JSON.
 * @property {string|null} remaining - The upstream `x-requests-remaining`
 *   header, forwarded by the proxy. Used by the UI to display quota.
 */

/**
 * Fetch from The Odds API through the `/api/odds` proxy.
 *
 * Accepted parameter shapes:
 *
 *   { endpoint: "events" }
 *       -> the day's MLB events, each with `id`, `home_team`, `away_team`,
 *          `commence_time`.
 *
 *   { endpoint: "event-odds",
 *     eventId: <32 lowercase hex chars>,
 *     markets: "<comma separated allowlisted market keys>",
 *     books:   "core" | "all" }
 *       -> `books=core` pins the five book keys in CORE_BOOKS;
 *          `books=all` instead widens to the `us,us2` regions.
 *
 * Any other endpoint, a malformed eventId, or a market outside the proxy's
 * allowlist is rejected with a 400 before a credit is spent.
 *
 * TODO(recon): `books=all` is only ever sent in sharp mode, but `parseEventOdds`
 * reads *only* the five CORE_BOOKS out of the response, so every extra book the
 * wider request paid for is discarded. Worse, `all` swaps `bookmakers=` for
 * `regions=us,us2`, and Pinnacle - the one book the model deliberately weights
 * 3x - is not a US-region book, so sharp mode may be dropping exactly the quote
 * it is trying to emphasise. Verify against a live response before acting.
 *
 * @param {Record<string, string>} params - Query parameters, as above.
 * @param {string} [apiKey] - Caller-supplied Odds API key. When present it is
 *   sent as `x-odds-key` and the proxy marks the response `private, no-store`
 *   so a bring-your-own-key request never lands in the shared CDN cache.
 * @returns {Promise<OddsResponse>}
 * @throws {Error} `Odds API: <message>` with a `.status` property carrying the
 *   HTTP status. The message prefers the upstream's `message`, then
 *   `error_code`, then `error`, and finally falls back to `HTTP <status>`.
 */
export async function oddsFetch(params, apiKey) {
  const query = new URLSearchParams(params).toString();
  const headers = apiKey ? { "x-odds-key": apiKey } : {};

  const res = await fetch("/api/odds?" + query, {
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  // Read the quota header before touching the body: it is present on error
  // responses too, and a failed parse must not lose it.
  const remaining = res.headers.get("x-requests-remaining");

  // The proxy returns JSON on every path it controls, but an upstream 5xx can
  // still arrive as HTML. A parse failure is not fatal here; it degrades to a
  // generic `HTTP <status>` message below.
  let body;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (!res.ok) {
    const message =
      body?.message || body?.error_code || body?.error || `HTTP ${res.status}`;
    const err = new Error(`Odds API: ${message}`);
    err.status = res.status;
    throw err;
  }

  return { body, remaining };
}
