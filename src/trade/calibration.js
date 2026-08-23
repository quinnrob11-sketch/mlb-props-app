/**
 * Measured calibration corrections, applied before anything is traded.
 *
 * THE PROBLEM THIS SOLVES
 *
 * The premise of the whole system is "trade where the model's probability beats
 * the price". That only works if the model's probability is RIGHT. Where it is
 * systematically off, the apparent edge is partly the model's own error, and
 * trading it is paying the exchange for the privilege of being wrong.
 *
 * `tools/backtest.mjs` measures exactly this — predicted versus observed at
 * every standard line. Kalshi lists SEVEN daily MLB player-prop series
 * (KXMLBHRR, KXMLBTB, KXMLBHIT, KXMLBHR, KXMLBRBI, KXMLBKS, KXMLBOUTS), all
 * verified to have open markets. On the worst of them the miscalibration is
 * large, one-directional, and almost identical across two independent seasons:
 *
 *     line                       2025      2026     mean
 *     batter_hits_runs_rbis@1.5  -0.8pp   -0.5pp   -0.65   model too LOW
 *     batter_hits_runs_rbis@2.5  -1.3pp   -1.1pp   -1.20   model too LOW
 *     batter_total_bases@0.5     +1.5pp   +1.7pp   +1.60   model too HIGH
 *     batter_total_bases@1.5     +0.7pp   +0.5pp   +0.60   model too HIGH
 *     batter_hits@0.5            +1.5pp   +1.7pp   +1.60   model too HIGH
 *     batter_hits@2.5            -0.8pp   -0.7pp   -0.75   model too LOW
 *     batter_rbis@1.5            -0.7pp   -0.8pp   -0.75   model too LOW
 *
 * Two things make this worth acting on rather than noting. The signs never
 * flip, and the magnitudes agree to within 0.2pp on a different season with
 * different players — that is a property of the model, not of a sample.
 *
 * WHAT THIS TABLE IS FOR, AND WHAT IT IS NOT FOR
 *
 * Every entry is a patch over something the model does not know. The right end
 * state for any of them is DELETION, because the model learned it. That has now
 * happened twice: `batter_hits_runs_rbis@0.5` carried the largest correction in
 * this file — 3.25 points, across two measurement rounds — and is gone entirely
 * because v31.3 gave that distribution its missing point mass at zero. `@3.5`
 * went with it.
 *
 * So a growing table is a warning sign, not progress. Re-derive after every
 * model change and delete what the model has absorbed.
 *
 * WHY IT MATTERS SO MUCH HERE SPECIFICALLY
 *
 * `batter_hits_runs_rbis@0.5` is the single worst line in the model AND one of
 * the seven series Kalshi lists. Untouched, an apparent 4-point edge buying YES
 * there is really 0.65 points — and after the ~1.7c fee at those prices it is
 * NEGATIVE expectation. That is the exact trade this system would otherwise
 * have made most often, because a market where the model is systematically too
 * high is a market where it constantly thinks it sees value.
 *
 * Conversely `batter_total_bases@2.5` and `@3.5` measure clean in both seasons.
 * That is where the model's edge is most likely to be real.
 *
 * HOW CORRECTIONS ARE CHOSEN
 *
 * Only applied where the gap is at least 0.5pp AND carries the same sign in
 * both seasons. Anything smaller or less consistent is left alone — correcting
 * noise just moves the error somewhere less visible. The correction is the mean
 * of the two seasons, never the larger of them.
 *
 * Re-measure with:
 *   node tools/backtest.mjs --from <start> --to <end> --kind batter
 */

/** Minimum consistent gap, in probability points, worth correcting. */
const MIN_CORRECTION = 0.005;

/**
 * Signed corrections to SUBTRACT from the model's P(outcome > line).
 * Positive entries mean the model reads too high and is pulled down.
 */
