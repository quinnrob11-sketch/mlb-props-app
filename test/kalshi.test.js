/**
 * Kalshi side-car client.
 *
 * Everything here is offline: the transport is injected, so no test opens a
 * socket. What is actually being pinned is the discipline - cent prices convert
 * losslessly, bid and ask stay apart, and an ambiguous name is refused rather
 * than resolved.
 *
 * Run: npm test
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  KALSHI_API_BASE,
  KALSHI_PROXY_PATH,
  americanToCents,
  centsToAmerican,
  centsToProbability,
  eventTickerOf,
  fetchKalshiMarkets,
  fetchOrderbook,
  kalshiUrl,
  marketQuote,
  matchKalshiMarket,
  normalizeMarket,
  normalizeOrderbook,
  playerNameOf,
  probabilityToCents,
  seriesForMarket,
  seriesTickerOf,
  thresholdForLine,
} from "../src/lib/kalshi.js";
import { kalshiEventUrl } from "../src/lib/venues.js";
import { probToAmerican } from "../src/lib/odds.js";

// ── fixtures ────────────────────────────────────────────────────────────────

const EVENT = "KXMLBHRR-26JUL281945CHCSTL";

/** One raw Kalshi market, in the shape `/markets` returns. */
const raw = (over, title, extra = {}) => ({
  ticker: `${EVENT}-${over}`,
  event_ticker: EVENT,
  series_ticker: "KXMLBHRR",
  title,
  status: "open",
  yes_bid: 41,
  yes_ask: 46,
  no_bid: 54,
  no_ask: 59,
  last_price: 44,
  volume: 1200,
  open_interest: 800,
  liquidity: 5000,
  ...extra,
});

const RAMIREZ_2 = raw("CHCPRAMIREZ75-2", "Pedro Ramirez: 2+ hits+runs+RBIs", {
  floor_strike: 2,
});
const RAMIREZ_3 = raw("CHCPRAMIREZ75-3", "Pedro Ramirez: 3+ hits+runs+RBIs", {
  floor_strike: 3,
});

/** A stub `fetch` that serves a canned body and records the URLs it saw. */
function stubFetch(routes) {
  const seen = [];
  const impl = async (url) => {
    seen.push(url);
    const entry = Object.entries(routes).find(([fragment]) => url.includes(fragment));
    if (!entry) return { ok: false, status: 404, json: async () => ({}) };
    const [, body] = entry;
    if (body instanceof Error) throw body;
    return { ok: true, status: 200, json: async () => body };
  };
  impl.seen = seen;
  return impl;
}

// ── 1. price conversion ─────────────────────────────────────────────────────

test("cents and probability round-trip losslessly across the whole book", () => {
  for (let cents = 0; cents <= 100; cents++) {
    const probability = centsToProbability(cents);
    assert.equal(probabilityToCents(probability), cents, `broke at ${cents}c`);
  }
  assert.equal(centsToProbability(75), 0.75);
  assert.equal(probabilityToCents(0.75), 75);

  // Anything outside the 0-100c book is not a Kalshi price.
  for (const bad of [null, undefined, "", -1, 101, NaN, "abc"]) {
    assert.equal(centsToProbability(bad), null, `accepted ${bad}`);
  }
  assert.equal(probabilityToCents(1.4), null);
  assert.equal(probabilityToCents(-0.1), null);
});

test("cent prices convert to American odds through the app's own helper", () => {
  // Not hand-rolled here: the expectation IS lib/odds.js.
  assert.equal(centsToAmerican(75), probToAmerican(0.75));
  assert.equal(centsToAmerican(75), -300);
  assert.equal(centsToAmerican(40), probToAmerican(0.4));
  assert.equal(centsToAmerican(40), 150);
  // 0c and 100c are not finite prices.
  assert.equal(centsToAmerican(0), null);
  assert.equal(centsToAmerican(100), null);

  // ...and back, via impliedProb.
  assert.equal(americanToCents(-300), 75);
  assert.equal(americanToCents(150), 40);
  assert.equal(americanToCents(null), null);
});

