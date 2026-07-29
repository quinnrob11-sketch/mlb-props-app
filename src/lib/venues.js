/**
 * Where a price came from, and where a click should go.
 *
 * This module is the single source of truth for venue identity (is this a
 * sportsbook, an exchange or a DFS app?) and for turning whatever link material
 * the odds feed gave us into ONE honest answer: a URL plus how precisely that
 * URL lands on the bet we are showing.
 *
 * It is deliberately pure - no fetch, no React, no imports from anywhere in the
 * app - so it can be used from the model layer, the UI layer and a test runner
 * without dragging anything along.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY `exact` EXISTS
 *
 * The Odds API's `includeLinks` returns links at three tiers and documents a
 * fallback hierarchy: outcome -> market -> event. Only the outcome tier lands on
 * the specific side of the specific line we priced. Every coarser tier is a
 * best-effort "here is roughly where that bet lives", and some venues have no
 * web destination at all:
 *
 *   novig  - mobile app only, no web product, no deep link. There is nowhere to
 *            send a browser, so `venueLink` returns null rather than inventing a
 *            destination. (The price is still real; only the click is missing.)
 *   kalshi - has a public, unauthenticated deep-link form, but it only resolves
 *            to game + prop-type granularity, never to a single player and never
 *            to a side. It is therefore `granularity: "event"`, `exact: false`.
 *
 * A UI that renders every link identically would tell the user "click here for
 * this bet" when the truth is "click here for this game". `granularity`/`exact`
 * exist so it can tell the truth instead.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * @typedef {"book"|"exchange"|"dfs"} VenueKind
 *   book     - a traditional sportsbook posting two-sided American prices.
 *   exchange - peer-to-peer / event contracts. Prices are a bid/ask pair, and
 *              the spread matters as much as the midpoint.
 *   dfs      - a line plus a payout multiplier, not a two-sided price. The Odds
 *              API marks these "indicative only".
 */

/**
 * @typedef {object} Venue
 * @property {string} key - The Odds API bookmaker key. The join key everywhere.
 * @property {string} label - Full display name.
 * @property {string} short - Compact badge text; matches `BOOK_LABEL` in
 *   `markets.js` for the five core books (asserted in test/venues.test.js).
 * @property {VenueKind} kind
 * @property {boolean} web - Has a web product a browser can be sent to at all.
 * @property {boolean} deepLink - Can address something more specific than its
 *   own homepage. `false` means no URL this module ever produces for it may be
 *   reported as `exact`.
 * @property {string|null} home - Brand homepage, the last-resort link tier.
 */

/**
 * Every venue the app can receive a price from.
 *
 * Keys are Odds API bookmaker keys and must stay byte-identical: they are what
 * `/api/odds` allowlists, what the payload is keyed by and what `parseEventOdds`
 * files quotes under.
 *
 * @type {Record<string, Venue>}
 */
export const VENUES = {
  // ── traditional sportsbooks ───────────────────────────────────────────────
  draftkings: {
    key: "draftkings",
    label: "DraftKings",
    short: "DK",
    kind: "book",
    web: true,
    deepLink: true,
    home: "https://sportsbook.draftkings.com",
  },
  fanduel: {
    key: "fanduel",
    label: "FanDuel",
    short: "FD",
    kind: "book",
    web: true,
    deepLink: true,
    home: "https://sportsbook.fanduel.com",
  },
  betmgm: {
    key: "betmgm",
    label: "BetMGM",
    short: "MGM",
    kind: "book",
    web: true,
    deepLink: true,
    home: "https://sports.betmgm.com",
  },
  caesars: {
    key: "caesars",
    label: "Caesars",
    short: "CZR",
    kind: "book",
    web: true,
    deepLink: true,
    home: "https://sportsbook.caesars.com",
  },
  pinnacle: {
    key: "pinnacle",
    label: "Pinnacle",
    short: "PIN",
    kind: "book",
    web: true,
    deepLink: true,
    home: "https://www.pinnacle.com",
  },

  // ── exchanges ─────────────────────────────────────────────────────────────
  kalshi: {
    key: "kalshi",
    label: "Kalshi",
    short: "KAL",
    kind: "exchange",
    web: true,
    // True, but coarse: see `kalshiEventUrl`. A template-built Kalshi URL is
    // never `exact`; only an outcome-tier link handed to us by the odds feed is.
    deepLink: true,
    home: "https://kalshi.com",
  },
  novig: {
    key: "novig",
    label: "Novig",
    short: "NVG",
    kind: "exchange",
    // Mobile app only. There is no web product and no documented deep link, so
    // there is no URL to hand a browser - verified, not assumed.
    web: false,
    deepLink: false,
    home: null,
  },

  // ── DFS (line + payout multiplier, not a two-sided price) ─────────────────
  prizepicks: {
    key: "prizepicks",
    label: "PrizePicks",
    short: "PP",
    kind: "dfs",
    web: true,
    deepLink: true,
    home: "https://app.prizepicks.com",
  },
  pick6: {
    key: "pick6",
    label: "DraftKings Pick6",
    short: "PK6",
    kind: "dfs",
    web: true,
    deepLink: true,
    home: "https://pick6.draftkings.com",
  },
  betr_us_dfs: {
    key: "betr_us_dfs",
    label: "Betr Picks",
    short: "BETR",
    kind: "dfs",
    web: true,
    deepLink: true,
    home: "https://www.betr.app",
  },
};

