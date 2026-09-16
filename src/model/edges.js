/**
 * The verdict / EV / Kelly / side engine.
 *
 * Reconstructed from the minified bundle (`/tmp/work/app.js`, lines 74-90 and
 * 526-587). Minified origins: `Ci` = evaluateEdge, `Pi` = MARKET_WEIGHT.
 *
 * Every threshold below is load-bearing and is preserved bit-for-bit: the
 * +-0.15 shrink clamp, the 0.6 small-sample weight haircut, the
 * (EV, edge) verdict ladder 10/0.07 -> 5/0.05 -> 2.5/0.03, the 0.15
 * "model miles away from market" demotion, the nBooks < 2 demotion, the
 * +250 / +150 / -300 price cutoffs and the 0.25 Kelly multiplier.
 *
 * Nothing here is fixed. Suspicious behaviour is flagged with TODO(recon).
 */

import { clamp } from "../lib/probability.js";
import { blend, consensusFair, devig, kellyFraction } from "../lib/odds.js";
import { MARKET_WEIGHT } from "../lib/constants.js";

/**
 * Per-market confidence weight (minified `Pi`), re-exported here because it is
 * the `weight` option this module consumes.
 *
 * It is the fraction of the model's disagreement with the market that the
 * engine is willing to keep (see `evaluateEdge`'s `usedOver`). Lower = trust
 * the book more. Markets the model prices well (batter Ks at 0.55) get more
 * rope than noisy ones (stolen bases at 0.30).
 *
 * `nrfi` is not a prop market key; it is used by the NRFI/YRFI first-inning
 * total, which calls `evaluateEdge` directly rather than through `attachLines`.
 */
export { MARKET_WEIGHT };

/**
 * @typedef {object} EdgeResult
 * @property {number} modelOver   Raw model P(over) before any market blending.
 * @property {number} usedOver    Blended P(over) actually used for EV/Kelly.
 * @property {number|null} fairOver Vig-free market P(over), null if unpriced.
 * @property {number|null} vig    Market overround (decimal, e.g. 0.045), or null.
 * @property {boolean} twoSided   Whether a genuine two-way price was available.
 * @property {number} nBooks      Book/quote count backing `fairOver`.
 * @property {boolean} sharp      True when a weighted (Pinnacle) book contributed.
 * @property {number|null} edge   modelOver - fairOver, signed toward the over.
 * @property {"over"|"under"|null} side The side with the better EV.
 * @property {number|null} sideEdge `edge` re-signed so positive favours `side`.
 * @property {number|null} ev     Expected value in percent of stake.
 * @property {number|null} odds   American odds of the chosen side.
 * @property {"STRONG"|"SOLID"|"LEAN"|"PASS"} verdict
 * @property {string[]} why      One entry per demotion that fired on the way to
 *   `verdict`, in the order the ladder applies them. Empty when the verdict is
 *   the ladder's own answer. Presentation only — nothing reads it back.
 * @property {number|null} kelly  Quarter-Kelly stake fraction of bankroll.
 */

/**
 * Price a single over/under market against the model and return a verdict.
 *
 * Pipeline:
 *   1. Establish the market's vig-free `fairOver`. If a quote array is
 *      supplied, use the weighted consensus across books; otherwise de-vig the
 *      single over/under pair that was passed in.
 *   2. Shrink the model toward the market: keep at most `weight` of the
 *      disagreement, and never move more than 0.15 of probability.
 *   3. Compute EV for both sides at their respective prices, pick the better.
 *   4. Run the verdict ladder, then apply four demotions.
 *   5. Stake at a quarter of full Kelly.
 *
 * @param {number|null} modelOver - Model P(outcome > line).
 * @param {number|null} line - The market point (e.g. 5.5 strikeouts).
 * @param {number|null} overOdds - American odds on the over, or null.
 * @param {number|null} underOdds - American odds on the under, or null.
 * @param {object} [opts]
 * @param {Array<{book:string, point:number, over:number|null, under:number|null, w:number}>} [opts.quotes]
 *   All book quotes at this point. When present it wins over `overOdds`/`underOdds`
 *   for the fair-price calculation (but NOT for the EV calculation, which still
 *   uses the two prices passed in).
 * @param {number} [opts.weight=0.55] - Fraction of model/market disagreement to keep.
 * @param {boolean} [opts.smallSample] - Player has thin playing-time data.
 * @returns {EdgeResult|null} null when `modelOver` or `line` is null.
 */
