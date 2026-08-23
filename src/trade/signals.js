/**
 * Model projection + live Kalshi order book -> a tradeable signal.
 *
 * This is the analytical core of the automation. It answers one question per
 * market: given what the model believes and what the book is actually showing
 * right now, is there a trade, on which side, at what price, and worth how much
 * AFTER fees?
 *
 * WHAT MAKES THIS DIFFERENT FROM THE BOARD
 *
 * The BEST BETS board prices against a de-vigged sportsbook consensus. An
 * exchange is not that. Three things change:
 *
 *   1. There is no vig to remove — the book is real two-sided liquidity, so the
 *      ask IS the price you pay. What replaces vig is the FEE, which the board
 *      never had to model. See fees.js: at 50c it eats 1.75 points of edge.
 *   2. You can be a MAKER. Resting inside the spread earns the spread instead
 *      of paying it, at the cost of an uncertain fill. Both are priced here and
 *      compared honestly, rather than assuming you always cross.
 *   3. Depth is finite. A 40-point edge on a market with 3 contracts resting is
 *      not a 40-point edge, it is a 3-contract trade. Size is capped by what is
 *      actually there.
 *
 * SHRINKAGE, AND WHY IT IS NOT OPTIONAL HERE
 *
 * `evaluateEdge` on the board shrinks the model toward the market before
 * computing EV, because a large disagreement is more often the model being
 * wrong than the market being wrong. That reasoning applies at least as hard on
 * an exchange, where the counterparty is another trader who may know something
 * about a scratch or a weather delay that the model does not. The same
 * `weight` and clamp are applied here, so an automated system cannot act on a
 * belief the board itself would have refused to act on.
 */

import { centsToProbability, probabilityToCents } from '../lib/kalshi.js';
import { feePerContractCents, breakEvenEdge } from './fees.js';

/**
 * Fraction of the model's disagreement with the exchange that is actually
 * traded on. Mirrors the board's per-market weighting: the model is treated as
 * one opinion among several, not as truth.
 */
export const DEFAULT_MODEL_WEIGHT = 0.45;

/**
 * Hard cap on the pre-weight disagreement, in probability points. Past this the
 * model and the exchange disagree so much that the likeliest explanation is
 * stale or wrong model input — a scratched starter, a rain delay, a lineup
 * change the model has not seen.
 */
export const MAX_DISAGREEMENT = 0.15;

/**
 * Hard cap on the disagreement expressed as a RATIO, in both directions.
 *
 * The absolute clamp above is blind at the edges of the price range, and that is
 * where this model is least trustworthy. A live run made this concrete: it
 * wanted to buy four home-run contracts at 2-4c, on 3-5 point edges. Sounds
 * modest. At a 2c price it means the model believes 6.3% where the exchange
 * believes 2% — it is claiming the market is THREE TIMES wrong, and a 4-point
 * gap sails through a 15-point clamp without touching it.
 *
 * Three things line up badly at those prices and none of them were guarded:
 *
 *   - The absolute clamp cannot bind, because the whole probability range in
 *     play is smaller than the clamp.
 *   - The fee hurdle nearly vanishes — 0.14c at 2c against 1.75c at 50c — so
 *     the one remaining brake is weakest exactly where it is needed most.
 *   - `batter_home_runs@0.5` measured clean in the backtest, but that is the
 *     AVERAGE over all hitters. It says nothing about accuracy conditional on
 *     the 2% tail, where a small absolute error is a huge relative one.
 *
 * 2.0 means: the model may not act on a belief that the market is more than
 * twice wrong in either direction. It binds only at the extremes — at a 44c
 * price it permits 22c-72c, far wider than the absolute clamp, so ordinary
 * markets are untouched and this costs nothing where the model is reliable.
 */
export const MAX_RELATIVE_DISAGREEMENT = 2.0;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Blend the model's probability toward the exchange's implied probability.
 *
 * @param {number} modelProb  0..1, the model's own belief
 * @param {number} marketProb 0..1, implied by the book's mid
 * @param {number} weight     how much of the disagreement to keep
 * @returns {number} the probability actually traded on
 */
export function blendedProbability(modelProb, marketProb, weight = DEFAULT_MODEL_WEIGHT) {
  if (marketProb == null || isNaN(marketProb)) return modelProb;

  // Relative clamp FIRST, because it is the one that binds at the extremes.
  // Applied to both the probability and its complement, so it is symmetric: a
  // 2% market may not be argued down to 0.5%, and a 98% market may not be
  // argued up to 99.5% either.
  const R = MAX_RELATIVE_DISAGREEMENT;
  const hi = Math.min(marketProb * R, 1 - (1 - marketProb) / R);
  const lo = Math.max(marketProb / R, 1 - (1 - marketProb) * R);
  const bounded = clamp(modelProb, Math.min(lo, hi), Math.max(lo, hi));

  const disagreement = clamp(bounded - marketProb, -MAX_DISAGREEMENT, MAX_DISAGREEMENT);
  return clamp(marketProb + weight * disagreement, 0.001, 0.999);
}

/**
 * Expected value per contract, in cents, of buying at `priceCents`.
 *
 * A contract settles at 100c if the event happens and 0c if it does not, so
 * gross EV is `100·p − price`. Fees are charged on entry either way.
 *
 * @param {number} p          0..1, probability the contract settles YES
 * @param {number} priceCents what you pay
 * @returns {number} cents per contract, net of fees
 */
