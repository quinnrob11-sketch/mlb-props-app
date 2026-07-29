/**
 * Market, book and venue vocabulary.
 *
 * Reconstructed from the minified bundle (`/tmp/work/app.js`, lines 674-792).
 * Minified origins: `Eo` = PITCHER_MARKETS, `_o` = BATTER_MARKETS,
 * `id` = ALT_MARKETS, `Ka` = BASE_TO_ALT, `qp` = CORE_MARKET_LIST,
 * `eh` = marketsParam, `th` = CORE_BOOKS, `Ls` = BOOK_LABEL,
 * `nh` = BOOK_WEIGHT, `rh` = DOMED_PARKS.
 *
 * These tables are pure data; every key must stay byte-identical because they
 * are matched against The Odds API market keys and bookmaker keys, and the
 * `/api/odds` proxy rejects anything outside its own allowlist.
 */

/**
 * @typedef {object} MarketSpec
 * @property {string} label - Full display name for card headings.
 * @property {string} short - Compact badge text for dense tables.
 * @property {string} distKey - Key into `projection.dist`, i.e. the function
 *   that returns P(stat > line) for this market.
 * @property {string} projKey - Key on the projection object holding the point
 *   estimate shown next to the line.
 */

/**
 * Starting-pitcher prop markets.
 *
 * Note `pitcher_outs` has no alternate-market counterpart in ALT_MARKETS, so
 * it can only ever produce a main-line row plus alternates drawn from
 * off-consensus points inside the base market itself.
 *
 * @type {Record<string, MarketSpec>}
 */
export const PITCHER_MARKETS = {
  pitcher_strikeouts: {
    label: "Strikeouts",
    short: "K",
    distKey: "k",
    projKey: "projK",
  },
  pitcher_outs: {
    label: "Outs Recorded",
    short: "OUTS",
    distKey: "outs",
    projKey: "projOuts",
  },
  pitcher_hits_allowed: {
    label: "Hits Allowed",
    short: "HA",
    distKey: "hits",
    projKey: "projH",
  },
  pitcher_earned_runs: {
    label: "Earned Runs",
    short: "ER",
    distKey: "er",
    projKey: "projER",
  },
  pitcher_walks: {
    label: "Walks",
    short: "BB",
    distKey: "bb",
    projKey: "projBB",
  },
};

/**
 * Batter prop markets.
 *
 * `distKey` collisions across the two tables are intentional and harmless:
 * `pitcher_hits_allowed` and `batter_hits` both use "hits", but each is looked
 * up on its own projection object (pitcher vs batter), never on a shared one.
 *
 * @type {Record<string, MarketSpec>}
 */
export const BATTER_MARKETS = {
  batter_hits: {
    label: "Hits",
    short: "H",
    distKey: "hits",
    projKey: "projH",
  },
  batter_total_bases: {
    label: "Total Bases",
    short: "TB",
    distKey: "tb",
    projKey: "projTB",
  },
  batter_home_runs: {
    label: "Home Runs",
    short: "HR",
    distKey: "hr",
    projKey: "projHR",
  },
  batter_hits_runs_rbis: {
    label: "H+R+RBI",
    short: "HRR",
    distKey: "hrr",
    projKey: "projHRR",
  },
  batter_runs_scored: {
    label: "Runs",
    short: "R",
    distKey: "runs",
    projKey: "projR",
  },
  batter_rbis: {
    label: "RBIs",
    short: "RBI",
    distKey: "rbi",
    projKey: "projRBI",
  },
  batter_singles: {
    label: "Singles",
    short: "1B",
    distKey: "singles",
    projKey: "proj1B",
  },
  batter_strikeouts: {
    label: "Batter Ks",
    short: "K",
    distKey: "k",
    projKey: "projK",
  },
  batter_stolen_bases: {
    label: "Stolen Bases",
    short: "SB",
    distKey: "sb",
    projKey: "projSB",
  },
};

/**
 * Alternate market key -> the base market it belongs to.
 *
 * Only seven of the fourteen base markets have an alternate ladder. The Odds
 * API exposes alternates as separate market keys carrying the same player
 * descriptions at a spread of points.
 *
 * @type {Record<string, string>}
 */
export const ALT_MARKETS = {
  pitcher_strikeouts_alternate: "pitcher_strikeouts",
  pitcher_hits_allowed_alternate: "pitcher_hits_allowed",
  pitcher_walks_alternate: "pitcher_walks",
  batter_hits_alternate: "batter_hits",
  batter_total_bases_alternate: "batter_total_bases",
  batter_home_runs_alternate: "batter_home_runs",
  batter_rbis_alternate: "batter_rbis",
};

/**
 * Base market key -> its alternate market key. Inverse of ALT_MARKETS.
 *
 * The inversion is safe because ALT_MARKETS is one-to-one; if two alternates
 * ever mapped to the same base, the later entry would silently win here.
 *
 * @type {Record<string, string>}
 */
export const BASE_TO_ALT = Object.fromEntries(
  Object.entries(ALT_MARKETS).map(([alt, base]) => [base, alt]),
);

