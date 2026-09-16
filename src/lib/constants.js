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
/**
 * Board policy (v35.1): which rows may be shown as plays at all.
 *
 * Measured against real sportsbook prices on 2026-09-16 (1,392 prop lines and
 * 45 game lines with two or more books), where the sportsbook consensus and
 * Kalshi agreed with EACH OTHER to a median 0.3 points:
 *
 *   game lines      model a median 3.2-3.7 pts from market
 *   batter props    2.2-4.6 pts
 *   pitcher props   7-9 pts on strikeouts, outs and hits allowed
 *
 * A model ten times noisier than the market it prices has no business
 * recommending bets into it, so:
 *
 *   - game lines and NRFI are INFORMATION ONLY: the board shows the model's
 *     number next to the market's, and never calls a play;
 *   - a pitcher prop needs 2+ sportsbooks pricing it and a price no longer than
 *     +150 before it can be anything but a PASS. Nearly every pitcher "play" on
 *     that slate was a one-book quote at +150 to +250 in a market where the model
 *     was 7-9 points off.
 *
 * Loosen these only on evidence — closing-line value from graded Results — not
 * because the board looks empty.
 */
export const PLAY_RULES = {
  gameLinesInformationOnly: true,
  pitcher: { minBooks: 2, maxOdds: 150 },
};

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
  // Game lines (v35). Low on purpose: these are the sharpest prices in the
  // sport, and the game model is new and has no track record against them.
  game_ml: 0.3,
  game_spread: 0.3,
  game_total: 0.3,
};