export const CALIBRATION = {
  // ── Batter entries, RE-DERIVED against the v31 model ─────────────────────
  //
  // The previous values were fitted before v31 corrected the contact/power
  // split, so they were partly double-counting a bias the model no longer has.
  // Re-measured on both seasons, same rule as before (>= 0.5pp, same sign in
  // each year, mean not maximum):
  //
  //     line                       2025     2026     was      now
  //     batter_hits_runs_rbis@0.5  +3.2pp  +3.3pp   3.35     3.25
  //     batter_hits_runs_rbis@2.5  -1.9pp  -1.7pp  -1.65    -1.80
  //     batter_hits_runs_rbis@3.5  -1.2pp  -1.2pp  -1.10    -1.20
  //     batter_hits@0.5            +1.5pp  +1.7pp   1.80     1.60
  //     batter_hits@2.5            -0.8pp  -0.7pp  -0.65    -0.75
  //     batter_total_bases@0.5     +1.5pp  +1.7pp   1.80     1.60
  //     batter_total_bases@1.5     +0.7pp  +0.5pp   0.70     0.60
  //     batter_rbis@1.5            -0.7pp  -0.8pp  -0.75    -0.75
  //
  // THE INTERESTING RESULT IS HOW LITTLE THEY MOVED. v31 took the batter mean
  // biases to zero in both seasons — hits +0.2/+0.7%, singles -0.4/+0.5%, home
  // runs +0.6/-0.7% — and yet these per-line gaps are within ~0.2pp of what
  // they were. Fixing the MEAN did not fix the SHAPE.
  //
  // That is worth stating because it is easy to assume otherwise. A market can
  // have a perfectly centred projection and still misprice a specific line, and
  // `batter_hits_runs_rbis@0.5` is the clearest case in this model: the market
  // now averages +0.5% and that one line is still 3.25 points high. Its problem
  // is the shape of the distribution near zero, not where the distribution sits
  // — and no amount of correcting the mean will reach it.
  // RE-DERIVED AGAIN after v31.3 zero-inflated this distribution. The change is
  // the largest in this file's history, and it is a deletion:
  //
  //     line   2025     2026     was      now
  //     @0.5   +0.1pp   +0.2pp   3.25     REMOVED
  //     @1.5   -0.8pp   -0.5pp   none    -0.65
  //     @2.5   -1.3pp   -1.1pp  -1.80    -1.20
  //     @3.5   -0.4pp   -0.4pp  -1.20     REMOVED
  //
  // `@0.5` carried the biggest correction in the table — 3.25 points — for two
  // measurement rounds. It is gone because the MODEL now gets that line right:
  // the gap was a missing point mass at zero, and v31.3 put it there. A blank
  // batter-game is 1.8x commoner than independence implies, and once the
  // distribution says so, there is nothing left for this layer to correct.
  //
  // That is the outcome to want. A correction here is a patch over something the
  // model does not know; the right end state for any entry is to be deleted
  // because the model learned it. Two of these four just were.
  //
  // `@3.5` also drops out: -0.4pp in both seasons is below the 0.5pp floor, and
  // correcting noise moves error somewhere less visible rather than removing it.
  batter_hits_runs_rbis: {
    1.5: -0.0065,
    2.5: -0.0120,
  },
  batter_total_bases: {
    0.5: 0.0160,
    1.5: 0.0060,
  },
  batter_hits: {
    0.5: 0.0160,
    2.5: -0.0075,
  },
  batter_rbis: {
    1.5: -0.0075,
  },
  // Uniformly negative across every line: the model reads LOW on outs at all
  // depths, which is the same -1.0% mean bias the board reports, seen line by
  // line. Correcting it turns what look like marginal UNDER edges into the
  // OVER edges they actually are.
  pitcher_outs: {
    14.5: -0.0135,
    15.5: -0.0130,
    16.5: -0.0135,
    17.5: -0.0190,
    18.5: -0.0260,
  },
  // 4.5 is deliberately absent: it measured -0.7pp in 2025 and +0.4pp in 2026.
  // A sign flip between seasons is noise, and correcting noise just relocates
  // the error somewhere less visible.
  pitcher_strikeouts: {
    3.5: 0.0130,
    5.5: -0.0110,
    6.5: -0.0170,
    7.5: -0.0195,
  },
  // batter_home_runs is listed on Kalshi but has NO entry: it measured -0.0pp
  // and -0.2pp. That is a market the model already prices honestly, and adding
  // a correction to it would be inventing one.
};

/**
 * Apply the measured correction for a market and line.
 *
 * Unknown market/line combinations pass through untouched — the absence of a
 * measurement is not evidence of zero bias, and inventing a correction for a
 * line that was never measured would be exactly the failure this module exists
 * to prevent.
 *
 * @param {number} modelProb 0..1, the model's raw P(outcome > line)
 * @param {string} market
 * @param {number} line
 * @returns {{prob:number, correctionPts:number, corrected:boolean}}
 */
export function calibrate(modelProb, market, line) {
  const raw = { prob: modelProb, correctionPts: 0, corrected: false };
  if (modelProb == null || isNaN(modelProb)) return raw;

  const correction = CALIBRATION[market]?.[line];
  if (correction == null || Math.abs(correction) < MIN_CORRECTION) return raw;

  // Clamped away from the boundaries: a correction must never manufacture a
  // certainty the model did not express.
  const prob = Math.min(0.999, Math.max(0.001, modelProb - correction));
  return { prob, correctionPts: correction, corrected: true };
}

/**
 * Whether a market/line has been measured at all.
 *
 * Exposed so a caller can choose to trade ONLY measured lines — the most
 * conservative posture available, and a reasonable default while a live track
 * record is being built.
 */
export function isMeasured(market, line) {
  return CALIBRATION[market]?.[line] != null;
}
