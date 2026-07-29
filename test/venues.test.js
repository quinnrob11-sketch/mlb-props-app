/**
 * Venue identity and link honesty.
 *
 * The thing under test is not "does a URL come back" - it is "does the module
 * ever claim more precision than it has". Every tier of the fallback hierarchy
 * is exercised, and the two venues that cannot be linked at all (novig) or
 * cannot be linked precisely (kalshi's template) are pinned explicitly.
 *
 * Run: npm test
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  VENUES,
  VENUE_KEYS,
  isBook,
  isDfs,
  isExchange,
  kalshiEventUrl,
  rowVenue,
  venue,
  venueKeyByShort,
  venueLink,
} from "../src/lib/venues.js";
import { BOOK_LABEL, CORE_BOOKS, EXTRA_BOOKS, PARSED_BOOKS } from "../src/lib/markets.js";
import { attachLines, bestQuote, parseEventOdds } from "../src/model/lines.js";
import { BATTER_MARKETS } from "../src/lib/markets.js";

// ── 1. the table itself ─────────────────────────────────────────────────────

test("every book the parser reads has a venue, and the two tables agree", () => {
  for (const key of PARSED_BOOKS) {
    const found = venue(key);
    assert.ok(found, `no VENUES entry for ${key}`);
    assert.equal(found.key, key, "VENUES entries must be self-keyed");
    assert.equal(
      BOOK_LABEL[key],
      found.short,
      `BOOK_LABEL and VENUES disagree on the badge for ${key}`,
    );
  }
  // and nothing in VENUES is unreachable from the parser
  assert.deepEqual([...VENUE_KEYS].sort(), [...PARSED_BOOKS].sort());
});

test("kinds are classified, and the classifiers are mutually exclusive", () => {
  assert.deepEqual(CORE_BOOKS.filter(isBook), CORE_BOOKS);
  assert.deepEqual(EXTRA_BOOKS.filter(isDfs), ["prizepicks", "pick6", "betr_us_dfs"]);
  assert.deepEqual(EXTRA_BOOKS.filter(isExchange), ["kalshi", "novig"]);

  for (const key of VENUE_KEYS) {
    const flags = [isBook(key), isExchange(key), isDfs(key)].filter(Boolean);
    assert.equal(flags.length, 1, `${key} must be exactly one kind`);
  }
  // An unknown key is nothing at all rather than a defaulted "book".
  assert.equal(isBook("nowhere"), false);
  assert.equal(isDfs(null), false);
  assert.equal(isExchange(undefined), false);
});

test("a badge resolves back to its venue key, case-insensitively", () => {
  assert.equal(venueKeyByShort("PIN"), "pinnacle");
  assert.equal(venueKeyByShort(" dk "), "draftkings");
  assert.equal(venueKeyByShort("BETR"), "betr_us_dfs");
  assert.equal(venueKeyByShort("nope"), null);
  assert.equal(venueKeyByShort(null), null);
});

// ── 2. the Kalshi URL template ──────────────────────────────────────────────

test("the Kalshi deep link renders exactly the documented form", () => {
  // Real tickers observed 2026-07-28.
  assert.equal(
    kalshiEventUrl("KXMLBHRR", "KXMLBHRR-26JUL281945CHCSTL"),
    "https://kalshi.com/markets/kxmlbhrr/-/kxmlbhrr-26jul281945chcstl",
  );
  assert.equal(
    kalshiEventUrl("KXMLBGAME", "KXMLBGAME-26JUL281840AZPIT"),
    "https://kalshi.com/markets/kxmlbgame/-/kxmlbgame-26jul281840azpit",
  );
  // The `-` slug segment is a real placeholder Kalshi serves, not a gap we left.
  assert.match(
    kalshiEventUrl("KXMLBTB", "KXMLBTB-26JUL281945CHCSTL"),
    /\/markets\/[a-z0-9]+\/-\/[a-z0-9-]+$/,
  );
  assert.equal(kalshiEventUrl("", "KXMLBHRR-26JUL281945CHCSTL"), null);
  assert.equal(kalshiEventUrl("KXMLBHRR", null), null);
});

// ── 3. the fallback hierarchy, tier by tier ─────────────────────────────────

test("venueLink degrades through all four tiers", () => {
  const ctx = {
    link: "https://sportsbook.draftkings.com/event/1?outcome=abc",
    marketLink: "https://sportsbook.draftkings.com/event/1?market=hits",
    eventLink: "https://sportsbook.draftkings.com/event/1",
  };

  // 1. outcome
  const outcome = venueLink("draftkings", ctx);
  assert.equal(outcome.granularity, "outcome");
  assert.equal(outcome.url, ctx.link);
  assert.equal(outcome.exact, true);

  // 2. market
  const market = venueLink("draftkings", { ...ctx, link: null });
  assert.equal(market.granularity, "market");
  assert.equal(market.url, ctx.marketLink);
  assert.equal(market.exact, false);

  // 3. event
  const event = venueLink("draftkings", { ...ctx, link: null, marketLink: null });
  assert.equal(event.granularity, "event");
  assert.equal(event.url, ctx.eventLink);
  assert.equal(event.exact, false);

  // 4. brand — nothing left but the homepage
  const brand = venueLink("draftkings", {});
  assert.equal(brand.granularity, "brand");
  assert.equal(brand.url, VENUES.draftkings.home);
  assert.equal(brand.exact, false);

  // blank strings are not links
  assert.equal(venueLink("draftkings", { link: "   " }).granularity, "brand");
});

test("the venue-specific builder sits between the feed's links and the brand", () => {
  const built = venueLink("kalshi", {
    seriesTicker: "KXMLBHRR",
    eventTicker: "KXMLBHRR-26JUL281945CHCSTL",
  });
  assert.equal(
    built.url,
    "https://kalshi.com/markets/kxmlbhrr/-/kxmlbhrr-26jul281945chcstl",
  );
  assert.equal(built.granularity, "event");
  // The template lands on game + prop type, never on a player or a side.
  assert.equal(built.exact, false);

  // With no tickers there is nothing to build, so it falls to the brand tier.
  assert.equal(venueLink("kalshi", {}).granularity, "brand");
  assert.equal(venueLink("kalshi", {}).url, "https://kalshi.com");

  // A feed-supplied outcome link still outranks the builder.
  const fed = venueLink("kalshi", {
    link: "https://kalshi.com/markets/kxmlbhrr/-/kxmlbhrr-26jul281945chcstl#x",
    seriesTicker: "KXMLBHRR",
    eventTicker: "KXMLBHRR-26JUL281945CHCSTL",
  });
  assert.equal(fed.granularity, "outcome");
});

test("novig has nowhere to click and is never reported as exact", () => {
  // No web product, no deep link — verified, not assumed.
  assert.equal(VENUES.novig.web, false);
  assert.equal(VENUES.novig.deepLink, false);

  const contexts = [
    {},
    { link: "https://novig.us/bet/123" },
    { marketLink: "https://novig.us/market/1" },
    { eventLink: "https://novig.us/event/1" },
    { link: "https://novig.us/bet/123", marketLink: "https://novig.us/m" },
  ];
  for (const ctx of contexts) {
    const link = venueLink("novig", ctx);
    assert.equal(link, null, "novig must not produce a browser destination");
  }

  // ...and the row descriptor says so too, rather than omitting the venue.
  const row = rowVenue("novig", { link: "https://novig.us/bet/123" });
  assert.equal(row.key, "novig");
  assert.equal(row.kind, "exchange");
  assert.equal(row.link, null);
  assert.equal(row.exact, false);
  assert.equal(row.granularity, null);
});

test("an unknown venue produces nothing at all", () => {
  assert.equal(venueLink("sportsbet_atlantis", { link: "https://x.example" }), null);
  assert.equal(rowVenue("sportsbet_atlantis"), null);
  assert.equal(venue(null), null);
});

// ── 4. what reaches a row ───────────────────────────────────────────────────

/** Minimal projection stub: every line is a coin flip. */
const projection = {
  dist: { hits: () => 0.6 },
  projH: 1.1,
};

