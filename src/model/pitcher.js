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
  from '../lib/probability.js';
import { parkFactor } from '../lib/parks.js';
import { LEAGUE_AVG, shrunkRate } from './league.js';

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
 */
export function projectPitcher(input) {
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

  const adjK = clamp(
    kRate * (1 + 0.4 * (oppK / lg.kRate - 1)) * parkFactor(park, 'so', 0.5) * K_CONTACT_SPLIT * plK,
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
  const recent = gameLog.slice(-5);

  // Median pitch count over the last five starts, used only as a yardstick.
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

  // Blend recent form (55%) with season baseline (45%); fall back to 82
  // pitches when neither is available. Clamped to a plausible MLB range —
  // 45 is opener territory, 112 is a workhorse ceiling.
  let pitchBudget;
  if (recentPitchAvg != null && seasonPitchesPerStart != null) {
    pitchBudget = 0.55 * recentPitchAvg + 0.45 * seasonPitchesPerStart;
  } else {
    pitchBudget = recentPitchAvg ?? seasonPitchesPerStart ?? 82;
  }
  pitchBudget = clamp(pitchBudget, 45, 112);

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
  const projIP = clamp(0.6 * ipBudget + 0.4 * recentIp, 1.5, 7.4);

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

  // IP-weighted ERA blend, prior season again at 0.6. Note the numerator
  // weights 2025 by `ip25 * 0.6` while the denominator uses `ip25 * 0.6` too,
  // so this is a consistent weighted mean. Default 4.20 with no innings.
  const eraBlend = ip26 + ip25 > 0
    ? (parseFloat(s26.era || 0) * ip26 + parseFloat(s25.era || 0) * ip25 * 0.6) /
      (ip26 + ip25 * 0.6)
    : 4.2;

  // FIP with the classic 13/3/-2 weights and a 3.12 constant. Defence-
  // independent, so it pulls the ER projection toward "true talent" and away
  // from the batted-ball luck baked into ERA.
  const fip = ip26 + ip25 > 0
    ? (13 * ((s26.homeRuns || 0) + 0.6 * (s25.homeRuns || 0)) +
        3 * ((s26.baseOnBalls || 0) + 0.6 * (s25.baseOnBalls || 0)) -
        2 * ((s26.strikeOuts || 0) + 0.6 * (s25.strikeOuts || 0))) /
       (ip26 + 0.6 * ip25) +
      3.12
    : 4.2;

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
  const K_LEVEL = 0.969;
  const BB_LEVEL = 1.030;

  const projOutsAdj = Math.max(3, shrinkToMean(projOuts, 15.5, 0.89));
  const projHAdj = Math.max(0.2, shrinkToMean(projH, 4.88, 0.89));
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
  const HOOK_BASE_HAZARD = 0.005;
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
  const HOOK_BUDGET_SCALE = 10;
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
  const BUDGET_SPREAD = 6;
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
      return (
        binomTailOver(line, Math.max(1, bfTrials - 3), p) +
        binomTailOver(line, bfTrials, p) +
        binomTailOver(line, bfTrials + 3, p)
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
