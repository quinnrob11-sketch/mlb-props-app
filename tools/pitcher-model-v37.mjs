// FROZEN CONTROL — src/model/pitcher.js exactly as master shipped it at v37
// (980d4b4, "Remove the market-fitted pitcher trims"), before
// docs/PITCHER-PORT.md changed it.
//
// This is THE control. `tools/pitcher-model-v1.mjs` is the older v36.1 copy and
// is kept only to show how much of this port's gain v37's two-constant change
// already captured; the two files differ in exactly two values, `kLevel`
// 0.95 -> 1.0 and `hLevel` 0.97 -> 1.0, and in comments.
//
// Frozen for the reason the game port learned the hard way: the study's control
// was `src/model/pitcher.js` itself, so the moment a port lands, comparing
// against that import measures the new model against itself.
//
// Nothing here may be edited. Copy made with:
//   git show master:src/model/pitcher.js | sed -e "s#'../lib/#'../src/lib/#" \
//     -e "s#'./league.js'#'../src/model/league.js'#" >> tools/pitcher-model-v37.mjs
/**
 * Starting-pitcher projection.
 *
 * Reconstructed from `/tmp/work/app.js` lines 228-361 (`Wp` -> `projectPitcher`).
 * Every clamp bound, damping coefficient and dispersion parameter is preserved
 * exactly.  Comments describe *what each adjustment models and which way it
 * pushes*; they are not endorsements of the modelling choice.
 *
 * Shape of the pipeline:
 *
 *   season stats ──shrunkRate──▶ raw per-BF rates
 *                                     │
 *                    opponent + park adjustments (clamped)
 *                                     ▼
 *                              adjusted per-BF rates
 *                                     │
 *   pitch-count budget ──▶ IP budget ──┴──▶ projBF ──▶ every counting stat
 */

import { clamp, binomTailOver, poissonTailOver, negBinomTailOver }
  from '../src/lib/probability.js';
import { parkFactor } from '../src/lib/parks.js';
import { LEAGUE_AVG, shrunkRate } from '../src/model/league.js';

/**
 * Parse an MLB-style innings-pitched string ("5.2" = 5 and 2/3 innings) into a
 * real number.  The fractional digit counts *outs*, not tenths.
 *
 * NOTE(recon): in the bundle this is a free-standing shared helper (`An`,
 * bundle.pretty.js:9034) also used by `loadSlate` and `gradeSlate`.  It is
 * exported here so those call sites have a home; it arguably belongs in a
 * shared `lib/stats.js`.  TODO(recon): verify final placement.
 */
export function parseInningsPitched(ip) {
  if (ip == null) return 0;
  const text = String(ip);
  const [whole, frac] = text.split('.');
  return (parseInt(whole, 10) || 0) + (frac ? (parseInt(frac, 10) || 0) / 3 : 0);
}

/**
 * Project a starting pitcher's line and the per-market tail distributions the
 * edge engine consumes.
 *
 * @param {object}   input
 * @param {object}   input.season26  current-season pitching split
 * @param {object}   input.season25  prior-season pitching split
 * @param {Array}    input.gameLog   per-start log: {ip, pitches, bf, k, date}
 * @param {object}   input.opp       opposing team rates {kRate, bbRate, avg}
 * @param {string}   input.park      venue name (keys PARK_FACTORS)
 * @param {object}   input.lg        league overrides merged onto LEAGUE_AVG
 * @param {boolean}  [input.isHome]  starter pitches at home (home/away terms
 *                                   are skipped when absent)
 */
/**
 * The pitcher model's calibration settings in one place, so the backtest can
 * try alternatives without editing the model. Pass `input.tuning` to override
 * any of them for one call.
 *
 * REFIT(v35.1, 2026-09-16) with tools/tune-pitchers.mjs on a lookahead-free
 * replay of 988 real starts (tools/backtest-pitchers.mjs): every setting was
 * chosen on Aug 10-31 (586 starts) by log loss, then checked on Sep 1-15 (402
 * starts) it never saw. Holdout, before -> after:
 *
 *                 bias            spread ratio     log loss
 *     strikeouts  -5.1% -> +0.3%  1.20 -> 1.12     2.2040 -> 2.1897
 *     outs        -5.2% -> -3.0%  1.40 -> 0.98     2.5606 -> 2.4927
 *     hits        -3.9% -> -0.6%  0.95 -> 0.97     2.1764 -> 2.1704
 *
 * ("bias" is actual minus projected; a spread ratio above 1 means real outcomes
 * were wider than the model's distribution — i.e. it was overconfident.)
 *
 * What was wrong, and what each change does:
 *   - Strikeouts were projected ~5% high in both windows, and in the same
 *     direction as today's sportsbook prices, so the level trim retired in v34
 *     (it then disagreed with the market) is back at 0.95, and the batters-faced
 *     mixture is wider (+-5) because K outcomes spread 13% wider than modelled.
 *   - Outs were far too concentrated: a +-6 pitch leash put too much mass on
 *     15 and 18 outs and made every 14.5/17.5 over look 3-5 points too likely.
 *     +-18 matches the real spread. Recent workload now reads the last 3 starts
 *     rather than 5, which tracks the late-season shortening of starters; it
 *     still leaves September about 3% high, so treat outs overs with care.
 *   - Hits allowed were calibrated in shape and ~3% high in level.
 *
 * TRIED(v35.2), NOT SHIPPED — measured on the same replay extended to Jun 1
 * 2026 (fit Jun 1-Aug 31, holdouts Sep 1-15 and Aug 16-31) plus a full 2025
 * replay; none improved log loss consistently across those samples:
 *   - Recent-form K rate (last 3/5/8 starts vs the shrunk season rate): no
 *     out-of-sample gain in corr or error. Neither was a wider or narrower K
 *     shrinkage (strength 30/70, prior-season weight 0.3/0.6, spread x1.1-1.3).
 *   - Season swinging-strike rate (whiffs per pitch, from play-by-play) blended
 *     into the K rate: per-BF corr +-0.01, no gain on the count.
 *   - Opponent K% over the last 14/30 days instead of season: +0.008 corr in
 *     the regression, too small to justify a new live data feed.
 *   - K rate uncertainty in dist.k (p x 0.75/1/1.25 mixture, bfSpread 3):
 *     better on both fit windows and 2025, WORSE on Aug 16-31 (2.1130 ->
 *     2.1167). Worth re-testing with more data.
 *   - kLevel 0.96-0.97 after the reliever fix: better on fit and 2025, flat or
 *     worse on Aug 16-31. Left at 0.95, and that line used to end "strikeouts
 *     now run ~1.5% low" — see kLevel below, which measured it at 2.6 points
 *     and removed it.
 *   - Workload: long rest (>=12/15/20 days) or <3 starts budget cuts, recency-
 *     weighted pitch counts, keeping short outings, opponent pitches per PA,
 *     bullpen outs over the last 1-3 days, a team starter-depth effect, and
 *     re-fitting budgetSpread/hook constants — each <=0.001 or mixed.
 *   - Late season: the best September budget cut on 2025 September moved outs
 *     log loss only 2.5257 -> 2.5249 and made strikeouts worse; an outs-only
 *     September level did no better. The ~2% September outs shortfall is
 *     real in both seasons but too small next to outcome noise to fix this way.
 */
