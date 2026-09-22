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
 * Dimensionless in [0, 1]; higher means more weight on the model.
 *
 * MEASURED (v36.2). These used to run 0.30-0.55, set by how well we believed
 * each market was modelled. That belief was tested and it was wrong. On 153,728
 * settled batter contracts and 1,598 pitcher contracts, the weight on
 * (model - market) that minimises Brier score is 0.10 pooled, and the market
 * beats the model outright in every series and window with the interval
 * excluding zero. The numbers below are those measurements, not judgements:
 *
 *   pitcher_strikeouts  0     optimal 0 in both windows (docs/KALSHI-BACKTEST.md)
 *   pitcher_outs        0.10  0.1 in both halves (docs/OUTS-STUDY.md)
 *   batter_hits         0.10  n=30,817
 *   batter_total_bases  0.15  n=40,742
 *   batter_home_runs    0     n=13,426
 *   batter_rbis         0.15  n=19,512
 *   batter_hits_runs_rbis 0.10  n=49,231 — and do not trade this one at all
 *   everything else     0.10  the pooled optimum, for markets with no test of
 *                             their own yet
 *
 * A weight of 0 means the board reports that market and never calls a play in
 * it, which is the honest consequence of a model that cannot beat the price.
 *
 * Raise these only on evidence that runs the other way — closing-line value
 * from graded Results — and never because the board looks empty.
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
  pitcher_strikeouts: 0,
  pitcher_outs: 0.1,
  pitcher_hits_allowed: 0.1,
  pitcher_earned_runs: 0.1,
  pitcher_walks: 0.1,
  batter_hits: 0.1,
  batter_total_bases: 0.15,
  batter_home_runs: 0,
  batter_singles: 0.1,
  batter_strikeouts: 0.1,
  batter_hits_runs_rbis: 0.1,
  batter_runs_scored: 0.1,
  batter_rbis: 0.15,
  batter_stolen_bases: 0.1,
  nrfi: 0.1,
  game_ml: 0.1,
  game_spread: 0.1,
  game_total: 0.1,
};