/**
 * Every non-alternate market the app requests, plus the first-inning game
 * total that drives NRFI/YRFI.
 *
 * `totals_1st_1_innings` is a team market, not a player prop, and is the one
 * key `parseEventOdds` files under the sentinel player key `"__game__"`.
 *
 * @type {string[]}
 */
export const CORE_MARKET_LIST = [
  ...Object.keys(PITCHER_MARKETS),
  ...Object.keys(BATTER_MARKETS),
  "totals_1st_1_innings",
];

/**
 * Build the `markets` query parameter for `/api/odds?endpoint=event-odds`.
 *
 * @param {boolean} includeAlternates - Sharp mode. Adds every alternate ladder,
 *   roughly doubling the market count and the upstream credit cost.
 * @returns {string} Comma-separated market keys. The proxy lowercases, dedupes
 *   and sorts this before forwarding.
 *
 * Sorted and deduped here so the emitted URL is already in the proxy's
 * canonical form. The proxy 308s anything non-canonical onto a single CDN
 * cache key (see api/odds.js); matching that form up front means the app's own
 * requests never pay for the redirect hop.
 */
export const marketsParam = (includeAlternates) =>
  [
    ...new Set([
      ...CORE_MARKET_LIST,
      ...(includeAlternates ? Object.keys(ALT_MARKETS) : []),
    ]),
  ]
    .sort()
    .join(",");

/**
 * The only bookmakers ever read out of an odds response.
 *
 * This list is both the `books=core` request set and the parse filter in
 * `parseEventOdds`. A response containing other books (which is what
 * `books=all` asks for) has those books silently discarded.
 *
 * @type {string[]}
 */
export const CORE_BOOKS = [
  "draftkings",
  "fanduel",
  "betmgm",
  "caesars",
  "pinnacle",
];

/**
 * The exchange and DFS venues `/api/odds` now requests alongside CORE_BOOKS
 * (`books=wide`). They are READ but they are NOT part of the consensus:
 *
 *   - a DFS entry is a line plus a payout multiplier, not a two-sided price, and
 *     the upstream marks these "indicative only" - averaging one into a fair
 *     probability would be a category error;
 *   - an exchange quote is a bid/ask pair whose spread means something different
 *     from a book's hold.
 *
 * `parseEventOdds` therefore tags their quotes `consensus: false`, which keeps
 * them out of the modal-point vote, out of `nBooks` and out of `evaluateEdge`,
 * while still letting a row show where else the same line is available and at
 * what payout. See `VENUES` in `lib/venues.js` for what each one is.
 *
 * @type {string[]}
 */
export const EXTRA_BOOKS = [
  "kalshi",
  "novig",
  "prizepicks",
  "pick6",
  "betr_us_dfs",
];

/**
 * Every bookmaker key `parseEventOdds` will read out of a response, consensus
 * books first. A response containing anything else has it silently discarded.
 *
 * @type {string[]}
 */
export const PARSED_BOOKS = [...CORE_BOOKS, ...EXTRA_BOOKS];

/**
 * Odds API bookmaker key -> the short label used on rows and in BOOK_WEIGHT.
 *
 * Kept byte-identical to `VENUES[key].short` in `lib/venues.js`, which is the
 * single source of truth for venue identity; `test/venues.test.js` asserts the
 * two tables agree so they cannot drift apart.
 *
 * @type {Record<string, string>}
 */
export const BOOK_LABEL = {
  draftkings: "DK",
  fanduel: "FD",
  betmgm: "MGM",
  caesars: "CZR",
  pinnacle: "PIN",
  kalshi: "KAL",
  novig: "NVG",
  prizepicks: "PP",
  pick6: "PK6",
  betr_us_dfs: "BETR",
};

/**
 * Consensus weight by book label; anything not listed weighs 1.
 *
 * Pinnacle counts triple because it is a low-margin, high-limit book whose
 * de-vigged price is the closest thing available to a true probability. A
 * quote from a weighted book also sets the `sharp` flag on the consensus.
 *
 * @type {Record<string, number>}
 */
export const BOOK_WEIGHT = { PIN: 3 };

/**
 * Venues where weather is irrelevant, keyed by the MLB `venue.name` string.
 *
 * Matched by exact string equality against the schedule payload, so a venue
 * rename upstream silently reintroduces a weather lookup for a closed roof.
 * Both "Daikin Park" and "Minute Maid Park" are listed for exactly that
 * reason (Houston renamed in 2025).
 *
 * Retractable-roof parks are treated as always-closed here, which is a
 * simplification: Rogers Centre, Chase Field, Globe Life Field, American
 * Family Field and loanDepot park all play open on mild days.
 *
 * @type {Set<string>}
 */
export const DOMED_PARKS = new Set([
  "Tropicana Field",
  "Rogers Centre",
  "Chase Field",
  "Daikin Park",
  "Minute Maid Park",
  "Globe Life Field",
  "American Family Field",
  "loanDepot park",
]);