// ── 2. tickers ──────────────────────────────────────────────────────────────

test("tickers decompose into series and event", () => {
  const market = `${EVENT}-CHCPRAMIREZ75-2`;
  assert.equal(seriesTickerOf(market), "KXMLBHRR");
  assert.equal(eventTickerOf(market), EVENT);
  assert.equal(eventTickerOf(EVENT), EVENT);
  assert.equal(eventTickerOf("KXMLBGAME-26JUL281840AZPIT-AZ"), "KXMLBGAME-26JUL281840AZPIT");
  assert.equal(eventTickerOf(""), null);

  // and the event ticker is exactly what the deep link needs
  assert.equal(
    kalshiEventUrl(seriesTickerOf(market), eventTickerOf(market)),
    "https://kalshi.com/markets/kxmlbhrr/-/kxmlbhrr-26jul281945chcstl",
  );
});

test("only a half-point line maps onto an N+ contract", () => {
  assert.equal(thresholdForLine(1.5), 2);
  assert.equal(thresholdForLine(0.5), 1);
  assert.equal(thresholdForLine(2.5), 3);
  // "over 2.0" pushes on 2, "2+" wins on it: different bets, so refuse.
  assert.equal(thresholdForLine(2), null);
  assert.equal(thresholdForLine(0), null);
  assert.equal(thresholdForLine(null), null);
  assert.equal(thresholdForLine("abc"), null);
});

test("a market normalises into player, threshold and a bid/ask pair", () => {
  const m = normalizeMarket(RAMIREZ_2);
  assert.equal(m.ticker, `${EVENT}-CHCPRAMIREZ75-2`);
  assert.equal(m.eventTicker, EVENT);
  assert.equal(m.series, "KXMLBHRR");
  assert.equal(m.player, "Pedro Ramirez");
  assert.equal(m.playerKey, "pedro ramirez");
  assert.equal(m.threshold, 2);
  assert.equal(m.yesBid, 41);
  assert.equal(m.yesAsk, 46);

  // The threshold falls back to the ticker only when no strike is published.
  const noStrike = normalizeMarket({ ...RAMIREZ_2, floor_strike: undefined });
  assert.equal(noStrike.threshold, 2);

  assert.equal(normalizeMarket(null), null);
  assert.equal(normalizeMarket({ title: "no ticker" }), null);
});

test("the player name comes from a field or a title, never from the ticker blob", () => {
  assert.equal(playerNameOf(RAMIREZ_2), "Pedro Ramirez");
  assert.equal(playerNameOf({ yes_sub_title: "Nico Hoerner" }), "Nico Hoerner");
  // "CHCPRAMIREZ75" is not reversible into a name, so an untitled market has none.
  assert.equal(playerNameOf({ ticker: `${EVENT}-CHCPRAMIREZ75-2` }), null);
});

// ── 3. bid/ask is not a midpoint ────────────────────────────────────────────

test("a quote keeps bid, ask and spread apart", () => {
  const q = marketQuote(RAMIREZ_2);
  assert.equal(q.yesBid.cents, 41);
  assert.equal(q.yesAsk.cents, 46);
  assert.equal(q.spreadCents, 5);

  // each side carries its own probability and American price
  assert.equal(q.yesBid.probability, 0.41);
  assert.equal(q.yesAsk.probability, 0.46);
  assert.equal(q.yesAsk.american, probToAmerican(0.46));
  assert.notEqual(q.yesBid.american, q.yesAsk.american);

  // the midpoint exists but is explicitly derived, and is nobody's fill
  assert.equal(q.mid.cents, 43.5);
  assert.ok(q.mid.cents > q.yesBid.cents && q.mid.cents < q.yesAsk.cents);

  // depth is reported, not folded into the price
  assert.deepEqual(q.depth, { volume: 1200, openInterest: 800, liquidity: 5000 });

  // a one-sided book has no spread to report
  const oneSided = marketQuote({ ...RAMIREZ_2, yes_ask: null });
  assert.equal(oneSided.spreadCents, null);
  assert.equal(oneSided.mid, null);
});

