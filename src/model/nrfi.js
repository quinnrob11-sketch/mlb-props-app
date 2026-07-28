/**
 * NRFI / YRFI (No Runs First Inning) projection.
 *
 * Reconstructed from `/tmp/work/app.js` lines 503-525 (`Xp`).
 *
 * NAMING (glossary said "verify before naming"): the function returns
 * `{nrfiProb, yrfiProb, fairNrfiOdds, fairYrfiOdds}` and its only call site
 * (`loadSlate`, app.js:1249) assigns it to `game.nrfi` and prices it against
 * the `totals_1st_1_innings` 0.5 line. `projectNrfi` is correct.
 *
 * Call site argument order (app.js:1249):
 *   projectNrfi(awayEra, homeEra, awayTop3Obp, homeTop3Obp, park, lg, wx)
 * where the ERAs are IP-weighted 2026/2025 blends (2025 at 0.6) defaulting to
 * 4.20, and the OBPs are the mean current-season OBP of the first three
 * lineup slots (null when the lineup is unposted).
 */

import { clamp } from '../lib/probability.js';
import { parkFactor } from '../lib/parks.js';
import { probToAmerican } from '../lib/odds.js';

/**
 * @param {number}  awayEra      away starter's blended ERA
 * @param {number}  homeEra      home starter's blended ERA
 * @param {number?} awayTop3Obp  away team's top-3 average OBP (null if unknown)
 * @param {number?} homeTop3Obp  home team's top-3 average OBP
 * @param {string}  park         venue name
 * @param {object}  lg           league averages — ACCEPTED BUT NEVER READ
 *                               (TODO(recon): dead parameter, preserved for
 *                               call-site arity)
 * @param {object}  wx           weather {indoor, tempF, windMph}
 */
export function projectNrfi(awayEra, homeEra, awayTop3Obp, homeTop3Obp, park, lg, wx) {
  // Weather on first-inning run scoring. Deliberately weaker than the batter
  // HR model: +0.3% per degree F (vs 0.006) and clamped to 0.94-1.06 (vs
  // 0.88-1.12), because a first-inning run is mostly singles/walks, which are
  // far less temperature-sensitive than fly-ball carry.
  const weather = wx && !wx.indoor && wx.tempF != null
    ? clamp(1 + 0.003 * (wx.tempF - 72), 0.94, 1.06)
    : 1;

  // Combined run environment: park run factor at the standard 0.7 weight,
  // times weather. Pushes scoring UP at Coors, DOWN at Oracle/T-Mobile.
  const runEnvironment = parkFactor(park, 'runs', 0.7) * weather;

  // Probability that a single "run-scoring opportunity unit" fails to produce
  // a run. 0.735^1 is the baseline no-run probability for a league-average
  // half inning; raising it to a power > 1 makes a scoreless frame LESS
  // likely.
  const NO_RUN_BASE = 0.735;

  // Normaliser: 0.52 runs is roughly a league-average first-inning run
  // expectancy per team. Dividing by it recentres the exponent on 1.0 for an
  // average matchup.
  const AVG_FIRST_INNING_RUNS = 0.52;

  /**
   * P(the offense facing `era` does NOT score in the first).
   *
   * @param {number}  era  opposing starter's blended ERA
   * @param {number?} obp  this offense's top-3 OBP
   */
  const sideNoRunProb = (era, obp) => {
    // Lineup-quality multiplier, centred on a .325 top-3 OBP and clamped to
    // ±25%/-20%. A strong top of the order pushes scoring UP.
    const lineupFactor = obp ? clamp(obp / 0.325, 0.8, 1.25) : 1;

    // Expected first-inning runs for this side:
    //   era/9 = runs per inning; x1.12 because the first inning is above
    //   average (guaranteed top-of-the-order, no pitcher warm-up carryover);
    //   x lineup quality; x run environment; then normalised by the league
    //   first-inning average. Clamped to 0.4-2.2 league-relative units.
    const relativeRuns = clamp(
      (((era ?? 4.2) * 1.12) / 9) * lineupFactor * runEnvironment / AVG_FIRST_INNING_RUNS,
      0.4, 2.2,
    );
    return Math.pow(NO_RUN_BASE, relativeRuns);
  };

  // Cross the matchups: the AWAY offense bats against the HOME starter, so it
  // is scored with `homeEra` + `awayTop3Obp`, and vice versa.
  const awayNoRun = sideNoRunProb(homeEra, awayTop3Obp);
  const homeNoRun = sideNoRunProb(awayEra, homeTop3Obp);

  // Joint NRFI, treating the two halves as independent, clamped to 0.15-0.90,
  // then shrunk 25% of the way back to the 0.54 league NRFI base rate. The
  // 0.75 damping is a confidence haircut: it pulls extreme matchups toward the
  // market's resting price and keeps the model from screaming at Coors.
  const nrfiProb = 0.54 + (clamp(awayNoRun * homeNoRun, 0.15, 0.9) - 0.54) * 0.75;

  return {
    nrfiProb,
    yrfiProb: 1 - nrfiProb,
    fairNrfiOdds: probToAmerican(nrfiProb),
    fairYrfiOdds: probToAmerican(1 - nrfiProb),
  };
}
