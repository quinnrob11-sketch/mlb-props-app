/**
 * Maker mode: the resting-order arithmetic and the mode's persistence.
 *
 * The load-bearing property is the refusal: with no Kalshi contract, or with a
 * one-sided quote, the plan must report that and produce NO numbers. A spread
 * invented from a midpoint is the one failure mode this view could have.
 *
 * Run: npm test
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  PRICE_MODE_KEY,
  describeMaker,
  fmtCents,
  kalshiOffer,
  loadPriceMode,
  makerPlan,
  modelFairProb,
  normalizePriceMode,
  savePriceMode,
} from "../src/ui/makerMode.js";
import { marketQuote } from "../src/lib/kalshi.js";

/** A row calling `side` at 6.5, with (optionally) a Kalshi venue on the line. */
function row({ side = "over", usedOver = 0.56, kalshi = true } = {}) {
  return {
    key: "b:1:batter_total_bases",
    name: "Pedro Ramirez",
    market: "batter_total_bases",
    line: 1.5,
    venues: kalshi
      ? [
          {
            key: "kalshi",
            label: "Kalshi",
            short: "KAL",
            kind: "exchange",
            link: "https://kalshi.com/markets/kxmlbtb/-/kxmlbtb-26jul281945chcstl",
            exact: false,
            granularity: "event",
            line: 1.5,
            side,
            over: 120,
            under: -140,
            multiplier: null,
            consensus: false,
          },
        ]
      : [],
    edge: { side, usedOver, modelOver: 0.6, ev: 5, verdict: "SOLID" },
  };
}

/** A two-sided Kalshi book at 43/47 cents. */
const book = () =>
  marketQuote({
    ticker: "KXMLBTB-26JUL281945CHCSTL-STLPRAMIREZ-2",
    yes_bid: 43,
    yes_ask: 47,
    volume: 1200,
  });

// ── the plan ────────────────────────────────────────────────────────────────

test("an over rests inside the YES book, one cent better than the bid", () => {
  const plan = makerPlan({ row: row({ side: "over", usedOver: 0.56 }), quote: book() });

  assert.equal(plan.status, "ok");
  assert.equal(plan.contract, "YES");
  assert.equal(plan.threshold, 2); // over 1.5 is the "2+" contract
  assert.equal(plan.bidCents, 43);
  assert.equal(plan.askCents, 47);
  assert.equal(plan.spreadCents, 4);
  assert.equal(plan.fairCents, 56);
  // Fair is through the ask, so it is not inside the spread.
  assert.equal(plan.fairInside, false);
  assert.equal(plan.restCents, 44);
  assert.equal(plan.restImproves, true);
  assert.equal(plan.restEdgeCents, 12);
  assert.equal(plan.takerCents, 47);
  assert.equal(plan.takerEdgeCents, 9);
  assert.equal(plan.depth.volume, 1200);
});

test("an under is the NO contract, so the book flips and swaps", () => {
  const plan = makerPlan({ row: row({ side: "under", usedOver: 0.56 }), quote: book() });

  assert.equal(plan.contract, "NO");
  // A resting NO bid at p is a YES offer at 100 − p: NO bid = 100 − 47 = 53.
  assert.equal(plan.bidCents, 53);
  assert.equal(plan.askCents, 57);
  assert.equal(plan.spreadCents, 4);
  // Model fair for the under is 1 − usedOver.
  assert.equal(plan.fairCents, 44);
  assert.equal(plan.fairInside, false);
  // Fair is below the whole book, so there is no cent at the front of the
  // queue with edge — the plan drops back to the best cent under fair.
  assert.equal(plan.restCents, 43);
  assert.equal(plan.restImproves, false);
  assert.equal(plan.restEdgeCents, 1);
  assert.equal(plan.takerEdgeCents, -13);
});

test("fair inside the spread is reported as inside, and positioned within it", () => {
  const plan = makerPlan({ row: row({ side: "over", usedOver: 0.45 }), quote: book() });

  assert.equal(plan.fairCents, 45);
  assert.equal(plan.fairInside, true);
  assert.equal(plan.fairPosition, 0.5);
  assert.equal(plan.restCents, 44);
  assert.equal(plan.restEdgeCents, 1);
  assert.match(describeMaker(plan), /inside the spread/);
  assert.match(describeMaker(plan), /best in the book/);
});

