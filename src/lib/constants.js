/**
 * Shared model constants.
 *
 * Reconstructed from the minified bundle (`/tmp/work/app.js`, lines 74-90).
 * Values preserved exactly.
 *
 * Minified origins: Pi=MARKET_WEIGHT.
 */

/**
 * Per-market confidence weight: how much the model's own projection is trusted
 * relative to the de-vigged market consensus when the two are combined.
 *
 * Dimensionless in [0, 1]; higher means more weight on the model. The spread
 * (0.3 for stolen bases up to 0.55 for batter strikeouts) tracks how well each
 * market is modelled — high-variance, low-sample markets such as stolen bases
 * and RBIs defer more to the market, while strikeout markets, which have the
 * most stable per-plate-appearance rates, lean hardest on the model.
 *
 * @type {Record<string, number>}
 */
export const MARKET_WEIGHT = {
  pitcher_strikeouts: 0.45,
  pitcher_outs: 0.5,
  pitcher_hits_allowed: 0.5,
  pitcher_earned_runs: 0.35,
  pitcher_walks: 0.45,
  batter_hits: 0.45,
  batter_total_bases: 0.45,
  batter_home_runs: 0.5,
  batter_singles: 0.5,
  batter_strikeouts: 0.55,
  batter_hits_runs_rbis: 0.4,
  batter_runs_scored: 0.35,
  batter_rbis: 0.35,
  batter_stolen_bases: 0.3,
  nrfi: 0.5,
};
