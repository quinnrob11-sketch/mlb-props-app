/**
 * Maker / taker mode — pure logic and persistence.
 *
 * TAKER (default) is what the rest of the app already does: the edge engine
 * picks the best price available right now, and a click hits it. Nothing here
 * changes that.
 *
 * MAKER only means something where there is a visible order book to rest inside
 * of, and Kalshi is the one venue in this app that exposes one
 * (`lib/kalshi.js` -> `marketQuote`). For a Kalshi row it answers three
 * questions and nothing else:
 *
 *   - what is the book right now (bid / ask / spread)?
 *   - where does the model's fair value sit inside that spread?
 *   - therefore, what is the highest price a resting order could sit at and
 *     still be buying below fair?
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO REFUSALS
 *
 * 1. NO FABRICATED SPREAD. If a row has no Kalshi contract, or the contract is
 *    quoted on one side only, this module returns a status saying so. It never
 *    derives a bid and an ask from a midpoint, a last trade or a book price —
 *    a spread that does not exist cannot be rested inside of.
 *
 * 2. NO ORDER. Everything here is arithmetic for display. No function in this
 *    module (or in the components that render it) places, prepares, stages or
 *    preauthorises anything; `restCents` is a number on a screen.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { thresholdForLine } from "../lib/kalshi.js";

/** The two modes. `taker` is the default everywhere. */
export const PRICE_MODES = ["taker", "maker"];

/** Persisted alongside `criteriaV1` / `bankroll` / `sharpMode`. */
export const PRICE_MODE_KEY = "priceModeV1";

/** Anything that is not the literal "maker" is taker. */
export function normalizePriceMode(value) {
  return value === "maker" ? "maker" : "taker";
}

