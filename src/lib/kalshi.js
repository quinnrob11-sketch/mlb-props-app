/**
 * Kalshi side-car client.
 *
 * Kalshi is an event-contract exchange, not a sportsbook. It publishes a free,
 * UNAUTHENTICATED REST API at
 *
 *     https://external-api.kalshi.com/trade-api/v2
 *
 * with (verified) `/markets?series_ticker=…&status=open`, `/events?series_ticker=…`
 * and `/markets/{ticker}/orderbook`. That is a second, independent read on the
 * same props The Odds API sells us, at zero credit cost - which is the entire
 * reason this module exists.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THREE THINGS THIS MODULE REFUSES TO DO
 *
 * 1. It does not call Kalshi directly from the browser. Kalshi's API sends no
 *    CORS headers, so a direct `fetch` from the app origin is blocked before it
 *    leaves the page. Every call here goes through a same-origin proxy path
 *    (`/api/kalshi`, see `api/kalshi.js`, same `?path=` contract as
 *    `/api/mlb`). `baseUrl` and `fetchImpl` are injectable so tests never touch
 *    the network and so a caller running server-side can point straight at
 *    `KALSHI_API_BASE`.
 *
 * 2. It does not collapse the book to one number. A price on an exchange is a
 *    bid and an ask; the spread is the cost of crossing it. `yes_bid`/`yes_ask`
 *    are exposed separately, and the midpoint is offered only as an explicitly
 *    labelled derived figure. A maker needs to know which side of the spread
 *    they are on.
 *
 * 3. It does not guess who a market is about. Kalshi encodes the player in a
 *    ticker segment and a title string; two players with similar names would be
 *    trivially conflatable. Matching reuses `normalizeName`/`matchName` from
 *    `lib/names.js` and reports AMBIGUOUS instead of picking - the same
 *    discipline `parseEventOdds` applies to the odds feed.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Ticker shapes (observed 2026-07-28):
 *
 *   event:  KXMLBHRR-26JUL281945CHCSTL
 *   market: KXMLBHRR-26JUL281945CHCSTL-CHCPRAMIREZ75-2
 *   game:   KXMLBGAME-26JUL281840AZPIT-AZ
 *
 * i.e. `SERIES-DATEGAME[-PLAYER][-THRESHOLD]`. The event ticker is always the
 * first two segments.
 */

import { matchName, normalizeName } from "./names.js";
import { impliedProb, probToAmerican } from "./odds.js";

/** Kalshi's public REST root. Direct browser calls to it are CORS-blocked. */
export const KALSHI_API_BASE = "https://external-api.kalshi.com/trade-api/v2";

/**
 * Same-origin proxy path. The contract mirrors `/api/mlb`: the whole upstream
 * path including its query string is passed URL-encoded as `?path=`.
 */
export const KALSHI_PROXY_PATH = "/api/kalshi";

/** Requests are given the same 25s budget as the app's other upstreams. */
const REQUEST_TIMEOUT_MS = 25_000;

/**
 * Our market keys -> the Kalshi series that prices them.
 *
 * Only mappings confirmed against live tickers are listed. `KXMLBSTATCOUNT`
 * exists and is an MLB prop series, but which of our market keys it corresponds
 * to has NOT been verified, so it is deliberately absent: an unmapped market
 * makes `matchKalshiMarket` refuse, which is the correct failure.
 *
 * @type {Record<string, string>}
 */
export const SERIES_BY_MARKET = {
  batter_hits_runs_rbis: "KXMLBHRR",
  batter_total_bases: "KXMLBTB",
};

/** Series that exist and are fetchable but are not mapped to a prop market. */
export const KNOWN_SERIES = {
  /** Hits + runs + RBIs. */
  KXMLBHRR: "batter_hits_runs_rbis",
  /** Total bases. */
  KXMLBTB: "batter_total_bases",
  /** A composite stat-count series; market mapping unverified. */
  KXMLBSTATCOUNT: null,
  /** Game lines (moneyline), not a player prop. */
  KXMLBGAME: null,
};

/**
 * The Kalshi series for one of our market keys.
 *
 * @param {string|null|undefined} marketKey
 * @returns {string|null} null when we have no verified mapping.
 */