test("a resting order never crosses the ask", () => {
  // Fair miles above the ask: the plan still rests, it does not take.
  const plan = makerPlan({ row: row({ side: "over", usedOver: 0.95 }), quote: book() });
  assert.ok(plan.restCents < plan.askCents, "resting price must stay under the ask");
  assert.equal(plan.restCents, 44);
});

// ── the refusals ────────────────────────────────────────────────────────────

test("no Kalshi venue on the row: says so, produces no numbers", () => {
  const plan = makerPlan({ row: row({ kalshi: false }), quote: book() });

  assert.equal(plan.status, "no-venue");
  assert.match(plan.reason, /Kalshi does not list this prop/);
  assert.equal(plan.bidCents, null);
  assert.equal(plan.askCents, null);
  assert.equal(plan.spreadCents, null);
  assert.equal(plan.restCents, null);
});

test("no order book: no spread is invented", () => {
  const plan = makerPlan({ row: row(), quote: null });
  assert.equal(plan.status, "no-book");
  assert.equal(plan.spreadCents, null);
  assert.equal(plan.fairCents, null);
});

test("a one-sided quote is not half a spread — and a midpoint is never used", () => {
  const oneSided = marketQuote({ ticker: "T", yes_bid: 43, last_price: 45 });
  assert.equal(oneSided.yesAsk.cents, null);
  assert.equal(oneSided.mid, null);

  const plan = makerPlan({ row: row(), quote: oneSided });
  assert.equal(plan.status, "no-book");
  assert.match(plan.reason, /one side only/);
  assert.equal(plan.bidCents, null);
  assert.equal(plan.restCents, null);
});

test("no model probability: the book is shown, the plan is not", () => {
  const r = row();
  r.edge = { side: "over", usedOver: null, modelOver: null };
  const plan = makerPlan({ row: r, quote: book() });

  assert.equal(plan.status, "no-fair");
  assert.equal(plan.bidCents, 43);
  assert.equal(plan.askCents, 47);
  assert.equal(plan.restCents, null);
});

test("no room below fair is reported rather than rounded away", () => {
  const cheap = marketQuote({ ticker: "T", yes_bid: 0, yes_ask: 3 });
  const plan = makerPlan({ row: row({ side: "over", usedOver: 0.004 }), quote: cheap });
  assert.equal(plan.status, "no-room");
  assert.equal(plan.restCents, null);
  assert.match(plan.reason, /no whole cent below it/);
});

// ── reads and persistence ───────────────────────────────────────────────────

test("the row's Kalshi offer and the called-side fair probability", () => {
  assert.equal(kalshiOffer(row()).key, "kalshi");
  assert.equal(kalshiOffer(row({ kalshi: false })), null);
  assert.equal(modelFairProb(row({ side: "over", usedOver: 0.56 })), 0.56);
  assert.equal(
    Math.round(modelFairProb(row({ side: "under", usedOver: 0.56 })) * 100),
    44,
  );
});

test("taker is the default and the only non-maker value", () => {
  assert.equal(normalizePriceMode("maker"), "maker");
  assert.equal(normalizePriceMode("taker"), "taker");
  assert.equal(normalizePriceMode(null), "taker");
  assert.equal(normalizePriceMode("MAKER"), "taker");
});

test("the mode round-trips through localStorage under its own key", () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  try {
    assert.equal(loadPriceMode(), "taker");
    assert.equal(savePriceMode("maker"), "maker");
    assert.equal(store.get(PRICE_MODE_KEY), "maker");
    assert.equal(loadPriceMode(), "maker");
    savePriceMode("nonsense");
    assert.equal(loadPriceMode(), "taker");
  } finally {
    delete globalThis.localStorage;
  }
});

test("cent formatting keeps a decimal only when there is one", () => {
  assert.equal(fmtCents(43), "43¢");
  assert.equal(fmtCents(47.5), "47.5¢");
  assert.equal(fmtCents(null), "—");
});