export const PITCHER_TUNING = {
  /**
   * v37: kLevel and hLevel were 0.95 and 0.97, and both are now 1.0.
   *
   * They were market-fitted trims — chosen to sit closer to a price — and the
   * accuracy audit measured what they cost against OUTCOMES over 9,019 starts
   * in two seasons: strikeout overs read 2.6 points low [-3.2, -2.1] and
   * hits-allowed overs 2.0 low. Removing them takes those calibration errors
   * to 0.81 and 0.34 points. See docs/ACCURACY.md.
   *
   * The trade was defensible while the goal was to track a market. It is not
   * defensible now that the goal is a projection you can read on its own, and
   * five studies have established the model cannot beat a price anyway — so
   * paying accuracy for closeness to one buys nothing.
   *
   * outsLevel stays at 0.98 deliberately. The same audit found that removing
   * it re-centres the level but leaves a genuine SHAPE error — the outs
   * distribution is too wide at both ends — which needs a narrower budget
   * distribution, not another constant set to 1.
   */
  kLevel: 1.0,
  bbLevel: 1.0,
  outsLevel: 0.98,
  hLevel: 1.0,
  /** Batters-faced spread of the three-point strikeout mixture. */
  bfSpread: 5,
  /** Pitch-budget spread of the three-point outs mixture. */
  budgetSpread: 18,
  hookBaseHazard: 0.005,
  hookBudgetScale: 10,
  /** Starts in the "recent" workload window. */
  recentStarts: 3,
  /** Weight of recent pitch counts vs season pitches/start in the budget. */
  recentBudgetWeight: 0.55,
  /** Weight of recent innings vs budget-implied innings in projIP. */
  recentIpWeight: 0.4,
  /**
   * Pitch budget for a pitcher with no start this season who has been
   * relieving: [base, multiplier] on his pitches per appearance. null = off.
   *
   * ADDED(v35.2). Chosen on Jun 1-Aug 31 2026 (2,363 starts) by K + outs log
   * loss; the surface is flat across [0,1.3]-[20,1.0], and 2025 picks the same
   * point. Together with `budgetFloor` 45 -> 25 (openers throw 30-45 pitches,
   * the old floor lifted them all to 45). Holdout Sep 1-15 2026, 402 starts,
   * before -> after (second holdout Aug 16-31, 430 starts, in brackets):
   *
   *                  strikeouts                 outs
   *     log loss     2.1897 -> 2.1676 (2.1392 -> 2.1179)   2.4927 -> 2.4431 (2.5135 -> 2.4770)
   *     Brier        0.1704 -> 0.1675           0.1884 -> 0.1848
   *     corr         0.459 -> 0.487 (0.438 -> 0.467)       0.531 -> 0.591 (0.460 -> 0.545)
   *     mean |err|   1.782 -> 1.750             3.008 -> 2.860
   *     bias         +0.3% -> +1.6%             -3.0% -> -1.9%
   *     spread ratio 1.12 -> 1.09               0.98 -> 0.88
   *
   *     K lines   3.5-7.5 pred: 65.4 48.0 32.2 19.9 11.3 -> 64.3 47.2 31.7 19.6 11.1
   *               observed:     65.7 48.0 33.6 22.9 11.2
   *     outs 13.5-18.5 pred:    69.8 64.4 47.6 42.3 36.5 17.6 -> 68.6 63.2 46.9 41.7 36.0 17.4
   *               observed:     67.9 63.2 45.0 40.8 35.6 15.4
   *
   * Hits 2.1704 -> 2.1531, walks 1.5511 -> 1.5401, ER 1.9767 -> 1.9699 on the
   * same holdout (projBF shrinks with the leash). Full 2025 replay (Apr 15 -
   * Sep 28, 4,370 starts): K 2.2265 -> 2.2116, outs 2.5146 -> 2.4771, outs corr
   * 0.377 -> 0.478. Most of the gain is on openers (who may well not carry a
   * Kalshi line): on starters with 3+ prior starts (374 of the holdout) outs log loss
   * moves 2.4311 -> 2.4277 and K 2.1717 -> 2.1752.
   */
  reliefBudget: [10, 1.2],
  /** Lowest pitch budget the leash model will accept. */
  budgetFloor: 25,
  /**
   * Home/away. `homeK` scales the per-BF strikeout rate by 1 + homeK at home
   * and 1 - homeK on the road; `homeBudget` moves the pitch budget by that
   * many pitches either way. Both need `input.isHome` and are neutral without.
   *
   * ADDED(v35.2). In the replay, with level and opponent already applied,
   * strikeouts ran +6.1% vs projection at home and -2.1% away in 2026 (2,765
   * starts), +7.1% / +0.1% in 2025 (4,370); outs +0.5% / -2.6% and
   * +1.0% / -1.2%. Fitted on Jun 1-Aug 31 2026 by log loss (homeK 0.03-0.04
   * and homeBudget 1-2 tie; 2025 agrees). Added on top of `reliefBudget`,
   * holdout Sep 1-15 2026 (402 starts), second holdout Aug 16-31 in brackets:
   *
   *     homeK 0 -> 0.03       K log loss  2.1676 -> 2.1607 (2.1179 -> 2.1130)
   *                           K Brier     0.1675 -> 0.1660
   *                           K corr      0.487 -> 0.498 (0.467 -> 0.476)
   *                           K mean|err| 1.750 -> 1.734
   *                           bias/spread +1.6% -> +1.6%, 1.09 -> 1.07
   *                           2025 replay K log loss 2.2116 -> 2.2088
   *                           (other markets unchanged: it only moves adjK)
   *
   *     homeBudget 0 -> 1     outs log loss 2.4431 -> 2.4411 (2.4770 -> 2.4759)
   *                           outs Brier    0.1848 -> 0.1845
   *                           outs corr     0.591 -> 0.593 (0.545 -> 0.547)
   *                           outs mean|err| 2.860 -> 2.857
   *                           K log loss    2.1607 -> 2.1595 (2.1130 -> 2.1122)
   *                           hits 2.1531 -> 2.1515 (2.1617 -> 2.1619),
   *                           walks/ER within +-0.0006 in both windows
   *                           2025 replay outs 2.4771 -> 2.4764, K unchanged
   *
   * The budget term is small; it is kept because it moves the right way in all
   * three samples, not because it is large.
   */
  homeK: 0.03,
  homeBudget: 1,
};