function storage() {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Restore the mode; a missing or unreadable value reads as taker. */
export function loadPriceMode() {
  const ls = storage();
  if (!ls) return "taker";
  try {
    return normalizePriceMode(ls.getItem(PRICE_MODE_KEY));
  } catch {
    return "taker";
  }
}

/** Persist the mode. Returns the normalised value actually stored. */
export function savePriceMode(mode) {
  const next = normalizePriceMode(mode);
  const ls = storage();
  if (ls) {
    try {
      ls.setItem(PRICE_MODE_KEY, next);
    } catch {}
  }
  return next;
}

// ── row reads ───────────────────────────────────────────────────────────────

/** The row's Kalshi offer, or null when Kalshi does not quote this line. */
export function kalshiOffer(row) {
  return (row?.venues || []).find((v) => v && v.key === "kalshi") || null;
}

/** The side the row is calling. */
function calledSide(row) {
  const side = row?.edge?.side;
  return side === "over" || side === "under" ? side : null;
}

/**
 * The model's fair probability for the side being called, 0..1.
 *
 * `usedOver` is preferred over `modelOver` because it is the number the edge
 * engine actually prices EV and Kelly from (the raw model shrunk toward the
 * market). Showing anything else would put a resting order at a price the rest
 * of the app does not believe in.
 */
export function modelFairProb(row) {
  const edge = row?.edge;
  const side = calledSide(row);
  if (!edge || !side) return null;
  const over = typeof edge.usedOver === "number" ? edge.usedOver : edge.modelOver;
  if (typeof over !== "number" || !Number.isFinite(over)) return null;
  return side === "over" ? over : 1 - over;
}

// ── the plan ────────────────────────────────────────────────────────────────

/**
 * @typedef {object} MakerPlan
 * @property {"ok"|"no-venue"|"no-book"|"no-fair"|"no-room"} status
 * @property {string|null} reason - Present on every non-"ok" status.
 * @property {"over"|"under"|null} side
 * @property {"YES"|"NO"|null} contract - Kalshi settles "N or more" as YES, so
 *   an over is a YES and an under is a NO.
 * @property {number|null} threshold - The "N+" the contract settles on.
 * @property {number|null} bidCents - Best bid FOR THE CONTRACT BEING BOUGHT.
 * @property {number|null} askCents - Best ask for it.
 * @property {number|null} spreadCents
 * @property {number|null} fairCents - Model fair value, same units.
 * @property {boolean} fairInside - Does fair sit strictly between bid and ask?
 * @property {number|null} fairPosition - 0 at the bid, 1 at the ask.
 * @property {number|null} restCents - Highest whole cent a resting bid could
 *   sit at and still be below fair (and still be a bid, not a cross).
 * @property {boolean} restImproves - Would that order be the new best bid?
 * @property {number|null} restEdgeCents - fair − rest.
 * @property {number|null} takerCents - What crossing costs right now.
 * @property {number|null} takerEdgeCents - fair − taker; negative means the
 *   ask is already through fair.
 * @property {{volume: number|null, openInterest: number|null,
 *   liquidity: number|null}|null} depth
 */

const fail = (status, reason) => ({
  status,
  reason,
  side: null,
  contract: null,
  threshold: null,
  bidCents: null,
  askCents: null,
  spreadCents: null,
  fairCents: null,
  fairInside: false,
  fairPosition: null,
  restCents: null,
  restImproves: false,
  restEdgeCents: null,
  takerCents: null,
  takerEdgeCents: null,
  depth: null,
});

/**
 * Where a resting order could sit on one row.
 *
 * @param {object} args
 * @param {object} args.row - A row from `flattenRows`.
 * @param {import("../lib/kalshi.js").KalshiQuote|null} [args.quote] - The
 *   contract's live book. Null/absent is an honest "no book", never a reason to
 *   invent one.
 * @returns {MakerPlan}
 */
export function makerPlan({ row, quote } = {}) {
  const side = calledSide(row);
  if (!side) return fail("no-venue", "Nothing called on this row.");
  if (!kalshiOffer(row))
    return fail(
      "no-venue",
      "Kalshi does not list this prop, so there is no order book to rest in.",
    );
  if (!quote)
    return fail(
      "no-book",
      "No Kalshi order book loaded for this contract — nothing to quote.",
    );

  const yesBid = quote.yesBid?.cents ?? null;
  const yesAsk = quote.yesAsk?.cents ?? null;
  if (yesBid == null || yesAsk == null)
    return fail(
      "no-book",
      "Kalshi is showing one side only — there is no two-sided book to rest inside.",
    );

  // Re-express the book in terms of the contract actually being bought. A
  // resting NO bid at p is the same order as a YES offer at 100 − p, which is
  // why the under side flips and swaps.
  const contract = side === "over" ? "YES" : "NO";
  const bidCents = side === "over" ? yesBid : 100 - yesAsk;
  const askCents = side === "over" ? yesAsk : 100 - yesBid;
  const spreadCents = askCents - bidCents;

  const prob = modelFairProb(row);
  if (prob == null)
    return {
      ...fail("no-fair", "No model probability on this row to price against."),
      side,
      contract,
      threshold: thresholdForLine(row?.line),
      bidCents,
      askCents,
      spreadCents,
      depth: quote.depth ?? null,
    };

  const fairCents = Math.round(prob * 1000) / 10;
  const fairInside = fairCents > bidCents && fairCents < askCents;
  const fairPosition =
    spreadCents > 0 ? (fairCents - bidCents) / spreadCents : null;

  // The best resting bid with edge: one cent better than the current best bid
  // (so it is at the front of the queue), but never at or above fair, and never
  // at or above the ask — that would cross and make you the taker.
  const belowFair = Math.ceil(fairCents) - 1;
  const restCents = Math.min(bidCents + 1, belowFair, askCents - 1);

  const base = {
    status: "ok",
    reason: null,
    side,
    contract,
    threshold: thresholdForLine(row?.line),
    bidCents,
    askCents,
    spreadCents,
    fairCents,
    fairInside,
    fairPosition,
    restCents,
    restImproves: restCents > bidCents,
    restEdgeCents: Math.round((fairCents - restCents) * 10) / 10,
    takerCents: askCents,
    takerEdgeCents: Math.round((fairCents - askCents) * 10) / 10,
    depth: quote.depth ?? null,
  };

  if (restCents < 1)
    return {
      ...base,
      status: "no-room",
      reason: `Fair is ${fmtCents(fairCents)}, so there is no whole cent below it to rest at.`,
      restCents: null,
      restImproves: false,
      restEdgeCents: null,
    };

  return base;
}

/** Cent formatting, one decimal at most: 43¢, 47.5¢. */
export function fmtCents(cents) {
  if (cents == null || !Number.isFinite(Number(cents))) return "—";
  const n = Math.round(Number(cents) * 10) / 10;
  return `${Number.isInteger(n) ? n : n.toFixed(1)}¢`;
}

/**
 * One sentence describing the plan, used as the panel's headline and as the
 * anchor title. Display only — it never reads as an instruction to an exchange.
 *
 * @param {MakerPlan} plan
 * @returns {string}
 */
export function describeMaker(plan) {
  if (!plan || plan.status !== "ok") return plan?.reason || "No order book.";
  const where = plan.fairInside
    ? "inside the spread"
    : plan.fairCents >= plan.askCents
      ? "at or above the ask"
      : "at or below the bid";
  const rest = plan.restImproves
    ? `A bid at ${fmtCents(plan.restCents)} would be the best in the book`
    : `A bid at ${fmtCents(plan.restCents)} would queue behind the current ${fmtCents(plan.bidCents)}`;
  return `${plan.contract} book ${fmtCents(plan.bidCents)} / ${fmtCents(plan.askCents)}, model fair ${fmtCents(
    plan.fairCents,
  )} — ${where}. ${rest} and still buy ${fmtCents(plan.restEdgeCents)} under fair.`;
}