const markets = { batter_hits: BATTER_MARKETS.batter_hits };

/** One event payload with a book, an exchange and a DFS app on the same line. */
function payload() {
  return {
    bookmakers: [
      {
        key: "draftkings",
        link: "https://sportsbook.draftkings.com/event/1",
        markets: [
          {
            key: "batter_hits",
            link: "https://sportsbook.draftkings.com/event/1?market=hits",
            outcomes: [
              {
                name: "Over",
                description: "Pedro Ramirez",
                point: 1.5,
                price: 120,
                link: "https://sportsbook.draftkings.com/event/1?outcome=over",
                sid: "dk-over-1",
              },
              {
                name: "Under",
                description: "Pedro Ramirez",
                point: 1.5,
                price: -140,
                link: "https://sportsbook.draftkings.com/event/1?outcome=under",
                sid: "dk-under-1",
              },
            ],
          },
        ],
      },
      {
        key: "novig",
        markets: [
          {
            key: "batter_hits",
            outcomes: [
              { name: "Over", description: "Pedro Ramirez", point: 1.5, price: 135 },
              { name: "Under", description: "Pedro Ramirez", point: 1.5, price: -150 },
            ],
          },
        ],
      },
      {
        key: "prizepicks",
        markets: [
          {
            key: "batter_hits",
            outcomes: [
              {
                name: "Over",
                description: "Pedro Ramirez",
                point: 1.5,
                price: null,
                multiplier: 3,
                link: "https://app.prizepicks.com/board?p=1",
              },
              {
                name: "Under",
                description: "Pedro Ramirez",
                point: 1.5,
                price: null,
                multiplier: 1.4,
              },
            ],
          },
        ],
      },
    ],
  };
}