/** Every venue key, in declaration order. @type {string[]} */
export const VENUE_KEYS = Object.keys(VENUES);

/** short badge -> venue key, so a row that only kept a label can still resolve. */
const KEY_BY_SHORT = new Map(
  VENUE_KEYS.map((key) => [VENUES[key].short.toUpperCase(), key]),
);

/**
 * Look a venue up by its Odds API key.
 *
 * @param {string|null|undefined} key
 * @returns {Venue|null}
 */
export function venue(key) {
  return (key && VENUES[key]) || null;
}

/**
 * Resolve a venue from a short badge ("DK", "PIN", "KAL"), case-insensitively.
 * Quotes built by hand (fixtures, older callers) carry only the short label.
 *
 * @param {string|null|undefined} short
 * @returns {string|null} The venue key, or null.
 */
export function venueKeyByShort(short) {
  if (!short) return null;
  return KEY_BY_SHORT.get(String(short).trim().toUpperCase()) ?? null;
}

/** @param {string|null|undefined} key @returns {boolean} */
export function isDfs(key) {
  return venue(key)?.kind === "dfs";
}

/** @param {string|null|undefined} key @returns {boolean} */
export function isExchange(key) {
  return venue(key)?.kind === "exchange";
}

/** @param {string|null|undefined} key @returns {boolean} */
export function isBook(key) {
  return venue(key)?.kind === "book";
}

// ── Kalshi deep links ───────────────────────────────────────────────────────

/** Kalshi's public web host. */
const KALSHI_WEB = "https://kalshi.com";

/**
 * Build the public Kalshi market URL for an event.
 *
 * The documented, verified-working form is
 *
 *     https://kalshi.com/markets/{series_lower}/-/{event_ticker_lower}
 *
 * The `-` in the slug position is NOT a placeholder we invented: it is what
 * Kalshi itself serves, and it resolves unauthenticated. The human-readable
 * slug is not exposed anywhere in the public API and cannot be derived from the
 * series title, so `-` is the only honest thing to put there.
 *
 * The URL lands on the event - i.e. one game and one prop type - not on a
 * player and not on a side. There are no query parameters that preselect
 * either. Callers must therefore treat it as `granularity: "event"`.
 *
 * @param {string|null|undefined} seriesTicker - e.g. "KXMLBHRR".
 * @param {string|null|undefined} eventTicker - e.g. "KXMLBHRR-26JUL281945CHCSTL".
 * @returns {string|null} null when either ticker is missing/blank.
 */
export function kalshiEventUrl(seriesTicker, eventTicker) {
  const series = String(seriesTicker ?? "").trim();
  const event = String(eventTicker ?? "").trim();
  if (!series || !event) return null;
  return `${KALSHI_WEB}/markets/${series.toLowerCase()}/-/${event.toLowerCase()}`;
}

/**
 * Venue-specific URL builders, tried after every link the feed supplied has
 * been exhausted and before the brand homepage.
 *
 * Each returns `{ url, granularity }` or null. `exact` is decided centrally in
 * `venueLink` so a builder cannot accidentally claim precision it does not have.
 *
 * @type {Record<string, (ctx: VenueLinkContext) => {url: string, granularity: string}|null>}
 */