test("an order book yields top-of-book from its two half-books", () => {
  const book = normalizeOrderbook(`${EVENT}-CHCPRAMIREZ75-2`, {
    orderbook: {
      yes: [[40, 300], [41, 120], [38, 500]],
      no: [[54, 200], [52, 90]],
    },
  });
  assert.equal(book.bestYesBid, 41);
  // A resting NO bid at 54c is a YES offer at 46c — that is how the two halves
  // make one two-sided market.
  assert.equal(book.bestYesAsk, 46);
  assert.equal(book.spreadCents, 5);
  assert.equal(book.yesDepth, 920);
  assert.equal(book.noDepth, 290);

  const empty = normalizeOrderbook("X", { orderbook: { yes: [], no: [] } });
  assert.equal(empty.bestYesBid, null);
  assert.equal(empty.bestYesAsk, null);
  assert.equal(empty.spreadCents, null);
});

// ── 4. matching refuses rather than guesses ─────────────────────────────────

const match = (over) =>
  matchKalshiMarket({
    market: "batter_hits_runs_rbis",
    line: 1.5,
    markets: [RAMIREZ_2, RAMIREZ_3],
    ...over,
  });

test("a clean name and a half-point line resolve to one ticker", () => {
  const hit = match({ player: "Pedro Ramirez" });
  assert.equal(hit.status, "matched");
  assert.equal(hit.ticker, `${EVENT}-CHCPRAMIREZ75-2`);
  assert.equal(hit.market.threshold, 2);

  // accents and Last, First spellings go through normalizeName, as everywhere else
  assert.equal(match({ player: "Ramirez, Pedro" }).status, "matched");
  assert.equal(match({ player: { name: "Pedro Ramírez" } }).status, "matched");

  // 2.5 picks the 3+ contract
  const higher = match({ player: "Pedro Ramirez", line: 2.5 });
  assert.equal(higher.status, "matched");
  assert.equal(higher.market.threshold, 3);
});

test("an ambiguous name is refused, not resolved", () => {
  const pablo = raw("STLPRAMIREZ12-2", "Pablo Ramirez: 2+ hits+runs+RBIs", {
    floor_strike: 2,
  });
  const out = matchKalshiMarket({
    // The odds feed spelled him "P. Ramirez"; Kalshi lists two Ramirezes.
    player: "P. Ramirez",
    market: "batter_hits_runs_rbis",
    line: 1.5,
    markets: [RAMIREZ_2, pablo],
  });
  // Both candidates tie on the initial+last tier. `matchName` reports the tie
  // and nothing here breaks it — a 50/50 guess would price the wrong contract.
  assert.equal(out.status, "ambiguous");
  assert.equal(out.ticker, null);
  assert.equal(out.market, null);
  assert.equal(out.candidates.length, 2);
  assert.equal(out.tier, "initialLast");
  assert.match(out.reason, /more than one/i);

  // A stronger tier still decides: the full name is not made ambiguous by the
  // existence of a namesake it does not actually collide with.
  const exact = matchKalshiMarket({
    player: "Pedro Ramirez",
    market: "batter_hits_runs_rbis",
    line: 1.5,
    markets: [RAMIREZ_2, pablo],
  });
  assert.equal(exact.status, "matched");
  assert.equal(exact.ticker, `${EVENT}-CHCPRAMIREZ75-2`);
});

test("two contracts at the same threshold for one player are also ambiguous", () => {
  const duplicate = { ...RAMIREZ_2, ticker: `${EVENT}-CHCPRAMIREZ75-2B` };
  const out = matchKalshiMarket({
    player: "Pedro Ramirez",
    market: "batter_hits_runs_rbis",
    line: 1.5,
    markets: [RAMIREZ_2, duplicate],
  });
  assert.equal(out.status, "ambiguous");
  assert.equal(out.market, null);
  assert.match(out.reason, /2 Kalshi contracts/);
});