export function seriesForMarket(marketKey) {
  return (marketKey && SERIES_BY_MARKET[marketKey]) || null;
}

// ── price conversion ────────────────────────────────────────────────────────

/**
 * Kalshi quotes in whole cents, 0-100, where the cent price IS the probability
 * (a contract settles at $1). Conversion into the app's conventions therefore
 * only needs a divide - and then the existing helpers in `lib/odds.js` do the
 * odds maths, which is not re-implemented here.
 *
 * @param {number|string|null|undefined} cents
 * @returns {number|null} Probability in [0, 1], or null when the input is not a
 *   finite number inside 0-100.
 */
export function centsToProbability(cents) {
  if (cents == null || cents === "") return null;
  const n = Number(cents);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return n / 100;
}

/**
 * Inverse of `centsToProbability`, rounded to a whole cent because that is the
 * only price Kalshi accepts. `probabilityToCents(centsToProbability(c)) === c`
 * for every integer c in [0, 100].
 *
 * @param {number|null|undefined} probability - In [0, 1].
 * @returns {number|null} Whole cents, or null for unusable input.
 */
export function probabilityToCents(probability) {
  if (probability == null) return null;
  const n = Number(probability);
  if (!Number.isFinite(n) || n < 0 || n > 1) return null;
  return Math.round(n * 100);
}

/**
 * Kalshi cents -> American odds, via the app's own `probToAmerican`.
 *
 * @param {number|null|undefined} cents
 * @returns {number|null} null at 0c and 100c, where there is no finite price.
 */
export function centsToAmerican(cents) {
  const probability = centsToProbability(cents);
  return probability == null ? null : probToAmerican(probability);
}

/**
 * American odds -> Kalshi cents, via the app's own `impliedProb`. Note this is
 * the VIG-INCLUSIVE implied probability of a book price; comparing it to a
 * Kalshi cent price compares a one-sided book number against an exchange quote,
 * which is what you want when asking "could I have got filled cheaper?".
 *
 * @param {number|null|undefined} american
 * @returns {number|null}
 */
export function americanToCents(american) {
  return probabilityToCents(impliedProb(american));
}

// ── ticker plumbing ─────────────────────────────────────────────────────────

/**
 * Series ticker for any Kalshi ticker (event or market): the first segment.
 *
 * @param {string|null|undefined} ticker
 * @returns {string|null}
 */
export function seriesTickerOf(ticker) {
  const text = String(ticker ?? "").trim();
  if (!text) return null;
  return text.split("-")[0] || null;
}

/**
 * Event ticker for a market ticker: the first two segments. Passing an event
 * ticker in returns it unchanged.
 *
 * @param {string|null|undefined} ticker
 * @returns {string|null}
 */
export function eventTickerOf(ticker) {
  const text = String(ticker ?? "").trim();
  if (!text) return null;
  const parts = text.split("-");
  return parts.length >= 2 ? `${parts[0]}-${parts[1]}` : null;
}

/**
 * The Kalshi threshold that expresses an over on one of our lines.
 *
 * Kalshi prop markets are "N or more" (>= N). A half-point over is exactly that
 * bet - over 1.5 is 2+ - so the mapping is `floor(line) + 1`.
 *
 * A WHOLE-number line is NOT convertible: "over 2.0" pushes on exactly 2 while
 * "2+" wins on it. They are different bets, so this returns null rather than
 * silently pairing a push-able book line with a non-push-able contract.
 *
 * @param {number|null|undefined} line
 * @returns {number|null}
 */
export function thresholdForLine(line) {
  if (line == null || line === "") return null;
  const n = Number(line);
  if (!Number.isFinite(n) || n < 0) return null;
  if (Number.isInteger(n)) return null; // push semantics differ; refuse
  return Math.floor(n) + 1;
}

/**
 * Pull the player's display name out of a raw Kalshi market.
 *
 * Sources, in order of trustworthiness:
 *   1. an explicit `player`/`yes_sub_title` field, when the payload carries one;
 *   2. the part of `title` before the first colon - the observed shape is
 *      "Pedro Ramirez: 2+ hits+runs+RBIs";
 *   3. nothing. The ticker's player segment ("CHCPRAMIREZ75") is a squashed
 *      team + initial + surname + number blob that cannot be reversed into a
 *      name without guessing, so it is NOT used as a name source.
 *
 * @param {object|null|undefined} raw
 * @returns {string|null}
 */