const BUILDERS = {
  kalshi(ctx) {
    const url = kalshiEventUrl(ctx.seriesTicker, ctx.eventTicker);
    return url ? { url, granularity: "event" } : null;
  },
};

// ── the link hierarchy ──────────────────────────────────────────────────────

/**
 * @typedef {object} VenueLinkContext
 * @property {string|null} [link] - Outcome-tier link from the odds feed. The
 *   only tier that addresses this side of this line.
 * @property {string|null} [sid] - The feed's outcome id. Carried through for
 *   callers that want to log/diagnose; it is not used to build a URL.
 * @property {string|null} [marketLink] - Market-tier link.
 * @property {string|null} [eventLink] - Event/bookmaker-tier link.
 * @property {string|null} [seriesTicker] - Kalshi series, for the builder tier.
 * @property {string|null} [eventTicker] - Kalshi event, for the builder tier.
 */

/**
 * @typedef {object} VenueLink
 * @property {string} url
 * @property {"outcome"|"market"|"event"|"brand"} granularity - How precisely
 *   `url` lands on the thing being shown.
 * @property {boolean} exact - True only when `url` is the specific outcome
 *   (side + line) we priced. Anything coarser is false, and a venue whose
 *   `deepLink` is false can never be true.
 */

/** Blank-safe string read. */
const str = (value) => {
  const text = value == null ? "" : String(value).trim();
  return text || null;
};

/**
 * Resolve the best available link for a venue.
 *
 * Fallback hierarchy, strongest first:
 *
 *   1. outcome link from the odds feed  -> granularity "outcome", exact true
 *   2. market link from the odds feed   -> granularity "market",  exact false
 *   3. event link from the odds feed    -> granularity "event",   exact false
 *   4. a venue-specific builder         -> whatever it reports,   exact false
 *   5. the brand homepage               -> granularity "brand",   exact false
 *
 * A venue with `web: false` (novig) short-circuits to null at the top: there is
 * no browser destination for it at any tier, and pretending otherwise is the
 * exact dishonesty `exact` was added to prevent.
 *
 * @param {string|null|undefined} key - Odds API bookmaker key.
 * @param {VenueLinkContext} [ctx]
 * @returns {VenueLink|null} null for an unknown venue, a web-less venue, or a
 *   venue with nothing to link to at any tier.
 */
export function venueLink(key, ctx = {}) {
  const found = venue(key);
  if (!found) return null;
  // No web product => nowhere to click, at any tier.
  if (!found.web) return null;

  const settle = (url, granularity) => ({
    url,
    granularity,
    // Precision is claimed in exactly one place, and only the outcome tier of a
    // venue that can actually deep-link may claim it.
    exact: granularity === "outcome" && found.deepLink === true,
  });

  const outcome = str(ctx.link);
  if (outcome) return settle(outcome, "outcome");

  const market = str(ctx.marketLink);
  if (market) return settle(market, "market");

  const event = str(ctx.eventLink);
  if (event) return settle(event, "event");

  const built = BUILDERS[found.key]?.(ctx) || null;
  if (built?.url) return settle(built.url, built.granularity);

  const home = str(found.home);
  return home ? settle(home, "brand") : null;
}

/**
 * The compact venue descriptor rows carry.
 *
 * @typedef {object} RowVenue
 * @property {string} key
 * @property {string} label
 * @property {VenueKind} kind
 * @property {string|null} link - Best available URL, or null when there is none.
 * @property {boolean} exact - Whether `link` is the specific outcome.
 * @property {"outcome"|"market"|"event"|"brand"|null} granularity - Kept
 *   alongside `exact` so the UI can word the difference between "this bet",
 *   "this market" and "this venue".
 */

/**
 * Build the descriptor a priced row hangs off itself.
 *
 * @param {string|null|undefined} key
 * @param {VenueLinkContext} [ctx]
 * @returns {RowVenue|null} null when the venue is unknown.
 */
export function rowVenue(key, ctx = {}) {
  const found = venue(key);
  if (!found) return null;
  const link = venueLink(key, ctx);
  return {
    key: found.key,
    label: found.label,
    kind: found.kind,
    link: link?.url ?? null,
    exact: link?.exact ?? false,
    granularity: link?.granularity ?? null,
  };
}