export function expectedValueCents(p, priceCents) {
  if (p == null || priceCents == null) return null;
  return 100 * p - priceCents - feePerContractCents(priceCents);
}

/**
 * Build a signal for one market.
 *
 * Both directions are considered. Buying NO at `noAsk` is the same trade as
 * selling YES, and on a thin book it is frequently the only side with any depth,
 * so a system that only ever buys YES leaves half the opportunities behind.
 *
 * @param {object} input
 * @param {number} input.modelProb    0..1 — model P(outcome resolves YES)
 * @param {object} input.book         from `normalizeOrderbook`
 * @param {string} input.ticker
 * @param {number} [input.weight]     model weight; defaults to DEFAULT_MODEL_WEIGHT
 * @param {number} [input.minEdge]    extra edge required ON TOP of break-even,
 *                                    in probability points. Default 0.02.
 * @returns {object|null} signal, or null when there is nothing tradeable
 */
export function buildSignal({
  modelProb,
  book,
  ticker,
  weight = DEFAULT_MODEL_WEIGHT,
  minEdge = 0.02,
}) {
  if (modelProb == null || isNaN(modelProb) || !book) return null;

  const { bestYesBid, bestYesAsk } = book;
  if (bestYesBid == null || bestYesAsk == null) {
    return { ticker, tradeable: false, reason: 'no two-sided book' };
  }

  // The exchange's own view. Mid rather than last trade: last is stale the
  // moment it prints, mid is where the book actually is.
  const marketProb = centsToProbability((bestYesBid + bestYesAsk) / 2);
  const p = blendedProbability(modelProb, marketProb, weight);

  // Buying YES costs the ask. Buying NO costs (100 - yesBid), because the NO
  // ask is the complement of the YES bid.
  const yesPrice = bestYesAsk;
  const noPrice = 100 - bestYesBid;

  const yesEv = expectedValueCents(p, yesPrice);
  const noEv = expectedValueCents(1 - p, noPrice);

  const takeYes = yesEv >= noEv;
  const side = takeYes ? 'yes' : 'no';
  const priceCents = takeYes ? yesPrice : noPrice;
  const evCents = takeYes ? yesEv : noEv;
  const sideProb = takeYes ? p : 1 - p;

  // Depth available at the price we would actually pay. Buying YES consumes NO
  // resting orders and vice versa — the book side you EAT is the opposite of
  // the one you join.
  const restingLevels = takeYes ? book.no : book.yes;
  const availableContracts = (restingLevels || [])
    .filter((level) => {
      // A resting NO at c cents makes YES available at (100 - c).
      const impliedYesCost = takeYes ? 100 - level.cents : level.cents;
      return impliedYesCost <= priceCents;
    })
    .reduce((sum, level) => sum + level.contracts, 0);

  const edge = sideProb - priceCents / 100;
  const required = breakEvenEdge(priceCents) + minEdge;
  const tradeable = edge >= required && availableContracts > 0;

  return {
    ticker,
    tradeable,
    side,
    priceCents,
    // Probabilities, all on the chosen side.
    modelProb: takeYes ? modelProb : 1 - modelProb,
    marketProb: takeYes ? marketProb : 1 - marketProb,
    blendedProb: sideProb,
    // Edge and its hurdle, so a rejected signal can say how far short it fell.
    edge,
    requiredEdge: required,
    evCents,
    evPerDollar: priceCents > 0 ? evCents / priceCents : null,
    availableContracts,
    spreadCents: book.spreadCents,
    reason: tradeable
      ? null
      : availableContracts <= 0
        ? 'no depth at the price'
        : `edge ${(100 * edge).toFixed(1)}pts < required ${(100 * required).toFixed(1)}pts`,
  };
}

/**
 * Where a resting (maker) order would sit, and what it would be worth.
 *
 * Making is not strictly better than taking. You save the spread but accept
 * that you only get filled when someone crosses to you — which, on an exchange,
 * is disproportionately when they know something you do not. This returns the
 * arithmetic and lets the caller decide; it does not assume making wins.
 *
 * @param {object} signal from `buildSignal`
 * @param {object} book   from `normalizeOrderbook`
 * @returns {object|null}
 */
export function makerAlternative(signal, book) {
  if (!signal || !signal.side || !book) return null;
  const { bestYesBid, bestYesAsk } = book;
  if (bestYesBid == null || bestYesAsk == null) return null;
  // No room to improve on a one-tick market.
  if (bestYesAsk - bestYesBid <= 1) return null;

  // Join the near side one tick better than the current best, staying inside
  // the spread so the order is genuinely passive.
  const restPrice =
    signal.side === 'yes' ? bestYesBid + 1 : 100 - (bestYesAsk - 1);

  const ev = expectedValueCents(signal.blendedProb, restPrice);
  return {
    priceCents: restPrice,
    evCents: ev,
    improvementCents: ev - signal.evCents,
    // Honest caveat carried on the object so a caller cannot forget it.
    note: 'fill is not guaranteed; passive fills are adversely selected',
  };
}

/**
 * Convert a probability to the nearest tradeable cent price.
 * Thin wrapper so callers do not reach into the kalshi lib for one helper.
 */
export function probabilityToPrice(p) {
  return probabilityToCents(p);
}