test("a row carries the venue behind its price, with an honest link", () => {
  const odds = parseEventOdds(payload());
  const rows = attachLines(markets, "Pedro Ramirez", odds, projection, false);
  const row = rows.find((r) => r.market === "batter_hits" && !r.alt);

  assert.equal(row.line, 1.5);
  assert.equal(row.venue.key, "draftkings");
  assert.equal(row.venue.label, "DraftKings");
  assert.equal(row.venue.kind, "book");
  assert.equal(row.venue.granularity, "outcome");
  assert.equal(row.venue.exact, true);
  // The link is the side the row is calling, not whichever side parsed first.
  assert.equal(
    row.venue.link,
    row.edge.side === "under"
      ? "https://sportsbook.draftkings.com/event/1?outcome=under"
      : "https://sportsbook.draftkings.com/event/1?outcome=over",
  );
});

test("a DFS venue reaches the row with a multiplier and no two-sided price", () => {
  const odds = parseEventOdds(payload());
  const rows = attachLines(markets, "Pedro Ramirez", odds, projection, false);
  const row = rows.find((r) => r.market === "batter_hits" && !r.alt);

  const dfs = row.venues.find((v) => v.key === "prizepicks");
  assert.ok(dfs, "the DFS venue must be listed on the row");
  assert.equal(dfs.kind, "dfs");
  assert.equal(dfs.line, 1.5);
  // A payout multiplier is not a price and is never dressed up as one.
  assert.equal(dfs.over, null);
  assert.equal(dfs.under, null);
  assert.equal(dfs.multiplier, row.edge.side === "under" ? 1.4 : 3);
  assert.equal(dfs.consensus, false);

  // It also never voted: the consensus is the one core book.
  assert.equal(row.nBooks, 1);
  assert.deepEqual(row.venues.filter((v) => v.consensus).map((v) => v.key), [
    "draftkings",
  ]);
});

test("a non-linkable venue is listed with its price but no destination", () => {
  const odds = parseEventOdds(payload());
  const rows = attachLines(markets, "Pedro Ramirez", odds, projection, false);
  const row = rows.find((r) => r.market === "batter_hits" && !r.alt);

  const nv = row.venues.find((v) => v.key === "novig");
  assert.ok(nv, "novig's price is real even though its link is not");
  assert.equal(nv.kind, "exchange");
  assert.equal(nv.over, 135);
  assert.equal(nv.under, -150);
  assert.equal(nv.link, null);
  assert.equal(nv.exact, false);
  // And it did not drag the consensus line or the book count with it.
  assert.equal(nv.consensus, false);
  assert.equal(row.book, "DK");
});

test("a non-consensus venue cannot win a vote read straight off the index", () => {
  // The NRFI total calls `bestQuote` on the index directly, with no
  // `attachLines` filtering in front of it, so the guard has to live there too.
  const quotes = [
    { book: "DK", bookKey: "draftkings", point: 0.5, over: -110, under: -110, consensus: true },
    { book: "NVG", bookKey: "novig", point: 1.5, over: 100, under: -120, consensus: false },
    { book: "KAL", bookKey: "kalshi", point: 1.5, over: 105, under: -125, consensus: false },
  ];
  const best = bestQuote(quotes);
  // Two exchange quotes agree at 1.5 and would outvote the single book at 0.5
  // if they were allowed to vote at all.
  assert.equal(best.point, 0.5);
  assert.equal(best.nBooks, 1);
  assert.deepEqual(best.books, ["DK"]);
});

test("no venue on a row that has no price", () => {
  const rows = attachLines(markets, "Nobody At All", parseEventOdds(null), projection, false);
  const row = rows[0];
  assert.equal(row.line, null);
  assert.equal(row.venue, null);
  assert.deepEqual(row.venues, []);
});