export function projectPitcher(input) {
  const T = { ...PITCHER_TUNING, ...(input.tuning || {}) };
  const {
    season26,
    season25,
    gameLog = [],
    opp,
    park,
    // Per-matchup platoon multipliers from model/platoon.js. Default neutral:
    // a pitcher with no usable splits, or a lineup whose handedness matches his
    // season mix, changes nothing.
    platoon,
  } = input;
  const pl = platoon || {};
  const plK = pl.k || 1;
  const plH = pl.h || 1;
  const plBB = pl.bb || 1;
  const plHR = pl.hr || 1;

  const lg = { ...LEAGUE_AVG, ...(input.lg || {}) };
  const s26 = season26 || {};
  const s25 = season25 || {};

  const bf26 = s26.battersFaced || 0;
  const bf25 = s25.battersFaced || 0;

  // ---------------------------------------------------------------------
  // 1. Raw per-batter-faced talent rates, shrunk to league priors.
  //    HR gets strength 120 (vs the 70 default) because per-BF home-run rate
  //    is the noisiest of the four — bigger strength ⇒ heavier regression ⇒
  //    the projection moves less off a hot/cold HR run.
  // ---------------------------------------------------------------------
  //
  //    FIX(v22) — these shrink toward the STARTING-PITCHER baselines, not the
  //    league-wide ones. Relievers are a different population (more strikeouts
  //    and walks, fewer hits and homers), so a league-wide prior drags every
  //    starter's projection toward a rate no starter actually posts. See the
  //    measured split in model/league.js.
  const kRate  = shrunkRate(s26.strikeOuts,  bf26, s25.strikeOuts,  bf25, lg.spKRate);
  const bbRate = shrunkRate(s26.baseOnBalls, bf26, s25.baseOnBalls, bf25, lg.spBbRate);
  const hRate  = shrunkRate(s26.hits,        bf26, s25.hits,        bf25, lg.spHRate);
  const hrRate = shrunkRate(s26.homeRuns,    bf26, s25.homeRuns,    bf25, lg.spHrRate, 120);

  // Opponent lineup quality. Falls back to league average when the opponent
  // aggregate is missing, which makes the adjustment a no-op (ratio = 1).
  const oppK   = opp?.kRate  ?? lg.kRate;
  const oppBB  = opp?.bbRate ?? lg.bbRate;
  const oppAvg = opp?.avg    ?? lg.avg;

  // ---------------------------------------------------------------------
  // 2. Opponent + park adjustments.
  //
  //    Each is `rate * (1 + damping * (oppRate/leagueRate - 1))`. The damping
  //    coefficient is the fraction of the opponent's deviation from league
  //    average that is passed through to this pitcher:
  //      K   0.40 — a high-K lineup pushes projected K rate UP by 40% of its
  //                 own excess K rate.
  //      BB  0.30 — patient lineups push walks UP, more weakly.
  //      H   0.35 — the opponent's team AVG pushes hits allowed UP.
  //    Park weights differ by stat: strikeouts use a HALF-weight park factor
  //    (0.5) because K park effects are mostly a foul-territory/backdrop
  //    artifact, hits/HR use the standard 0.7.
  //
  //    Walks receive NO park factor at all even though PARK_FACTORS carries a
  //    `bb` column — the `bb` column is dead data. HR receives NO opponent
  //    adjustment even though lineup HR power obviously matters.
  // ---------------------------------------------------------------------
  // FIX(v22.8) — the K/contact split correction.
  //
  // Across both backtest seasons the model over-projected strikeouts and
  // under-projected hits allowed by almost exactly the same amount:
  //
  //              strikeouts   hits allowed
  //     2025        +1.6%        -1.8%
  //     2026        +2.3%        -2.6%
  //
  // Equal, opposite, and stable. Batters faced is right to within 0.3%, so this
  // is not a volume error — the model is mis-allocating a fixed number of plate
  // appearances BETWEEN strikeouts and balls in play. It credits starters with
  // roughly 2% more punchouts than they get, and every one of those is a plate
  // appearance that should have had a chance to fall in.
  //
  // The two constants below are one correction, not two: they are the same
  // ~2% moved from the strikeout column to the contact column, which is why
  // they are defined together and must move together. This is an EMPIRICAL
  // correction — measured over 7,144 starts and validated in both directions on
  // two seasons — not a mechanism. The underlying cause is still unknown; four
  // structural fixes (starter priors, out-rate constants, park re-centring,
  // regression to the mean) each moved it and none removed it.
  const K_CONTACT_SPLIT = 0.98;

  // Home/away (see `homeK` in PITCHER_TUNING): starters strike out more at
  // home. Neutral when the caller does not say which side he is on.
  const homeKFactor = input.isHome == null ? 1 : input.isHome ? 1 + T.homeK : 1 - T.homeK;

  const adjK = clamp(
    kRate * (1 + 0.4 * (oppK / lg.kRate - 1)) * parkFactor(park, 'so', 0.5) * K_CONTACT_SPLIT * plK * homeKFactor,
    0.05, 0.45,
  );
  const adjBB = clamp(
    bbRate * (1 + 0.3 * (oppBB / lg.bbRate - 1)) * plBB,
    0.02, 0.18,
  );
  const adjH = clamp(
    hRate * (1 + 0.35 * (oppAvg / lg.avg - 1)) * parkFactor(park, 'hits', 0.7) *
      (2 - K_CONTACT_SPLIT) * plH,
    0.12, 0.34,
  );
  const adjHR = clamp(
    hrRate * parkFactor(park, 'hr', 0.7) * plHR,
    0.005, 0.07,
  );

  // ---------------------------------------------------------------------
  // 3. Pitch-count budget — how deep the manager will let him go.
  // ---------------------------------------------------------------------
  const recent = gameLog.slice(-T.recentStarts);

  // Median pitch count over the recent starts, used only as a yardstick.
  const medianPitches = (() => {
    const sorted = recent.map((g) => g.pitches || 0).sort((a, b) => a - b);
    return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  })();

  // Keep only "real" starts: >= 60% of the median pitch count. This drops
  // rain-shortened / ejected / opener outings so they don't drag the budget
  // DOWN artificially.
  const fullOutings = recent.filter((g) => (g.pitches || 0) >= 0.6 * medianPitches);

  const recentPitchAvg = fullOutings.length
    ? fullOutings.reduce((sum, g) => sum + (g.pitches || 0), 0) / fullOutings.length
    : null;

  // A season only counts as "starter usage" if he started at all and his
  // appearances are within 25% of his starts (i.e. he isn't mostly relieving).
  const isStarterSeason = (season) =>
    (season.gamesStarted || 0) > 0 &&
    (season.gamesPlayed || season.gamesStarted) <= (season.gamesStarted || 0) * 1.25;

  // Season-long pitches per start. The prior season is discounted 0.95 —
  // a small downward nudge for age/role drift.
  const seasonPitchesPerStart =
    isStarterSeason(s26) && s26.numberOfPitches
      ? s26.numberOfPitches / s26.gamesStarted
      : isStarterSeason(s25) && s25.numberOfPitches
        ? (s25.numberOfPitches / s25.gamesStarted) * 0.95
        : null;

  // FIX(v35.2) — a reliever handed a start. With no start in this season's log
  // and a season that is not starter usage, the budget used to fall through to
  // last year's starter line or a flat 82 pitches, so an opener or bullpen-game
  // "starter" was projected like a five-inning starter (~14.8 outs). Measured in
  // the replay, those starts average 34-47 pitches and 5-8 outs (2026: 69 of
  // 2,765 starts; 2025: 116 of 4,370). His leash tracks his own relief
  // outings: `reliefBudget` = [base, per pitch] on his pitches per appearance.
  const reliefPitchesPerStart =
    T.reliefBudget && !gameLog.length && (s26.gamesPlayed || 0) > 0 &&
    !isStarterSeason(s26) && s26.numberOfPitches
      ? T.reliefBudget[0] + T.reliefBudget[1] * (s26.numberOfPitches / s26.gamesPlayed)
      : null;

  // Blend recent form (55%) with season baseline (45%); fall back to 82
  // pitches when neither is available. Clamped to a plausible MLB range —
  // `budgetFloor` is opener territory, 112 is a workhorse ceiling.
  let pitchBudget;
  if (recentPitchAvg != null && seasonPitchesPerStart != null) {
    pitchBudget = T.recentBudgetWeight * recentPitchAvg + (1 - T.recentBudgetWeight) * seasonPitchesPerStart;
  } else {
    pitchBudget = recentPitchAvg ?? reliefPitchesPerStart ?? seasonPitchesPerStart ?? 82;
  }
  // Home starters are left in slightly longer (see `homeBudget`).
  if (input.isHome != null) pitchBudget += input.isHome ? T.homeBudget : -T.homeBudget;
  pitchBudget = clamp(pitchBudget, T.budgetFloor, 112);

  // ---------------------------------------------------------------------
  // 4. Convert the pitch budget into innings.
  // ---------------------------------------------------------------------

  // Pitch economy, 2025 weighted 0.6 exactly as in shrunkRate. Requires >50
  // weighted BF before trusting it; clamped to 3.3-4.5 P/BF.
  const pitchesWeighted = (s26.numberOfPitches || 0) + 0.6 * (s25.numberOfPitches || 0);
  const bfWeighted = bf26 + 0.6 * bf25;
  const pitchesPerBF = bfWeighted > 50
    ? clamp(pitchesWeighted / bfWeighted, 3.3, 4.5)
    : lg.pitchesPerBF;

  // Out rate per batter faced: 1 - (hits + walks + HBP) + outs recorded on
  // batters who did reach (double plays, caught stealing).
  //
  // FIX(v22) — both constants were wrong, and both pushed the same way. Over
  // 2,674 starts in the backtest window:
  //
  //     HBP per BF          0.0110   model used 0.008
  //     extra outs per BF   0.0207   model used 0.045
  //
  // Together they overstated the out rate, which understated batters faced per
  // inning — 4.09 against an actual 4.25 — and `projBF` is the multiplier under
  // projH, projBB, projER and projK alike. It showed up most on hits allowed,
  // which under-projected 3.3-4.4% in both seasons tested.
  //
  // The inner on-base sum (0.20-0.50) and the resulting out rate (0.55-0.85)
  // are still clamped.
  const HBP_PER_BF = 0.011;
  const EXTRA_OUTS_PER_BF = 0.021;
  const outRatePerBF =
    1 - clamp(adjH + adjBB + HBP_PER_BF, 0.2, 0.5) + EXTRA_OUTS_PER_BF;

  // Batters faced per inning = 3 outs / out-rate.
  const bfPerInning = 3 / clamp(outRatePerBF, 0.55, 0.85);

  // Innings the pitch budget buys.
  const ipBudget = pitchBudget / (pitchesPerBF * bfPerInning);

  // Observed recent innings (same filtered outings), or the budget if we have
  // no usable log.
  const recentIp = fullOutings.length
    ? fullOutings.reduce((sum, g) => sum + g.ip, 0) / fullOutings.length
    : ipBudget;

  // 60% budget / 40% observed. Clamped 1.5-7.4 IP.
  const projIP = clamp((1 - T.recentIpWeight) * ipBudget + T.recentIpWeight * recentIp, 1.5, 7.4);

  const projBF = projIP * bfPerInning;
  const projPitches = projBF * pitchesPerBF;

  const strikePct = s26.strikePercentage
    ? clamp(parseFloat(s26.strikePercentage), 0.55, 0.72)
    : lg.strikePct;

  // ---------------------------------------------------------------------
  // 5. Counting-stat projections.
  // ---------------------------------------------------------------------
  const projK = projBF * adjK;

  // Outs recorded. Floored at 3 (one inning).
  //
  // FIX(v22) — this used to subtract a flat 0.6 outs, described as modelling
  // the partial inning a starter is pulled in. It was doing something else:
  // compensating for `bfPerInning` being ~4% too low, which inflated `ipBudget`
  // by the same amount. With the out-rate constants corrected above, that
  // inflation is gone and the subtraction became a pure downward bias —
  // `pitcher_outs` under-projected 3.9% with it still in place.
  //
  // The partial inning is modelled where it belongs, explicitly, in the
  // hook-hazard PMF below. Shading the mean for it as well was counting it
  // twice, so the old flat -0.6 is gone.
  //
  // RETUNED(v22.5) — a small -0.1 remains, fitted jointly with the two hazard
  // constants rather than assumed. Removing the subtraction outright made the
  // MEAN exact but pushed the 15.5-17.5 band to roughly +2.8pp too high, and
  // those lines are traded far more than 18.5. Refitting all three together on
  // 4,520 out-of-sample starts:
  //
  //     worst per-line gap   3.1pp -> 0.8pp
  //     sum of gaps          11.5pp -> 2.8pp
  //     Brier              0.2089 -> 0.2046
  //     mean bias          -0.01% -> -0.65%
  //
  // Two thirds of a percent of mean bias buys a four-fold improvement in tail
  // calibration, and the tails are what the edge engine actually consumes —
  // `evaluateEdge` never sees `projOuts`, only `dist.outs(line)`. The mean is
  // still well inside the noise band the backtest reports for this market.
  // RETUNED(v32) — -0.1 becomes +0.05, refitted jointly with the budget spread
  // below. Every outs line measured LOW (-1.0 to -2.7pp), which is a mean
  // deficit showing up in the tails rather than a shape problem on its own.
  const projOuts = Math.max(3, projIP * 3 + 0.05);

  const projH = projBF * adjH;
  const projBB = projBF * adjBB;
  const projHR = projBF * adjHR;

  const ip26 = parseInningsPitched(s26.inningsPitched);
  const ip25 = parseInningsPitched(s25.inningsPitched);

  // IP-weighted ERA blend, prior season again at 0.6, and FIP with the classic
  // 13/3/-2 weights and a 3.12 constant.
  //
  // FIX(v35) — both were used RAW, with no prior, while every other rate in
  // this model goes through shrinkage. A call-up with 20 IP and a 7.20 ERA got
  // projER 3.25 and P(ER > 2.5) 55.5%, against 44.8% for a league-average line
  // — a 10.6-point over lean on a pitcher who is not flagged SMALL SAMPLE (90 BF
  // clears the 80 BF bar). At 0.1 IP and a 54.00 ERA it projected 14.3 earned
  // runs. Both now carry ERA_PRIOR_IP innings of a league-average line. At a
  // full season's ~180 weighted innings that moves a projection by under 8% of
  // its distance from 4.20, so established starters are barely touched; it is
  // the thin samples it exists for.
  //
  // Also: an ERA string that is not a number ("-.--" at 0 IP) used to make
  // eraBlend NaN, and Math.max(0.2, NaN) is NaN, so projER, dist.er and the
  // Kelly stake all went NaN.
  const ERA_PRIOR = 4.2;
  const ERA_PRIOR_IP = 15;
  const eraOf = (season) => {
    const era = parseFloat(season.era);
    return Number.isFinite(era) ? era : ERA_PRIOR;
  };
  const weightedIp = ip26 + ip25 * 0.6;
  const eraBlend =
    (eraOf(s26) * ip26 + eraOf(s25) * ip25 * 0.6 + ERA_PRIOR * ERA_PRIOR_IP) /
    (weightedIp + ERA_PRIOR_IP);

  // FIP is defence-independent, so it pulls the ER projection toward "true
  // talent" and away from the batted-ball luck baked into ERA.
  const rawFip = weightedIp > 0
    ? (13 * ((s26.homeRuns || 0) + 0.6 * (s25.homeRuns || 0)) +
        3 * ((s26.baseOnBalls || 0) + 0.6 * (s25.baseOnBalls || 0)) -
        2 * ((s26.strikeOuts || 0) + 0.6 * (s25.strikeOuts || 0))) /
       weightedIp +
      3.12
    : ERA_PRIOR;
  const fip = (rawFip * weightedIp + ERA_PRIOR * ERA_PRIOR_IP) / (weightedIp + ERA_PRIOR_IP);

  // Bottom-up run estimate from this start's projected events: each non-HR hit
  // is worth 0.47 runs, each HR 1.4, each walk 0.33, then the whole thing is
  // scaled 0.92 (roughly the earned/total split plus sequencing damping).
  const runsFromEvents = ((projH - projHR) * 0.47 + projHR * 1.4 + projBB * 0.33) * 0.92;

  // Final ER = 40% bottom-up events, 30% FIP-scaled, 30% ERA-scaled, minus a
  // flat 0.25 (shading DOWN — unearned-run / sequencing haircut). Floored 0.2.
  const projER = Math.max(
    0.2,
    0.4 * runsFromEvents + 0.3 * ((fip * projIP) / 9) + 0.3 * ((eraBlend * projIP) / 9) - 0.25,
  );

  // ---------------------------------------------------------------------
  // 4b. Regression to the mean, per market.
  //
  //     FIX(v22.6) — the model discriminated between STARTERS far more than
  //     reality does. Regressing observed on projected across 4,520 (2025) and
  //     2,624 (2026) starts, the calibration slope came back well below 1 in
  //     every market and in both seasons:
  //
  //                             2025    2026
  //         earned runs         0.591   0.772
  //         outs                0.744   0.917
  //         hits allowed        0.749   0.872
  //         walks               0.710   0.804
  //         strikeouts          0.895   0.990
  //
  //     A slope of 0.75 means only three quarters of the spread the model puts
  //     between two pitchers is real; the rest is the projection over-reading
  //     its own inputs. It is invisible to a mean check — the population
  //     average is fine — and it is why `pitcher_outs` could show every line
  //     calibrated while being 5.8pp overconfident per pick.
  //
  //     It also explains the stubborn `pitcher_hits_allowed` bias, which three
  //     earlier fixes failed to shift: that market's error is a SLOPE, not a
  //     level. The bottom decile under-projected 20% while the top decile
  //     over-projected 5%, and those partly cancel into a mild-looking -1.8%
  //     mean.
  //
  //     The magnitudes are NOT stable season to season, so these are not the
  //     fitted slopes. Each is chosen to minimise the error in whichever season
  //     it does worse in, which lands closer to 1 (less shrinkage) than either
  //     year's own fit and cannot buy one season at the other's expense. Mean
  //     decile error, before -> after, on both seasons:
  //
  //         earned runs   8.22% -> 3.9/4.3%      hits allowed  5.53% -> 3.6/4.1%
  //         walks         6.11% -> 4.1/3.7%      outs          3.64% -> 2.7/2.7%
  //         strikeouts    3.37% -> 3.4/3.3%  (0.96: already near honest)
  //
  //     Anchors are the league-average starting line, so shrinking moves a
  //     projection toward a typical start without moving the slate's average.
  const shrinkToMean = (value, anchor, slope) => anchor + slope * (value - anchor);

  // LEVEL CALIBRATION (2026-08-23) — fitted on a lookahead-free replay of
  // THIS model (exact loadSlate wiring) over Aug 3-22 2026: fit Aug 3-15
  // (344 starts), holdout Aug 16-22 (190). Harness: /tmp/backtest2/run2.mjs.
  // Ship rule: directionally consistent in BOTH windows, |fit bias| >= ~3%,
  // and the fit-window factor must improve the holdout.
  //
  //   K    +3.2 / +7.4  -> K_LEVEL 0.969 (fit ratio). Holdout after: +4.0%.
  //        The K>4.5 reliability gap (+4.0/+5.5pp overconfident on the over)
  //        agrees with the mean bias, so this is a level error, not shape.
  //   BB   -2.9 / -6.9  -> BB_LEVEL 1.030. Holdout after: -4.1%.
  //   outs +1.5 / +2.9  -> left 1.0 (under threshold in the fit window).
  //   H    +5.1 / +0.4  -> left 1.0 (does not replicate: the fit factor
  //        would overshoot the holdout to -4.5%, worse than it started).
  //   ER   +7.5 / -3.7  -> left 1.0 (direction flips).
  //
  // Applied AFTER shrinkToMean so the factor reaches the displayed projection
  // and the distribution mean identically (dist.k re-derives its per-BF rate
  // from projKAdj; dist.bb reads projBBAdj directly).
  // RETIRED 2026-08-31. These were fitted on the Aug 3-22 replay, which graded
  // projections against OUTCOMES. That target does not correspond to money:
  // measured against real posted prices, the model already leaned UNDER the
  // market on strikeouts by -3.9 points on average, and K_LEVEL 0.969 cut
  // projections a further 3.1% in that same direction. Concretely it projects
  // Jacob deGrom at 4.87 K against his actual 6.36 per start. Two measurements
  // disagree — outcome-bias said trim, market-bias says the opposite — and
  // until the CLV test settles which one predicts profit, the honest setting is
  // the one that adds no untested adjustment at all.
  // Superseded 2026-09-16: see PITCHER_TUNING. The retirement note above was
  // right for the market evidence at the time; outcomes and prices now agree.
  const K_LEVEL = T.kLevel;
  const BB_LEVEL = T.bbLevel;

  const projOutsAdj = Math.max(3, shrinkToMean(projOuts, 15.5, 0.89) * T.outsLevel);
  const projHAdj = Math.max(0.2, shrinkToMean(projH, 4.88, 0.89) * T.hLevel);
  const projKAdj = Math.max(0.2, shrinkToMean(projK, 4.78, 0.96) * K_LEVEL);
  const projERAdj = Math.max(0.2, shrinkToMean(projER, 2.44, 0.78));
  const projBBAdj = Math.max(0.1, shrinkToMean(projBB, 1.72, 0.75) * BB_LEVEL);

  // Integer BF used as the binomial trial count for strikeouts.
  const bfTrials = Math.max(1, Math.round(projBF));

  // ---------------------------------------------------------------------
  // 5b. Outs recorded — a hook-hazard model.
  //
  //     FIX(v22). This market used to be `1 - normalCdf(line + 0.5, projOuts,
  //     3.8)`, and `tools/backtest.mjs` showed it was the worst-calibrated
  //     market in the app, on one of the highest market weights (0.50):
  //
  //         line 14.5   predicted 54.0%   observed 69.9%   -15.9pp
  //         line 17.5   predicted 28.0%   observed 37.8%    -9.8pp
  //         line 18.5   predicted 20.7%   observed 16.5%    +4.2pp
  //
  //     The MEAN was fine (-1.0%). The shape was not, for two reasons the
  //     normal cannot express, both visible in 2,624 real starts:
  //
  //       1. Outs are not smooth. 65.5% of starts end on an exact multiple of
  //          three, because managers decide between innings, not mid-batter.
  //          The empirical mass at 15 and 18 outs alone is 40.6%.
  //       2. The distribution is strongly LEFT-skewed (-0.89) with sd 4.53,
  //          not 3.8. A starter cruising gets to his pitch limit and stops; a
  //          starter getting hit is gone in the third. So the median sits
  //          ABOVE the mean, and a symmetric density puts far too much mass
  //          below 5 innings.
  //
  //     What replaces it is the actual generative process. After each
  //     completed inning the manager decides whether to send him back out,
  //     with a per-inning hazard
  //
  //         h(i) = h0 + (1 - h0) * logistic((pitches through i - budget) / s)
  //
  //     — a low constant chance of being knocked out early (`h0`), plus a
  //     rising chance as the pitch count approaches this pitcher's OWN budget.
  //     Recovered from the same 2,624 starts, the empirical hazard is 3-7% per
  //     inning through the third and then 18% / 46% / 69% / 85% for innings
  //     4-7, which is exactly that shape.
  //
  //     This also fixes something the normal got wrong structurally: `outsSd`
  //     was a single constant, so a 45-pitch opener and a 112-pitch workhorse
  //     were given identically-shaped distributions. Here the spread falls out
  //     of the pitcher's own budget and pace.
  //
  //     The mean stays pinned to `projOuts` (see `solveHookOffset`), so the
  //     projection printed on the card is still exactly the mean of the tail
  //     driving the verdict — the invariant v20 established.
  // ---------------------------------------------------------------------

  /**
   * Baseline per-inning chance of being pulled with the pitch budget still
   * untouched — the "he simply got hit" hazard, independent of workload.
   */
  const HOOK_BASE_HAZARD = T.hookBaseHazard;
  /**
   * Pitches of slack over which the hook probability swings from low to high.
   *
   * Small on purpose: managers do not ease a starter out, they run him to his
   * limit and then stop. At 8 pitches the hazard goes from ~15% to ~85% across
   * roughly one inning's work, which is what produces the sharp cliff the data
   * shows between 18 outs (21.3% of starts) and 19 (2.5%).
   *
   * Both constants were fitted to the 2,624 starts in the backtest window by
   * minimising the worst per-line calibration gap, not chosen by eye. The
   * fitted pair takes the worst per-line calibration gap on this market from
   * 15.9pp to 3.1pp and improves Brier at the same time. Re-fit with `tools/backtest.mjs` if the league's usage patterns
   * shift — bullpen games and the pitch clock both move this curve.
   */
  const HOOK_BUDGET_SCALE = T.hookBudgetScale;
  /**
   * Probability a start ends exactly ON the inning boundary, by how many full
   * innings the starter completed. Indexed 0-9.
   *
   * Pooled this is 65.5%, but pooling hides the shape and the shape matters.
   * Measured by completed innings:
   *
   *     innings   2   3   4   5   6   7   8
   *     boundary 47% 42% 48% 60% 82% 90% 93%
   *
   * The reason is the two different ways a start ends. A pitcher removed in the
   * fourth is being taken out mid-rally — that is a blow-up, and blow-ups do
   * not wait for the third out. A pitcher removed after the seventh is being
   * taken out because his day is done, and that decision is always made between
   * innings. So the deeper he goes, the more certain it is that he stops on a
   * multiple of three.
   *
   * Modelling this as one flat 65.5% left too much mass at 19 and 20 outs and
   * mispriced the 18.5 line by 5.7pp — a heavily traded line, since it is the
   * six-inning mark.
   */
  const BOUNDARY_BY_INNING = [0.60, 0.60, 0.47, 0.42, 0.48, 0.60, 0.82, 0.90, 0.93, 0.95];
  /**
   * When a start does NOT end on the boundary it ends one or two outs in,
   * split 47/53 — measured, and effectively flat across innings.
   */
  const ONE_OUT_SHARE = 0.475;

  const pitchesPerInning = bfPerInning * pitchesPerBF;

  /**
   * PMF over outs 0..27 for a given effective pitch budget.
   * `budget` is offset rather than `pitchBudget` itself so the mean can be
   * pinned to `projOuts` without disturbing the shape.
   */
  const outsPmfFor = (budget) => {
    const pmf = new Array(28).fill(0);
    let surviving = 1;
    for (let inning = 0; inning <= 9; inning++) {
      const thrown = inning * pitchesPerInning;
      const hazard =
        inning >= 9
          ? 1
          : HOOK_BASE_HAZARD +
            (1 - HOOK_BASE_HAZARD) / (1 + Math.exp(-(thrown - budget) / HOOK_BUDGET_SCALE));
      const stopHere = surviving * hazard;
      // Removed after `inning` complete innings, plus 0/1/2 outs of the next.
      const boundary = BOUNDARY_BY_INNING[inning] ?? 0.655;
      const partial = [boundary, (1 - boundary) * ONE_OUT_SHARE, (1 - boundary) * (1 - ONE_OUT_SHARE)];
      for (let extra = 0; extra < 3; extra++) {
        const outs = inning * 3 + extra;
        // A completed ninth is the whole game; there is no tenth inning to be
        // one out into.
        if (outs <= 27) pmf[outs] += stopHere * (inning >= 9 && extra > 0 ? 0 : partial[extra]);
      }
      surviving -= stopHere;
      if (surviving <= 1e-12) break;
    }
    const total = pmf.reduce((s, p) => s + p, 0);
    if (total > 0) for (let i = 0; i < pmf.length; i++) pmf[i] /= total;
    return pmf;
  };

  const pmfMean = (pmf) => pmf.reduce((s, p, i) => s + p * i, 0);

  /**
   * The pitch budget is not a point estimate.
   *
   * FIX(v32) — `outsPmfFor` took one budget and produced one hazard curve, as
   * though the manager's leash were known exactly. It is not: the same pitcher
   * on the same night goes seven if he is efficient and five if he is not, and
   * that variation is a property of the GAME, not of the season-long average
   * the budget is fitted to.
   *
   * Treating it as certain cost mass in the deep tail, which is where the
   * error showed. The model put 7.71% on exactly 21 outs (a completed seventh)
   * against an actual 9.18%, and 0.73% on 24 against 1.28% — while piling
   * 0.72pp too much onto 18. It hooked too many pitchers at six.
   *
   * `dist.k` has modelled batters-faced uncertainty with a three-point mixture
   * since the reconstruction; this is the same idea applied to the quantity
   * that actually drives depth. +/-6 pitches at quarter weight either side is
   * the spread fitted jointly with the mean offset above:
   *
   *     worst per-line gap   2.67pp -> 0.95pp
   *     sum of line gaps    11.50pp -> 4.45pp
   *     mean bias            -1.0%  -> -0.22%
   *     P(>18.5)            14.5%   -> 16.3%  (actual 17.0%)
   *
   * The mean is still pinned by the solve below, which now solves against the
   * MIXTURE, so the displayed projection and the distribution cannot disagree.
   */
  const BUDGET_SPREAD = T.budgetSpread;
  const BUDGET_MIX = [
    [-BUDGET_SPREAD, 0.25],
    [0, 0.5],
    [BUDGET_SPREAD, 0.25],
  ];

  const mixedPmfFor = (budget) => {
    const mixed = new Array(28).fill(0);
    for (const [delta, weight] of BUDGET_MIX) {
      const pmf = outsPmfFor(budget + delta);
      for (let k = 0; k < mixed.length; k++) mixed[k] += weight * pmf[k];
    }
    const total = mixed.reduce((a, b) => a + b, 0);
    return total > 0 ? mixed.map((p) => p / total) : mixed;
  };

  /**
   * Shift the effective budget until the PMF's mean equals `projOuts`, so the
   * distribution and the displayed projection cannot disagree. Monotone in the
   * offset, so plain bisection converges in a handful of steps.
   */
  const solveHookOffset = () => {
    let lo = -140;
    let hi = 140;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (pmfMean(mixedPmfFor(pitchBudget + mid)) < projOutsAdj) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };

  const outsPmf = mixedPmfFor(pitchBudget + solveHookOffset());

  // ---------------------------------------------------------------------
  // 6. Market tail distributions: each returns P(stat > line).
  // ---------------------------------------------------------------------
  const dist = {
    // Strikeouts: binomial in BF. Because BF itself is uncertain, this is a
    // 3-point equal-weight mixture over BF-3 / BF / BF+3, which fattens both
    // tails relative to a single binomial. The per-BF K probability is
    // re-derived from projK/bfTrials and re-clamped 0.02-0.60.
    k: (line) => {
      const p = clamp(projKAdj / bfTrials, 0.02, 0.6);
      const s = Math.round(T.bfSpread);
      return (
        binomTailOver(line, Math.max(1, bfTrials - s), p) +
        binomTailOver(line, bfTrials, p) +
        binomTailOver(line, bfTrials + s, p)
      ) / 3;
    },

    // Outs recorded: the hook-hazard PMF built in step 5b. Discrete, bounded
    // at 27, clustered on inning boundaries and left-skewed, with mean pinned
    // to `projOuts`.
    outs: (line) => {
      let cumulative = 0;
      for (let i = 0; i <= Math.floor(line) && i < outsPmf.length; i++) cumulative += outsPmf[i];
      return clamp(1 - cumulative, 0, 1);
    },

    // Hits allowed and walks: Poisson (variance = mean).
    hits: (line) => poissonTailOver(line, projHAdj),
    bb: (line) => poissonTailOver(line, projBBAdj),

    // Earned runs: negative binomial, overdispersed relative to Poisson to
    // model the blow-up start (crooked-number innings).
    //
    // FIX(v22) — the dispersion was k = 1.15, which at a typical projection of
    // 2.35 ER implies Var/mean = 1 + 2.35/1.15 = 3.04. Measured over 2,624
    // starts the real figure is 1.60, so the tail was roughly twice as fat as
    // reality and the model was pricing far too much mass into both ends:
    //
    //     line 1.5   predicted 49.6%   observed 61.0%   -11.4pp
    //     line 2.5   predicted 34.5%   observed 41.5%    -6.9pp
    //
    // 1.60 is the CONDITIONAL ratio, measured within buckets of the model's own
    // projection. That distinction matters here: pooled across all starts the
    // ratio reads 1.67, but part of that spread is real differences between
    // pitchers, which `projER` already captures. Only the within-pitcher
    // scatter belongs in the dispersion, or it gets counted twice.
    //
    //     k = mean / (Var/mean - 1) = 2.426 / 0.600 = 4.04
    er: (line) => negBinomTailOver(line, projERAdj, 4.0),
  };

  // ---------------------------------------------------------------------
  // 7. Warning flags (exact strings — consumed by the UI and by
  //    `attachLines`, which halves the market weight on "SMALL SAMPLE").
  // ---------------------------------------------------------------------
  const flags = [];
  const gamesStarted = s26.gamesStarted || 0;

  // Thin in BOTH seasons — note the `&&`: a pitcher with 90 BF this year is
  // never flagged regardless of last year.
  if (bf26 < 80 && bf25 < 200) flags.push('SMALL SAMPLE');

  // Under 62 projected pitches — likely to be pulled early.
  if (pitchBudget < 62) flags.push('SHORT LEASH');

  // Recent starts averaging under 3.4 IP — bulk guy or following an opener.
  if (fullOutings.length && recentIp < 3.4) flags.push('BULK/OPENER RISK');

  // Listed as a probable but has never started this season.
  if (gamesStarted === 0 && (s26.gamesPlayed || 0) > 0) flags.push('RELIEF ROLE?');

  return {
    rates: {
      kRate,
      bbRate,
      hRate,
      hrRate,
      adjK,
      adjBB,
      adjH,
      adjHR,
    },
    workload: {
      budget: pitchBudget,
      pPerBF: pitchesPerBF,
      bfPerIp: bfPerInning,
      ipBudget,
      recentIp,
    },
    projIP,
    projBF,
    projPitches,
    // Every returned projection is the SHRUNK one, so the number on the card
    // is exactly the mean of the distribution the edge engine prices from.
    projK: projKAdj,
    projOuts: projOutsAdj,
    projH: projHAdj,
    projBB: projBBAdj,
    projER: projERAdj,
    projHR,
    projStrikes: projPitches * strikePct,
    projBalls: projPitches * (1 - strikePct),
    fip,
    eraBlend,
    dist,
    flags,
  };
}

export { projectPitcher as projectPitcherV37 };