export function evaluateEdge(modelOver, line, overOdds, underOdds, opts = {}) {
  if (modelOver == null || line == null) return null;

  // ── 1. market fair price ──────────────────────────────────────────────────
  // With a quote array: weighted consensus across every book at this point.
  // Without: de-vig the single pair, and claim nBooks = 1 if either side of
  // that pair exists at all.
  //
  // TODO(recon): the `nBooks` that comes back from `consensusFair` counts
  // *two-sided quote entries*, not distinct books. `attachLines` can hand this
  // function the same book twice (once from the base market, once from the
  // alternate market at the same point), which inflates `nBooks` here and
  // double-weights that book in the consensus. The `nBooks` stored on the row
  // itself is de-duplicated by book, so the two numbers disagree.
  const {
    fairOver,
    vig,
    twoSided,
    nBooks,
    sharp,
  } = opts.quotes?.length
    ? consensusFair(opts.quotes)
    : {
        ...devig(overOdds, underOdds),
        nBooks: overOdds != null || underOdds != null ? 1 : 0,
        sharp: false,
      };

  // ── 2. blend the model toward the market ──────────────────────────────────
  // `weight` is the per-market confidence (MARKET_WEIGHT); 0.55 is the default
  // for anything without an entry. A thin sample costs 40% of that confidence.
  let weight = opts.weight ?? 0.55;
  if (opts.smallSample) weight *= 0.6;

  // Raw disagreement, signed toward the over.
  const edge = fairOver != null ? modelOver - fairOver : null;

  // usedOver starts at the market's fair price and moves `weight` of the way
  // toward the model, but the *pre-weight* move is clamped to +-0.15 first.
  // So the largest possible displacement from fair is weight * 0.15 (0.0825 at
  // the default weight). With no market price at all, fall back to the raw model.
  const usedOver =
    fairOver != null ? fairOver + weight * clamp(edge, -0.15, 0.15) : modelOver;

  // ── 3. side selection ─────────────────────────────────────────────────────
  // EV in percent of stake, at each side's own posted price.
  const evOver = overOdds != null ? blend(usedOver, overOdds, "over") : null;
  const evUnder = underOdds != null ? blend(usedOver, underOdds, "under") : null;

  let side = null;
  let ev = null;
  let odds = null;
  // Ties (evOver === evUnder) go to the over: the over branch takes `>=` and
  // the under branch requires a strict `>`.
  if (evOver != null && (evUnder == null || evOver >= evUnder)) {
    side = "over";
    ev = evOver;
    odds = overOdds;
  }
  if (evUnder != null && (evOver == null || evUnder > evOver)) {
    side = "under";
    ev = evUnder;
    odds = underOdds;
  }

  // `sideEdge` flips the sign so a positive value always means "the model likes
  // the chosen side".
  //
  // TODO(recon): when no side was selected (both prices null) `side` is null,
  // which is not "over", so this returns `-edge`. The verdict ladder is gated
  // on `ev != null` so it cannot act on that value, but the field is still
  // returned to the UI with an inverted sign.
  const sideEdge = edge == null ? null : side === "over" ? edge : -edge;

  // ── 4. verdict ladder ─────────────────────────────────────────────────────
  // `why` records the reason each demotion below fires, in firing order, so the
  // UI can annotate a LEAN/PASS that would otherwise look wrong next to its EV.
  // Additive only: no threshold, weight, clamp or demotion rule changes here.
  const why = [];
  let verdict = "PASS";
  const smallSample = !!opts.smallSample;
  if (ev != null && sideEdge != null && !smallSample) {
    // Both EV (percent) and probability edge must clear the bar together.
    // FIX(v22) — STRONG's EV bar was 10, and it was ARITHMETICALLY UNREACHABLE
    // for 8 of the 9 batter markets.
    //
    // The proof is short. `usedOver` can sit at most `weight * 0.15` above fair,
    // because step 2 clamps the pre-weight move to 0.15. At a -110/-110 market
    // (decimal 1.909, fair 0.5) the best attainable EV is therefore
    //
    //     EV_max = (0.5 + weight*0.15) * 1.909 - 1
    //
    //     weight 0.30 -> 4.05%    weight 0.45 -> 8.34%
    //     weight 0.35 -> 5.48%    weight 0.50 -> 9.77%
    //     weight 0.40 -> 6.91%    weight 0.55 -> 11.20%
    //
    // Only `batter_strikeouts` (0.55) could clear 10, and only in a window ~1
    // probability point wide — whose top edge is closed by the demotion below,
    // since floating point makes 0.65 - 0.5 = 0.15000000000000002 > 0.15.
    //
    // So the top tier could essentially never fire at the most common price in
    // the book. That is a defect, not a risk preference: a tier that cannot
    // exist is not a conservative tier, it is a dead branch.
    //
    // 7 is the largest round bar that is attainable at the median market weight
    // (0.45) at -110, with headroom at better prices. SOLID and LEAN are
    // untouched — both were already reachable (raw edges of 0.1115 and 0.0825
    // respectively at weight 0.45).
    //
    // The `sideEdge` bars are also untouched. They are effectively a floor
    // rather than a co-equal gate — the EV bar binds first in every realistic
    // market — but they cost nothing and they stop a large EV built purely on a
    // long price from promoting itself on a tiny probability disagreement.
    if (ev >= 7 && sideEdge >= 0.07) verdict = "STRONG";
    else if (ev >= 5 && sideEdge >= 0.05) verdict = "SOLID";
    else if (ev >= 2.5 && sideEdge >= 0.03) verdict = "LEAN";
  } else if (
    ev != null &&
    sideEdge != null &&
    smallSample &&
    ev >= 7 &&
    sideEdge >= 0.07
  ) {
    // A small-sample player can never rate better than LEAN, and only at the
    // STRONG thresholds — which tracks the bar above, so this moves 10 -> 7
    // with it. Note the weight haircut (`weight *= 0.6`) applies before EV is
    // computed, so a thin-sample row still needs a much larger raw edge than
    // this reads: at weight 0.45 -> 0.27 and a -110 price, EV tops out at 3.2%,
    // and the row is a PASS no matter how far the model is from the market.
    // That is the intended behaviour — it just means this branch only fires at
    // plus prices.
    verdict = "LEAN";
  }
  // The small-sample cap was in play for this row's ladder run.
  if (smallSample && ev != null && sideEdge != null) why.push("small sample");

  // Demotion (a): a one-sided market, or a model absurdly far from fair, is
  // never better than a LEAN. A blow-out disagreement is treated as evidence
  // the model is wrong, not as free money.
  //
  // FIX(v22) — this threshold was 0.15, the SAME number as the shrink clamp in
  // step 2, and that collision was a double penalty. The clamp already caps how
  // much of a large disagreement reaches the price: past 0.15 the extra edge is
  // simply discarded, so the model's exposure is bounded no matter how far off
  // it is. Demoting at the same point meant every row that reached the cap was
  // then punished for reaching it — and since SOLID and STRONG need raw edges
  // in the 0.11-0.17 range at a -110 price, the top tiers lived in exactly the
  // band this rule was firing on. The two rules were fighting.
  //
  // 0.25 keeps the guard for genuinely absurd disagreements (a model 25 points
  // off a two-sided market is broken, not lucky) while letting the clamp do the
  // job it was already doing. Nothing about the EV or Kelly maths changes.
  const modelFarFromMarket = edge != null && Math.abs(edge) > 0.25;
  if ((!twoSided || modelFarFromMarket) && verdict !== "PASS") {
    if (!twoSided) why.push("one-sided market");
    if (modelFarFromMarket) why.push("model >25pts off market");
    verdict = "LEAN";
  }

  // Demotion (a2) — IMPLAUSIBILITY SUPPRESSION (2026-08-31).
  //
  // Measured against real posted prices at FanDuel, DraftKings and Pinnacle on
  // the 2026-08-31 slate (59 priced pitcher lines), this model's probability
  // differs from the vig-free market consensus by a MEDIAN of 7.1 points, a
  // mean of 8.0, and a maximum of 41.3 — and the disagreement is
  // one-directional (signed mean -3.5%, i.e. the model leans UNDER).
  //
  // A model with a genuine 7-point edge on liquid pitcher props priced by
  // Pinnacle would be among the most profitable betting operations in
  // existence. This one is not. So a large gap is evidence the MODEL is wrong,
  // not that the market is: the biggest apparent edges are the biggest errors,
  // and a board sorted by EV therefore recommends its own worst mistakes
  // first. On that slate the top four plays by EV were all >15 points off
  // consensus, led by a 41-point disagreement shown as +8.4% EV.
  //
  // Demotion (a) capped those at LEAN, which still displays them as plays.
  // This rule removes them from the board entirely. It is deliberately a hard
  // PASS rather than a cap: there is no stake size at which betting a number
  // we believe to be an error is correct.
  //
  // The 0.12 threshold sits just above the measured median disagreement, so it
  // suppresses the tail without silencing the whole board. It is a safety
  // limit, NOT a fitted parameter — nothing here has been validated as
  // profitable, and see trackRecord.js for what has and has not been measured.
  const modelImplausible = edge != null && Math.abs(edge) > 0.12;
  if (modelImplausible && verdict !== "PASS") {
    why.push("model >12pts off market — treated as model error, not edge");
    verdict = "PASS";
  }

  // Demotion (b): a single book cannot make a STRONG.
  if ((nBooks ?? 0) < 2 && verdict === "STRONG") {
    why.push("single book");
    verdict = "SOLID";
  }

  // Demotion (c) / (d): price cutoffs on the chosen side.
  //   longer than +250        -> PASS outright (too much variance, thin market)
  //   +150..+250, or < -300   -> STRONG/SOLID capped at LEAN
  // Note these are else-if: a >+250 price short-circuits before the cap.
  if (odds != null && odds > 250) {
    why.push("price past +250");
    verdict = "PASS";
  } else if (
    odds != null &&
    (odds > 150 || odds < -300) &&
    (verdict === "STRONG" || verdict === "SOLID")
  ) {
    why.push(odds > 150 ? "long price" : "heavy juice");
    verdict = "LEAN";
  }

  // ── 5. staking ────────────────────────────────────────────────────────────
  // Probability of the side actually being bet, then quarter Kelly.
  const sideProb = side === "over" ? usedOver : side === "under" ? 1 - usedOver : null;
  //
  // TODO(recon): `kellyFraction` returns null when the price cannot be
  // converted to decimal odds (NaN input). `null * 0.25` evaluates to 0, not
  // null, so an unconvertible price silently reports a 0% stake rather than
  // "unknown". Note also that `kelly` is computed regardless of `verdict`, so
  // a PASS row still carries a non-zero stake suggestion.
  const kelly =
    sideProb != null && odds != null ? kellyFraction(sideProb, odds) * 0.25 : null;

  return {
    modelOver,
    usedOver,
    fairOver,
    vig,
    twoSided,
    nBooks,
    sharp,
    edge,
    side,
    sideEdge,
    ev,
    odds,
    verdict,
    why,
    kelly,
  };
}