export function playerNameOf(raw) {
  if (!raw) return null;
  const explicit = raw.player ?? raw.yes_sub_title ?? raw.yesSubTitle ?? null;
  if (explicit && String(explicit).trim()) return String(explicit).trim();

  const title = String(raw.title ?? "").trim();
  if (title.includes(":")) {
    const head = title.slice(0, title.indexOf(":")).trim();
    if (head) return head;
  }
  return null;
}

/**
 * @typedef {object} KalshiMarket
 * @property {string} ticker - Full market ticker.
 * @property {string|null} eventTicker
 * @property {string|null} series
 * @property {string|null} player - Display name, when derivable.
 * @property {string} playerKey - `normalizeName(player)`; "" when unknown.
 * @property {number|null} threshold - The "N+" the contract settles on.
 * @property {string|null} status
 * @property {string|null} title
 * @property {number|null} yesBid - Cents. Best price a buyer of YES is bid.
 * @property {number|null} yesAsk - Cents. Best price YES is offered at.
 * @property {number|null} noBid
 * @property {number|null} noAsk
 * @property {number|null} last - Cents, last trade.
 * @property {number|null} volume
 * @property {number|null} openInterest
 * @property {number|null} liquidity
 * @property {object} raw - The untouched payload entry.
 */

/** Numeric field read that tolerates absent/blank/garbage. */
function num(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalise one raw Kalshi market into the shape the rest of the app uses.
 *
 * The threshold prefers the payload's own strike fields and only falls back to
 * the ticker's trailing numeric segment, so a series that changes its ticker
 * grammar degrades to "unknown threshold" rather than to a wrong one.
 *
 * @param {object|null|undefined} raw
 * @returns {KalshiMarket|null} null when there is no ticker to key on.
 */
export function normalizeMarket(raw) {
  if (!raw?.ticker) return null;
  const ticker = String(raw.ticker).trim();
  const player = playerNameOf(raw);

  const tail = ticker.split("-").pop();
  const threshold =
    num(raw.floor_strike) ??
    num(raw.floorStrike) ??
    num(raw.cap_strike) ??
    num(raw.capStrike) ??
    (/^\d+$/.test(tail || "") ? Number(tail) : null);

  return {
    ticker,
    eventTicker: raw.event_ticker ?? raw.eventTicker ?? eventTickerOf(ticker),
    series: raw.series_ticker ?? raw.seriesTicker ?? seriesTickerOf(ticker),
    player,
    playerKey: normalizeName(player),
    threshold,
    status: raw.status ?? null,
    title: raw.title ?? null,
    yesBid: num(raw.yes_bid ?? raw.yesBid),
    yesAsk: num(raw.yes_ask ?? raw.yesAsk),
    noBid: num(raw.no_bid ?? raw.noBid),
    noAsk: num(raw.no_ask ?? raw.noAsk),
    last: num(raw.last_price ?? raw.lastPrice),
    volume: num(raw.volume),
    openInterest: num(raw.open_interest ?? raw.openInterest),
    liquidity: num(raw.liquidity),
    raw,
  };
}

/**
 * @typedef {object} KalshiSide
 * @property {number|null} cents
 * @property {number|null} probability
 * @property {number|null} american
 */

/**
 * @typedef {object} KalshiQuote
 * @property {string} ticker
 * @property {KalshiSide} yesBid - What you can SELL yes at.
 * @property {KalshiSide} yesAsk - What you must PAY to buy yes.
 * @property {KalshiSide} noBid
 * @property {KalshiSide} noAsk
 * @property {number|null} spreadCents - `yesAsk - yesBid`. The cost of crossing.
 * @property {KalshiSide|null} mid - Midpoint, DERIVED. Provided for display
 *   only: no one can trade at it, and quoting it as "the price" is how an
 *   exchange's spread gets hidden from the person paying it.
 * @property {{volume: number|null, openInterest: number|null,
 *   liquidity: number|null}} depth
 */

/** Build one side descriptor from a cent price. */
function side(cents) {
  return {
    cents: cents ?? null,
    probability: centsToProbability(cents),
    american: centsToAmerican(cents),
  };
}

/**
 * Bid, ask, spread and depth for a market - never a single blended price.
 *
 * @param {KalshiMarket|object|null|undefined} market - A `normalizeMarket`
 *   result, or a raw payload entry (normalised on the way in).
 * @returns {KalshiQuote|null}
 */
export function marketQuote(market) {
  const m = market && "playerKey" in market ? market : normalizeMarket(market);
  if (!m) return null;

  const spreadCents =
    m.yesBid != null && m.yesAsk != null ? m.yesAsk - m.yesBid : null;
  const mid =
    m.yesBid != null && m.yesAsk != null ? side((m.yesBid + m.yesAsk) / 2) : null;

  return {
    ticker: m.ticker,
    yesBid: side(m.yesBid),
    yesAsk: side(m.yesAsk),
    noBid: side(m.noBid),
    noAsk: side(m.noAsk),
    spreadCents,
    mid,
    depth: {
      volume: m.volume,
      openInterest: m.openInterest,
      liquidity: m.liquidity,
    },
  };
}

// ── matching ────────────────────────────────────────────────────────────────

/**
 * @typedef {object} KalshiMatch
 * @property {"matched"|"ambiguous"|"missing"} status
 * @property {KalshiMarket|null} market
 * @property {string|null} ticker
 * @property {KalshiMarket[]} candidates - Everything that tied, when ambiguous.
 * @property {string|null} tier - Which name tier decided it.
 * @property {string|null} reason - Why it is not `matched`.
 */

const miss = (reason) => ({
  status: "missing",
  market: null,
  ticker: null,
  candidates: [],
  tier: null,
  reason,
});

/**
 * Map one of our prop rows onto a Kalshi market.
 *
 * The join is (series, player, threshold) and every step of it can refuse:
 *
 *   - the market key must have a VERIFIED series mapping (`SERIES_BY_MARKET`);
 *   - the line must be a half-point, so "N+" is the same bet (`thresholdForLine`);
 *   - the name must resolve to exactly one player in the candidate pool via
 *     `matchName`, which reports a tie as AMBIGUOUS rather than picking. A tie is
 *     returned as `status: "ambiguous"` with the candidates attached - the caller
 *     shows nothing rather than the wrong player's contract;
 *   - even after the player resolves, two markets at the same threshold for that
 *     player (a re-listed contract, a settled duplicate) is also AMBIGUOUS.
 *
 * @param {object} args
 * @param {string|{name?: string, fullName?: string}} args.player - Our player.
 * @param {string} args.market - Our market key, e.g. "batter_total_bases".
 * @param {number} args.line - Our line, e.g. 1.5.
 * @param {Array<KalshiMarket|object>} args.markets - Candidate Kalshi markets,
 *   raw or normalised.
 * @param {string} [args.eventTicker] - Restrict to one game when known.
 * @returns {KalshiMatch}
 */
export function matchKalshiMarket({
  player,
  market: marketKey,
  line,
  markets,
  eventTicker,
} = {}) {
  const name =
    typeof player === "string" ? player : (player?.name ?? player?.fullName ?? null);
  const key = normalizeName(name);
  if (!key) return miss("no player name supplied");

  const series = seriesForMarket(marketKey);
  if (!series) return miss(`no verified Kalshi series for market ${marketKey}`);

  const threshold = thresholdForLine(line);
  if (threshold == null) {
    return miss(
      Number.isInteger(Number(line))
        ? `line ${line} is a whole number; "N+" and "over N" are different bets`
        : `line ${line} cannot be expressed as a Kalshi threshold`,
    );
  }

  const pool = [];
  for (const entry of markets || []) {
    const normalised = entry && "playerKey" in entry ? entry : normalizeMarket(entry);
    if (!normalised) continue;
    if (normalised.series !== series) continue;
    if (eventTicker && normalised.eventTicker !== eventTicker) continue;
    if (!normalised.playerKey) continue;
    pool.push(normalised);
  }
  if (!pool.length) return miss("no open Kalshi markets in this series");

  // Name first, and never resolved by us: `matchName` owns the tiering and owns
  // the decision to refuse.
  const byKey = new Map();
  for (const entry of pool) {
    if (!byKey.has(entry.playerKey)) byKey.set(entry.playerKey, []);
    byKey.get(entry.playerKey).push(entry);
  }

  const nameMatch = matchName(key, [...byKey.keys()]);
  if (nameMatch.status === "missing") {
    return miss("no Kalshi market for this player");
  }
  if (nameMatch.status === "ambiguous") {
    return {
      status: "ambiguous",
      market: null,
      ticker: null,
      candidates: nameMatch.candidates.flatMap((k) => byKey.get(k) || []),
      tier: nameMatch.tier,
      reason: "more than one Kalshi player answers to this name",
    };
  }

  const forPlayer = byKey.get(nameMatch.key) || [];
  const atThreshold = forPlayer.filter((entry) => entry.threshold === threshold);
  if (!atThreshold.length) {
    return miss(`no ${threshold}+ contract for this player`);
  }
  if (atThreshold.length > 1) {
    return {
      status: "ambiguous",
      market: null,
      ticker: null,
      candidates: atThreshold,
      tier: nameMatch.tier,
      reason: `${atThreshold.length} Kalshi contracts at ${threshold}+ for this player`,
    };
  }

  return {
    status: "matched",
    market: atThreshold[0],
    ticker: atThreshold[0].ticker,
    candidates: atThreshold,
    tier: nameMatch.tier,
    reason: null,
  };
}

// ── network ─────────────────────────────────────────────────────────────────

/**
 * Build the URL for an upstream Kalshi path.
 *
 * With the default `baseUrl` (the same-origin proxy) the whole upstream path is
 * URL-encoded into `?path=`, exactly as `/api/mlb` does. Point `baseUrl` at
 * `KALSHI_API_BASE` to talk to Kalshi directly - valid from Node, blocked by
 * CORS from a browser.
 *
 * @param {string} path - Upstream path with query, e.g. "/markets?status=open".
 * @param {string} [baseUrl]
 * @returns {string}
 */
export function kalshiUrl(path, baseUrl = KALSHI_PROXY_PATH) {
  return baseUrl === KALSHI_PROXY_PATH
    ? `${KALSHI_PROXY_PATH}?path=${encodeURIComponent(path)}`
    : `${baseUrl}${path}`;
}

/**
 * @typedef {object} KalshiFetchOptions
 * @property {AbortSignal} [signal]
 * @property {typeof fetch} [fetchImpl] - Injected transport. Defaults to the
 *   ambient `fetch`; tests pass a stub and never open a socket.
 * @property {string} [baseUrl] - Defaults to the `/api/kalshi` proxy path.
 */

/** One GET, with the app's error vocabulary. */
async function get(path, { signal, fetchImpl, baseUrl } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== "function") {
    throw new Error("Kalshi: no fetch implementation available");
  }
  const url = kalshiUrl(path, baseUrl ?? KALSHI_PROXY_PATH);
  const res = await doFetch(url, {
    signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    const err = new Error(`Kalshi API ${res.status} on ${path}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/**
 * Fetch the open markets for one or more series.
 *
 * Series are fetched independently and a failure of one does NOT sink the rest:
 * Kalshi is a free bonus feed, and losing total-bases contracts is not a reason
 * to lose hits+runs+RBIs contracts. Failures are reported alongside the data.
 *
 * @param {object} args
 * @param {string[]} args.seriesTickers - e.g. ["KXMLBHRR", "KXMLBTB"].
 * @param {AbortSignal} [args.signal]
 * @param {typeof fetch} [args.fetchImpl]
 * @param {string} [args.baseUrl]
 * @param {string} [args.status] - Kalshi status filter, "open" by default.
 * @returns {Promise<{markets: KalshiMarket[], bySeries: Map<string, KalshiMarket[]>,
 *   errors: Array<{series: string, error: string}>}>}
 */
export async function fetchKalshiMarkets({
  seriesTickers,
  signal,
  fetchImpl,
  baseUrl,
  status = "open",
} = {}) {
  const series = [...new Set((seriesTickers || []).filter(Boolean))];
  const bySeries = new Map();
  const markets = [];
  const errors = [];

  const results = await Promise.all(
    series.map(async (ticker) => {
      try {
        const body = await get(
          `/markets?series_ticker=${encodeURIComponent(ticker)}` +
            `&status=${encodeURIComponent(status)}`,
          { signal, fetchImpl, baseUrl },
        );
        return { ticker, body, error: null };
      } catch (e) {
        return { ticker, body: null, error: e?.message || String(e) };
      }
    }),
  );

  for (const { ticker, body, error } of results) {
    if (error) {
      errors.push({ series: ticker, error });
      bySeries.set(ticker, []);
      continue;
    }
    const list = (body?.markets || [])
      .map(normalizeMarket)
      .filter(Boolean);
    bySeries.set(ticker, list);
    markets.push(...list);
  }

  return { markets, bySeries, errors };
}

/**
 * Fetch the events for a series. Useful on its own for building deep links,
 * since an event ticker is all `kalshiEventUrl` needs.
 *
 * @param {object} args
 * @param {string} args.seriesTicker
 * @param {AbortSignal} [args.signal]
 * @param {typeof fetch} [args.fetchImpl]
 * @param {string} [args.baseUrl]
 * @returns {Promise<object[]>} Raw event entries.
 */
export async function fetchKalshiEvents({
  seriesTicker,
  signal,
  fetchImpl,
  baseUrl,
} = {}) {
  if (!seriesTicker) return [];
  const body = await get(
    `/events?series_ticker=${encodeURIComponent(seriesTicker)}`,
    { signal, fetchImpl, baseUrl },
  );
  return body?.events || [];
}

/**
 * @typedef {object} OrderbookLevel
 * @property {number} cents
 * @property {number} contracts
 */

/**
 * @typedef {object} Orderbook
 * @property {string} ticker
 * @property {OrderbookLevel[]} yes - Resting YES bids, best (highest) first.
 * @property {OrderbookLevel[]} no - Resting NO bids, best first.
 * @property {number|null} bestYesBid - Cents.
 * @property {number|null} bestYesAsk - Cents. Derived: a resting NO bid at `n`
 *   is a YES offer at `100 - n`, which is how an exchange's two half-books make
 *   one two-sided market.
 * @property {number|null} spreadCents
 * @property {number} yesDepth - Contracts resting on the YES side.
 * @property {number} noDepth
 * @property {object} raw
 */

/** Kalshi returns levels as `[price_cents, contracts]` pairs. */
function levels(rows) {
  return (rows || [])
    .map((row) => ({ cents: num(row?.[0]), contracts: num(row?.[1]) ?? 0 }))
    .filter((level) => level.cents != null)
    .sort((a, b) => b.cents - a.cents);
}

/**
 * Normalise a `/markets/{ticker}/orderbook` payload.
 *
 * @param {string} ticker
 * @param {object|null|undefined} body
 * @returns {Orderbook}
 */
export function normalizeOrderbook(ticker, body) {
  const book = body?.orderbook || body || {};
  const yes = levels(book.yes);
  const no = levels(book.no);
  const bestYesBid = yes.length ? yes[0].cents : null;
  const bestNoBid = no.length ? no[0].cents : null;
  const bestYesAsk = bestNoBid == null ? null : 100 - bestNoBid;
  return {
    ticker,
    yes,
    no,
    bestYesBid,
    bestYesAsk,
    spreadCents:
      bestYesBid != null && bestYesAsk != null ? bestYesAsk - bestYesBid : null,
    yesDepth: yes.reduce((sum, level) => sum + level.contracts, 0),
    noDepth: no.reduce((sum, level) => sum + level.contracts, 0),
    raw: body ?? null,
  };
}

/**
 * Fetch and normalise one market's order book.
 *
 * @param {string} ticker - Full market ticker.
 * @param {KalshiFetchOptions} [options]
 * @returns {Promise<Orderbook|null>} null when no ticker was supplied.
 */
export async function fetchOrderbook(ticker, options = {}) {
  if (!ticker) return null;
  const body = await get(
    `/markets/${encodeURIComponent(ticker)}/orderbook`,
    options,
  );
  return normalizeOrderbook(ticker, body);
}