test("every unmatchable input is a documented refusal, never a guess", () => {
  assert.equal(match({ player: null }).status, "missing");
  assert.equal(match({ player: "Nobody Here" }).status, "missing");
  // no contract at that threshold
  assert.match(match({ player: "Pedro Ramirez", line: 9.5 }).reason, /9\+|10\+/);
  // a whole-number line is not a Kalshi bet
  assert.match(match({ player: "Pedro Ramirez", line: 2 }).reason, /whole number/);
  // a market we have no verified series for
  assert.equal(seriesForMarket("batter_stolen_bases"), null);
  assert.match(
    match({ player: "Pedro Ramirez", market: "batter_stolen_bases" }).reason,
    /no verified Kalshi series/,
  );
  // an empty pool
  assert.match(match({ player: "Pedro Ramirez", markets: [] }).reason, /no open Kalshi markets/);
  // and a market from a different series never leaks in
  const wrongSeries = { ...RAMIREZ_2, series_ticker: "KXMLBTB" };
  assert.equal(
    matchKalshiMarket({
      player: "Pedro Ramirez",
      market: "batter_hits_runs_rbis",
      line: 1.5,
      markets: [wrongSeries],
    }).status,
    "missing",
  );
});

// ── 5. transport ────────────────────────────────────────────────────────────

test("calls go through the same-origin proxy by default", () => {
  assert.equal(
    kalshiUrl("/markets?series_ticker=KXMLBHRR&status=open"),
    `${KALSHI_PROXY_PATH}?path=%2Fmarkets%3Fseries_ticker%3DKXMLBHRR%26status%3Dopen`,
  );
  // ...and can be pointed straight at Kalshi from a server-side caller.
  assert.equal(
    kalshiUrl("/markets?status=open", KALSHI_API_BASE),
    `${KALSHI_API_BASE}/markets?status=open`,
  );
});

test("markets are fetched per series, and one failure does not sink the rest", async () => {
  const fetchImpl = stubFetch({
    "KXMLBHRR": { markets: [RAMIREZ_2, RAMIREZ_3] },
    "KXMLBTB": new Error("upstream exploded"),
  });

  const out = await fetchKalshiMarkets({
    seriesTickers: ["KXMLBHRR", "KXMLBTB", "KXMLBHRR"],
    fetchImpl,
  });

  assert.equal(out.markets.length, 2);
  assert.equal(out.markets[0].playerKey, "pedro ramirez");
  assert.equal(out.bySeries.get("KXMLBHRR").length, 2);
  assert.deepEqual(out.bySeries.get("KXMLBTB"), []);
  assert.equal(out.errors.length, 1);
  assert.equal(out.errors[0].series, "KXMLBTB");

  // duplicated series are requested once, and always through the proxy
  assert.equal(fetchImpl.seen.length, 2);
  for (const url of fetchImpl.seen) {
    assert.ok(url.startsWith(`${KALSHI_PROXY_PATH}?path=`), url);
  }
});

test("an order book is fetched by ticker and normalised", async () => {
  const fetchImpl = stubFetch({
    orderbook: { orderbook: { yes: [[41, 10]], no: [[54, 20]] } },
  });
  const book = await fetchOrderbook(`${EVENT}-CHCPRAMIREZ75-2`, { fetchImpl });
  assert.equal(book.bestYesBid, 41);
  assert.equal(book.bestYesAsk, 46);
  assert.ok(fetchImpl.seen[0].includes("orderbook"));

  assert.equal(await fetchOrderbook(null, { fetchImpl }), null);
});

test("an upstream error is surfaced with its status, not swallowed", async () => {
  const fetchImpl = async () => ({ ok: false, status: 502, json: async () => ({}) });
  await assert.rejects(
    () => fetchOrderbook("KXMLBHRR-X-1", { fetchImpl }),
    (e) => e.status === 502 && /Kalshi API 502/.test(e.message),
  );
});
