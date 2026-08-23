/**
 * League baselines and the empirical-Bayes shrinkage used by every projection.
 *
 * Reconstructed from `/tmp/work/app.js` lines 213-227 (`We` -> `shrunkRate`,
 * `Ln` -> `LEAGUE_AVG`).  Constants are reproduced exactly; nothing here has
 * been re-tuned.
 */

/**
 * League-average prior rates.
 *
 * `kRate` / `bbRate` / `hRate` / `hrRate` are *per plate appearance* on the
 * batter side and *per batter faced* on the pitcher side (the model treats the
 * two as interchangeable — see BATTER-ANALYSIS.md).  `avg` is hits per at-bat,
 * so it is NOT the same denominator as `hRate`.
 *
 * NOTE(recon): `loadSlate` overrides only `kRate`, `bbRate` and `avg` with
 * live slate-wide totals.  `hRate`, `hrRate`, `pitchesPerBF` and `strikePct`
 * always fall through to these frozen constants even when a live `lg` object
 * is supplied.  That asymmetry is preserved here deliberately.
 */
export const LEAGUE_AVG = {
  kRate: 0.221,
  bbRate: 0.082,
  hRate: 0.221,
  hrRate: 0.031,
  avg: 0.244,
  obp: 0.315,
  pitchesPerBF: 3.9,
  strikePct: 0.64,

  // ── Starting-pitcher baselines ────────────────────────────────────────────
  //
  // The four rates above are LEAGUE-WIDE: they mix starters and relievers.
  // That is right when the quantity being compared is also league-wide — the
  // opponent-lineup terms in `projectPitcher` divide a team's batting rate by
  // the league's batting rate, and both sides match.
  //
  // It is WRONG as a prior for a starter, and wrong as the denominator when
  // the numerator is a starter's rate. Relievers are a different population:
  // they throw an inning at a time, so they strike out more, walk more, and
  // allow fewer hits and homers. Measured over 8,138 starts against 26,682
  // relief appearances by `tools/backtest.mjs`:
  //
  //                starters   relievers   league-wide prior used before
  //     K / BF       0.2191     0.2259     0.221   -> starters' K biased UP
  //     H / BF       0.2223     0.2127     0.221   -> hits biased DOWN
  //     BB / BF      0.0797     0.0946     0.082   -> walks biased UP
  //     HR / BF      0.0327     0.0281     0.031   -> homers biased DOWN
  //
  // Those four biases are exactly the pattern the backtest reported: strikeouts
  // over-projected, hits allowed under-projected, in both seasons tested. The
  // HR gap is the largest at 5.2%, and it does the most damage because HR
  // shrinks hardest (strength 120), so a low prior drags every starter with it.
  //
  // `projectBatter` needs these too. Its `spK` / `spHit` / `spHr` multipliers
  // divide a STARTER's rate by a league rate, so an average starter has to come
  // out at exactly 1.0 or every batter on the slate is pushed the same way.
  spKRate: 0.2191,
  spBbRate: 0.0797,
  spHRate: 0.2223,
  spHrRate: 0.0327,
};

/**
 * Empirical-Bayes shrinkage of a rate toward a league prior.
 *
 *   rate = (x26 + 0.6 * x25 + strength * prior)
 *        / (pa26 + 0.6 * pa25 + strength)
 *
 * Two things are happening at once:
 *
 *  1. **Season weighting.** The prior season's events and denominator are both
 *     multiplied by 0.6, so 2025 is worth 60% of a 2026 plate appearance. This
 *     is a recency discount, not a sample-size discount — it pushes the
 *     estimate toward the current season's observed rate.
 *
 *  2. **Prior mass.** `strength` synthetic PA/BF are added at exactly the
 *     prior rate.  Larger `strength` = harder regression to league average =
 *     the projection moves *less* for a given player.  Callers pass bigger
 *     strengths for noisier events (HR: 100-120, triples: 120) and smaller
 *     ones for stable, high-frequency events (hits/K/BB: 60-70).
 *
 * With no playing time at all the function returns the prior unchanged.
 *
 * @param {number} x26      current-season event count
 * @param {number} pa26     current-season denominator (PA or BF)
 * @param {number} x25      prior-season event count
 * @param {number} pa25     prior-season denominator
 * @param {number} prior    league rate to shrink toward
 * @param {number} strength prior weight in denominator units (default 70)
 */
export function shrunkRate(x26, pa26, x25, pa25, prior, strength = 70) {
  const numerator = (x26 || 0) + 0.6 * (x25 || 0) + strength * prior;
  const denominator = (pa26 || 0) + 0.6 * (pa25 || 0) + strength;
  return denominator > 0 ? numerator / denominator : prior;
}
