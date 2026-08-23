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
    // CORRECTED 2026-07-29 against a live `books=wide` response. Secondary
    // sources described Novig as mobile-app-only with no web product; the odds
    // feed disproves that. It returns a clean bookmaker-level page:
    //   https://novig.com/event-markets/019fa9e3-ef79-7bf1-826e-0470b7b6c03b
    // and an outcome-level link carrying an UNRESOLVED template placeholder:
    //   https://novig.com/events/{uuid}/oddsapi/{wager}
    // The placeholder is why `deepLink` is true but outcome links still get
    // rejected by `hasUnresolvedPlaceholder` below and fall back to the event
    // page. See that guard - it is general, not Novig-specific.
    web: true,
    deepLink: true,
    home: "https://novig.com",
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
/**
 * True when a link still contains an unsubstituted `{placeholder}`.
 *
 * The odds feed hands back templated URLs for some venues — Novig's outcome
 * links arrive as `https://novig.com/events/{uuid}/oddsapi/{wager}`, where
 * `{wager}` is meant to be filled in by the caller. Opening one verbatim lands
 * the user on a broken page, which is worse than dropping a tier and opening
 * the event page that definitely works.
 *
 * Deliberately general rather than a Novig special case: any venue can start
 * returning a template, and a link we cannot complete is not a link.
 *
 * @param {string} url
 * @returns {boolean}
 */
function hasUnresolvedPlaceholder(url) {
  return /\{[^}]*\}/.test(url);
}

/**
 * Link preferences the user controls in Settings (persisted as `linkPrefsV1`).
 *
 * @typedef {object} LinkPrefs
 * @property {number} [novigStake] - Stake prefilled into Novig's order slip.
 *   VERIFIED live 2026-07-31: `.../oddsapi/{wager}` with a number substituted
 *   redirects to `novig.com/?orderslip_outcomes=<uuid>&amount=<n>` with the
 *   exact side/line/price loaded in the order slip and the Take/Make toggle
 *   ready. Prefilling an amount places nothing — Novig still requires login
 *   and an explicit confirm.
 * @property {string} [mgmState] - Two-letter state code for BetMGM, whose
 *   links arrive as `https://sports.{state}.betmgm.com/...`. No sane default
 *   exists, so with this unset those links fall back a tier instead.
 */

export const DEFAULT_NOVIG_STAKE = 10;

/**
 * Fill the template placeholders we have VERIFIED values for; leave anything
 * unknown in place so `usable()` still rejects it. Case-per-placeholder, not
 * per-venue: any book could adopt `{state}` tomorrow.
 *
 * @param {string} url
 * @param {LinkPrefs} prefs
 * @returns {string}
 */
export function completeTemplate(url, prefs = {}) {
  let out = url;
  const stake = prefs.novigStake ?? DEFAULT_NOVIG_STAKE;
  if (Number.isFinite(stake) && stake > 0) {
    out = out.replaceAll("{wager}", String(Math.round(stake)));
  }
  const state = (prefs.mgmState || "").trim().toLowerCase();
  if (/^[a-z]{2}$/.test(state)) {
    out = out.replaceAll("{state}", state);
  }
  return out;
}

/**
 * A link is usable only if, after filling the placeholders we can complete,
 * nothing is left to fill in.
 */
function usable(raw, prefs) {
  const url = str(raw);
  if (!url) return null;
  const done = completeTemplate(url, prefs);
  return hasUnresolvedPlaceholder(done) ? null : done;
}

export function venueLink(key, ctx = {}, prefs = {}) {
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

  const outcome = usable(ctx.link, prefs);
  if (outcome) return settle(outcome, "outcome");

  const market = usable(ctx.marketLink, prefs);
  if (market) return settle(market, "market");

  const event = usable(ctx.eventLink, prefs);
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
    // The untouched outcome link, template placeholders and all. Rows are
    // built before user preferences are known; the UI re-completes this with
    // `completeTemplate(rawLink, loadLinkPrefs())` at render, which is how a
    // BetMGM `{state}` link becomes exact once the user sets a state code.
    rawLink: str(ctx.link) || null,
  };
}

/** localStorage key for LinkPrefs. */
export const LINK_PREFS_KEY = "linkPrefsV1";

/**
 * Read LinkPrefs from an injected storage (defaults to localStorage when
 * present — safe under SSR/tests where it is absent).
 *
 * @returns {LinkPrefs}
 */
export function loadLinkPrefs(storage) {
  const s =
    storage ?? (typeof localStorage !== "undefined" ? localStorage : null);
  if (!s) return {};
  try {
    const raw = JSON.parse(s.getItem(LINK_PREFS_KEY) || "{}");
    const prefs = {};
    const stake = Number(raw.novigStake);
    if (Number.isFinite(stake) && stake > 0) prefs.novigStake = stake;
    if (typeof raw.mgmState === "string") prefs.mgmState = raw.mgmState;
    return prefs;
  } catch {
    return {};
  }
}

/** Persist LinkPrefs. Merges nothing — callers pass the whole object. */
export function saveLinkPrefs(prefs, storage) {
  const s =
    storage ?? (typeof localStorage !== "undefined" ? localStorage : null);
  if (!s) return;
  try {
    s.setItem(LINK_PREFS_KEY, JSON.stringify(prefs || {}));
  } catch {
    /* quota — links just keep their defaults */
  }
}

/**
 * The best link for an offer once user preferences are applied: if the raw
 * templated outcome link completes cleanly under `prefs`, it wins (outcome
 * tier, exact for a deep-linkable venue); otherwise whatever the parse-time
 * hierarchy resolved stands.
 *
 * @param {RowVenue & {rawLink?: string|null}} offer
 * @param {LinkPrefs} prefs
 * @returns {{url: string|null, exact: boolean, granularity: string|null}}
 */
export function resolveOfferLink(offer, prefs = {}) {
  if (offer?.rawLink) {
    const done = completeTemplate(offer.rawLink, prefs);
    if (!hasUnresolvedPlaceholder(done)) {
      const found = venue(offer.key);
      return {
        url: done,
        exact: found?.deepLink === true,
        granularity: "outcome",
      };
    }
  }
  return {
    url: offer?.link ?? null,
    exact: offer?.exact ?? false,
    granularity: offer?.granularity ?? null,
  };
}
