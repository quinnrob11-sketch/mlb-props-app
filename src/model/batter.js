/**
 * Batter projection.
 *
 * Reconstructed from `/tmp/work/app.js` lines 362-502
 * (`Qp` -> PA_BY_LINEUP_SLOT, `Gp` -> weatherHrFactor, `Yp` -> projectBatter).
 *
 * The reconstruction was faithful; this file is the *repaired* version. The
 * defects fixed here are BATTER-ANALYSIS.md findings #1, #2, #3, #4, #6, #7,
 * #8 and #11. Every constant not named in those findings is preserved exactly
 * (the 0.975 haircuts, the three platoon forms, the RBI k=0.85 dispersion, the
 * hard-coded offensive priors and the frozen `lg.hRate`/`lg.hrRate` are all
 * still here, deliberately — see "Deliberately unchanged" at the bottom).
 *
 * FIXED (each marked FIX(n) at its site):
 *   1  Fractional PA. `Math.round(pa)` collapsed the lineup-slot PA table onto
 *      n = 4 for slots 2-8; every binomial market and the TB convolution now
 *      use a floor/ceil mixture whose mean is exactly `pa * p`.
 *   2  Runs / RBI / H+R+RBI now carry park, weather and opposing-starter
 *      context instead of being environment-blind.
 *   3  `dist.hrr` is now the convolution of the model's own hits, runs and RBI
 *      distributions, so its mean is exactly `projHRR` by construction.
 *   4  The stolen-base rate is shrunk like every other rate.
 *   5  Park (and, when the caller supplies it, the opponent-lineup term) is
 *      divided back out of `spRates` so park is applied exactly once.
 *   6  Non-HR hits are adjusted independently of HR, so an HR park factor no
 *      longer converts singles into home runs one-for-one.
 *   7  The `Math.max(0.03, hitPA - hrPA)` floor is gone; hit conservation is
 *      now an identity rather than an accident.
 *
 * FIXED in v22, from measurement rather than judgement. `tools/backtest.mjs`
 * replays historical slates out of the MLB Stats API with no lookahead and
 * compares every projection to the boxscore; both of these were invisible
 * before it existed and neither needed odds history to find:
 *
 *   8  The stolen-base prior was 0.04/game, the all-roster rate, applied to a
 *      population that is by definition starting. Measured 0.069. The market
 *      was under-projected 8.2%.
 *   9  `dist.hrr` assumed hits, runs and RBI are independent. They correlate
 *      at rho ~ 0.42-0.51, so the convolution carried half the true variance
 *      and mispriced the 0.5 line by 15.3pp. Mean is unchanged; only the
 *      spread is corrected.
 *
 * BATTER REFIT (2026-09-16) against tools/backtest-batters.mjs (posted lineups, Aug 10-Sep 15
 * 2026, fit/holdout split) — see BATTER_TUNING for every number:
 *
 *  R1  Plate appearances are a real distribution (team PA spread plus a chance
 *      the starter is lifted), not the floor/ceil pair, and hit probabilities
 *      carry a game-level spread. This is what hits@0.5 / TB@0.5 were
 *      over-reading, and calibration.js no longer patches it.
 *  R2  HR shrinkage 100 -> 300 PA; run/RBI levels, H+R+RBI shape and SB
 *      dispersion re-fitted.
 */

import {
  clamp,
  binomPmf,
  poissonPmf,
  poissonTailOver,
  negBinomPmf,
  negBinomTailOver,
} from '../lib/probability.js';
import { parkFactor } from '../lib/parks.js';
import { LEAGUE_AVG, shrunkRate } from './league.js';

/**
 * Expected plate appearances by lineup slot, 1-9.
 *
 * Leadoff gets ~4.51 PA and it decays ~0.12 per slot down to ~3.54 for the
 * nine-hole. Callers add +0.08 for the away team (the away side always bats
 * nine full innings; the home side skips the bottom of the 9th when leading)
 * and -0.08 for the home team.
 */
export const PA_BY_LINEUP_SLOT = [4.51, 4.36, 4.26, 4.14, 4.01, 3.88, 3.76, 3.66, 3.54];

/**
 * Temperature multiplier on home-run rate.
 *
 * Warm air is less dense, so batted balls carry: +0.6% HR per degree F above
 * 72, symmetric below. Clamped to 0.88-1.12, i.e. the effect saturates at
 * roughly 52F and 92F. Domes and missing forecasts return a flat 1.
 *
 * NOTE(recon): `wx` also carries `windMph` (collected in loadSlate from
 * open-meteo) but wind is never read here. Temperature is the only weather
 * input to the model. (BATTER-ANALYSIS.md #13 — out of scope, unchanged.)
 *
 * @param {{indoor?: boolean, tempF?: number, windMph?: number}} wx
 */
export function weatherHrFactor(wx) {
  if (!wx || wx.indoor || wx.tempF == null) return 1;
  return clamp(1 + 0.006 * (wx.tempF - 72), 0.88, 1.12);
}

/**
 * Fraction of the opposing starter's deviation from league average that is
 * passed through to the batter. Hits/HR (and, below, the derived run
 * environment) take an additional 0.8 because batted-ball outcomes are more
 * defence/luck driven than strikeouts — net 0.48.
 */
const PITCHER_INFLUENCE = 0.6;

/**
 * Run value of a non-HR hit and of a home run. These are NOT new tuning knobs:
 * they are the model's own linear weights, lifted verbatim from
 * `projectPitcher`'s `runsFromEvents` (model/pitcher.js), and are used here
 * only to turn the starter's hit/HR rates into a single run-environment ratio.
 */
const RUN_VALUE_NON_HR_HIT = 0.47;
const RUN_VALUE_HR = 1.4;

/**
 * Fraction of a *batter-level* multiplicative effect that reaches runs and
 * RBI. Already used by the model as the platoon pass-through for these two
 * markets (`platoon * 0.4 + 0.6`): runs and RBI depend as much on teammates as
 * on the batter, so an effect measured on the batter only partially survives.
 * Reused below to translate the HR-specific weather factor into a run effect.
 */
const RUN_CONTEXT_PASSTHROUGH = 0.4;

/**
 * How much wider the real H+R+RBI distribution is than the one you get by
 * convolving independent hits / runs / RBI marginals.
 *
 * MEASURED, not chosen. `tools/backtest.mjs` collects every boxscore in the
 * range and computes the covariance structure directly. Over 21,872
 * player-games:
 *
 *     Var(H) + Var(R) + Var(RBI)  =  1.866      <- the independence assumption
 *     Var(H + R + RBI)            =  3.633      <- reality
 *     ratio                       =  1.947
 *
 * The three legs are strongly positively correlated (rho ~ 0.42-0.51): a home
 * run is +1 to all three at once, and beyond that a batter's runs and RBI both
 * ride the same team-scoring night. Excluding games containing a home run the
 * ratio is still 1.64, so this is mostly shared game context rather than the
 * mechanical HR link.
 *
 * Critically, the ratio is STABLE where a fitted dispersion constant would not
 * be — across the nine lineup slots it moves only between 1.887 and 1.963, and
 * across 3/4/5-PA games between 1.76 and 1.82. That is what makes it safe to
 * carry as one number: it is a property of how baseball scoring works, not of
 * any particular hitter. The variance it is applied to is still the model's
 * own, so a quiet hitter in a pitchers' park gets a narrow distribution and a
 * middle-of-the-order bat in Coors gets a wide one.
 *
 * Why this matters: v20 replaced a fitted NB(k=2.2) with the independent
 * convolution because the convolution's MEAN is exactly `projHRR` by
 * construction. That fixed a real defect — the old tail's mean did not match
 * the projection printed beside it — but it also threw away half the variance,
 * and the backtest caught it:
 *
 *     line 0.5   predicted 83.1%  observed 67.8%   +15.3pp
 *     line 1.5   predicted 52.9%  observed 45.7%    +7.2pp
 *     line 2.5   predicted 26.6%  observed 29.4%    -2.8pp
 *     line 3.5   predicted 11.3%  observed 17.6%    -6.3pp
 *
 * — the exact signature of a distribution that is too narrow: too much mass in
 * the middle, not enough in either tail. On a market carrying MARKET_WEIGHT
 * 0.40 that is a standing fake OVER at 0.5/1.5 and a standing fake UNDER at
 * 2.5/3.5, every slate.
 *
 * Re-measure with:  node tools/backtest.mjs --from <start> --to <end>
 */
// SUPERSEDED by the 2026-09-16 refit: BATTER_TUNING.hrrVarianceInflation (1.8), refit against the
// wider hits leg. Kept for the measurement record above.
const HRR_VARIANCE_INFLATION = 1.947;

/**
 * Probability that a batter-game is a STRUCTURAL blank — no hit, no run, no
 * RBI — over and above what the fitted distribution already produces.
 *
 * WHY A VARIANCE FIX WAS NOT ENOUGH
 *
 * `HRR_VARIANCE_INFLATION` gave this market the right spread, and the mean has
 * been exactly right since v22. It was still 3.25 points too high at the 0.5
 * line in BOTH backtested seasons, and 0.5 is the only line Kalshi lists for it.
 *
 * `P(HRR > 0.5)` is just `1 - P(blank game)`, so that gap is entirely a
 * statement about the point mass at zero — and a point mass is not a variance
 * property. Widening a distribution spreads its shoulders; it does not add the
 * spike real batter-games have at nothing-at-all.
 *
 * HOW BIG THE EFFECT IS. Over 82,408 batter-games:
 *
 *     P(H=0)  0.4304    P(R=0)  0.6484    P(RBI=0)  0.7227
 *     independent product                   0.2017
 *     ACTUAL P(H=0 and R=0 and RBI=0)       0.3634     1.80x
 *
 * A blank game is 1.8 times commoner than independence implies. The three legs
 * do not fail separately — a hitter who goes 0-for-4 in a game his team loses
 * 2-0 misses all three at once, and that is one event, not three.
 *
 * THE MEAN IS PRESERVED BY CONSTRUCTION. Mixing a structural zero in at rate pi
 * would scale the mean by (1 - pi), so the NB's own mean is lifted to
 * `mean / (1 - pi)` and the mixture returns to exactly the projection. This
 * market's card number does not move; only its shape does.
 *
 * 0.0815 is solved, not chosen: it is the pi for which the mixture's P(0)
 * equals the 0.322 observed in the backtest population, at that population's
 * 1.82 mean and measured 2.09 variance-to-mean ratio.
 *
 * Re-measure with:  node tools/backtest.mjs --from <start> --to <end> --kind batter
 */
// SUPERSEDED by the 2026-09-16 refit: BATTER_TUNING.hrrStructuralZero (0.10).
const HRR_STRUCTURAL_ZERO = 0.0815;

/**
 * League-average stolen bases per game for a player in a starting lineup.
 *
 * MEASURED over the same 24,073 batter-games as above: 0.069. The model
 * previously shrank toward 0.04, which is roughly the rate across *all*
 * rostered players rather than the ones who actually start, and the backtest
 * showed the consequence — `batter_stolen_bases` under-projected by 8.2%,
 * the only batter market with a significant mean bias left after v20.
 *
 * The arithmetic lines up exactly: at a typical 100 games played and the
 * shrinkage strength of 30 below, the prior carries 30/(100+30) = 23% of the
 * estimate, so a prior 42% too low drags the projection ~9.7% low.
 *
 * `loadSlate` overrides this with the live slate-wide rate when it can; this
 * constant is the fallback.
 */
export const SB_PER_GAME_PRIOR = 0.069;

/**
 * The batter contact/power split, and the stolen-base scale.
 *
 * MEASURED, both seasons, same sign in each. The batter board was tilted in a
 * specific and repeatable shape — contact markets OVER, power UNDER:
 *
 *     market                 2025     2026     mean
 *     batter_singles        +0.8%    +1.6%    +1.2%   over
 *     batter_hits           +0.8%    +1.4%    +1.1%   over
 *     batter_runs_scored    +1.3%    +1.0%    +1.2%   over
 *     batter_total_bases    +0.6%    +0.6%    +0.6%   over
 *     batter_home_runs      -1.6%    -2.8%    -2.2%   UNDER
 *     batter_stolen_bases   +3.3%    +3.1%    +3.2%   over
 *
 * Contact over and power under is not a level error, it is a MISALLOCATION —
 * the same shape as the pitcher K/contact split in model/pitcher.js. Balls that
 * should have been leaving the yard were being counted as singles, which is why
 * singles is the worst of the contact markets and home runs is the only one
 * pointing the other way.
 *
 * Some of this is mine. v22.1 removed a flat 0.975 haircut from the non-HR hit
 * rate on the grounds that nothing justified it, which took hits from -1.5% to
 * +0.7%. That was the right direction and too far. v22.8 then raised the
 * starter hit rate that `spHit` divides by, pushing the whole batter side up
 * again — flagged at the time, and this is the correction.
 *
 * The measured answer is neither the original 0.975 nor the 1.0 that replaced
 * it. These two constants are ONE correction and must move together: they shift
 * a little over a point of plate-appearance outcome from contact back to power,
 * leaving the total hit rate almost unchanged.
 *
 * Re-measure with:  node tools/backtest.mjs --from <start> --to <end> --kind batter
 */
const CONTACT_SHARE = 0.989;
const POWER_SHARE = 1.022;

/**
 * LEVEL CALIBRATION (2026-08-23) — fitted on a lookahead-free replay of THIS
 * model (v32 lineage, exact loadSlate wiring: as-of-date summed game logs,
 * actual posted lineups, live lg, opposing starter's raw talent rates) over
 * Aug 3-22 2026: fit window Aug 3-15 (3,085 batter-games), holdout Aug 16-22
 * (1,707). Harness: /tmp/backtest2/run2b.mjs; rows2b.json.
 *
 * A factor ships only when the bias is directionally consistent in BOTH
 * windows, |fit bias| >= ~3%, and applying the fit-window factor improves the
 * holdout. Measured bias% (proj/actual - 1), fit / holdout:
 *
 *   HR   +5.8 / +9.9  -> HR_LEVEL  0.945 (fit ratio). Holdout after: +3.9%.
 *   R    +7.2 / +6.3  -> R_LEVEL   0.933.             Holdout after: -0.8%.
 *   RBI  +3.8 / +3.5  -> RBI_LEVEL 0.963.             Holdout after: -0.3%.
 *   TB   +4.3 / +5.0  -> no own factor: TB is derived (1B+2·2B+3·3B+4·HR),
 *        and HR_LEVEL alone takes the holdout to ~+3.0%. A separate TB scale
 *        would break the identity with the hit-type decomposition.
 *   H    +3.0 / +1.7  -> left 1.0 (fit at threshold, holdout marginal; the
 *        HR_LEVEL cut already lowers total hitPA slightly).
 *   HRR  +4.3 / +3.3  -> no own factor: sum of the three legs above.
 *   K    +0.3 / -0.5, PA +0.3 / -0.0 -> clean.
 *   SB   +1.3 / +30.7 -> left 1.0 (fit-window signal absent; the holdout
 *        number is small-n noise on a rare event).
 *
 * HR_LEVEL multiplies the HR rate (inside the clamp, beside POWER_SHARE) so
 * it propagates coherently to projHR, projTB, the TB pmf, dist.hr and the
 * H+R+RBI legs. R_LEVEL / RBI_LEVEL multiply the run/RBI means, which feed
 * dist.runs / dist.rbi / dist.hrr directly.
 */
const HR_LEVEL = 0.945;
// R_LEVEL / RBI_LEVEL SUPERSEDED by the 2026-09-16 refit: BATTER_TUNING.runLevel 0.95 / rbiLevel 0.98.
const R_LEVEL = 0.933;
const RBI_LEVEL = 0.963;

/**
 * Stolen bases run ~3.2% high in both seasons. Unlike the split above this is a
 * plain level error, so it gets a plain scale rather than being folded into the
 * contact/power pair — the two have nothing to do with each other.
 */
const SB_SCALE = 0.969;

/**
 * BATTER_TUNING — every calibration setting the batter model reads, in one
 * place, so `tools/tune-batters.mjs` can search them without editing the model.
 * Pass `input.tuning` to `projectBatter` to override any of them.
 *
 * BATTER REFIT (2026-09-16) on a lookahead-free replay, tools/backtest-batters.mjs:
 * every posted-lineup starter in every final game Aug 10-Sep 15 2026 (494
 * games, 8,892 batter-games), each hitter's season line summed from his game
 * log before the game date, the opposing starter's raw rates from the real
 * `projectPitcher` on his as-of line, and loadSlate's as-of league object.
 * Settings were chosen on Aug 10-31 (5,274) by log loss and kept ONLY if they
 * also improved log loss on Sep 1-15 (3,618), which the search never saw.
 *
 * Holdout Sep 1-15, before -> after (bias is actual vs projected; dispersion
 * is squared error over the model's own variance, >1 = model too narrow):
 *
 *               bias           dispersion      log loss          Brier
 *   hits      +0.7 -> +0.7%   1.106 -> 1.037  1.1999 -> 1.1944  .1502 -> .1501
 *   TB        +2.1 -> +2.2%   1.082 -> 1.038  1.6297 -> 1.6279  .1639 -> .1638
 *   HR        +7.6 -> +8.1%   1.054 -> 1.047  0.3894 -> 0.3890  .0561 -> .0560
 *   RBI       +8.2 -> +6.3%   1.051 -> 1.026  0.9149 -> 0.9146  .1144 -> .1143
 *   H+R+RBI   +4.9 -> +3.9%   0.974 -> 0.990  1.8190 -> 1.8177  .1818 -> .1817
 *   runs      +9.7 -> +7.7%   1.013 -> 0.994  0.9057 -> 0.9050  .1580 -> .1578
 *   K         -1.7 -> -1.7%   1.004 -> 0.976  1.1470 -> 1.1470  .1426 -> .1426
 *   singles   +0.3 -> +0.2%   1.097 -> 1.054  0.9860 -> 0.9838  .1709 -> .1707
 *   SB        -2.9 -> -2.9%   0.903 -> 0.934  0.2335 -> 0.2331  .0573 -> .0573
 *
 *   hits@0.5 (= TB@0.5)  62.2 -> 61.0 predicted vs 60.8 observed
 *   hits@2.5              3.9 ->  4.6            vs  5.1
 *   HRR@1.5 / @2.5       44.0 / 27.2 -> 44.9 / 27.8   vs 46.7 / 30.8
 *
 * WHAT WAS WRONG. Per-PA rates were right (hits 0.997, K 0.990, HR 1.013 of
 * projected per actual PA over the whole replay); the distributions around
 * them were too narrow. Real plate appearances spread far wider than the
 * floor/ceil pair (section 9), and hits in a game are more clustered than
 * independent PAs, so every count market put too much mass in the middle —
 * the standing hits@0.5 / TB@0.5 over-read that calibration.js was patching.
 *
 * The remaining holdout level gaps on runs/RBI/HR are the environment, not the
 * model: league R/G was 4.36 in the fit window and 4.76 in the holdout (HR/PA
 * .0288 vs .0321). No as-of input can see that coming, and a level fitted to
 * the fit window (hrLevel 0.91) made the holdout WORSE, so it was rejected.
 *
 * Rejected because the holdout got worse: hrLevel 0.945 -> 0.91 (HR+TB log
 * loss 2.0169 -> 2.0178), rbiK 0.85 -> 0.70 (0.9146 -> 0.9156), sbScale
 * 0.969 -> 0.90 (0.2331 -> 0.2332). kRateSpread and contactShare: the fit
 * window kept the current values.
 *
 * Re-measure with:
 *   node tools/backtest-batters.mjs --from <start> --to <end> --split <date> --cache DIR
 *   node tools/tune-batters.mjs     --from <start> --to <end> --split <date> --cache DIR
 */
export const BATTER_TUNING = {
  contactShare: CONTACT_SHARE,
  powerShare: POWER_SHARE,
  hrLevel: HR_LEVEL,
  /**
   * Was R_LEVEL 0.933 / RBI_LEVEL 0.963 (Aug 3-22 replay). Fit window now reads
   * runs +1.6% / RBI +1.1% under-projected at those values. Holdout log loss:
   * runs 0.9057 -> 0.9050, RBI 0.9149 -> 0.9146. Small, and in the direction of
   * the season-average run environment (4.49 R/G through Aug 9).
   */
  runLevel: 0.95,
  rbiLevel: 0.98,
  sbScale: SB_SCALE,
  /**
   * Shrinkage strength (PA) of the home-run rate toward its 0.03 prior. Was
   * 100: projected-HR slope on actual was 0.81 (fit) / 0.87 (holdout), i.e.
   * the model believed hitters' HR differences more than they held up. 300 was
   * best of 60-600 on fit; holdout HR+TB log loss 2.0180 -> 2.0169.
   */
  hrPriorStrength: 300,
  /** NB dispersion of RBI (k) and of stolen bases. */
  rbiK: 0.85,
  /**
   * Was 1 (geometric). SB outcomes were narrower than modelled (dispersion
   * 0.89 fit / 0.90 holdout). Holdout log loss 0.2335 -> 0.2331.
   */
  sbK: 1.5,
  /**
   * Was 1.947 / 0.0815 (measured on 2025-26 boxscores against the OLD
   * two-point hits leg). The hits leg is now wider on its own (section 9 and
   * rateSpread), so less of the H+R+RBI spread has to come from the inflation.
   * Refit jointly on the fit window with every other setting in place; holdout
   * log loss 1.8192 -> 1.8177, @0.5 66.9 -> 67.5 vs 67.7 observed.
   */
  hrrVarianceInflation: 1.8,
  hrrStructuralZero: 0.1,
  /**
   * Plate-appearance distribution (section 9): SD of the team's plate
   * appearances per game (0 = the old floor/ceil two-point mixture), and the
   * probability the starter is lifted and loses a trip.
   *
   * Team PA SD measures 4.64 away / 4.45 home; fitting on the observed batter
   * PA counts chose 5.5 with a 10% loss rate — the extra width stands in for
   * extra innings and multi-PA removals the one-trip loss does not cover.
   * PA log loss, holdout: 4.2489 (two-point) -> 1.1651; the per-slot
   * empirical pmf, the practical floor, scores 1.1547. Hits+TB+singles+HR log
   * loss, holdout: 4.2050 -> 4.1990.
   */
  teamPaSd: 5.5,
  paLossRate: 0.1,
  /**
   * Game-level spread of the per-PA hit probabilities (all four hit types
   * scaled together by 1-d / 1 / 1+d, weights 1/4, 1/2, 1/4). Mean-preserving.
   * It stands in for what makes a hitter's PAs in one game move together
   * (same starter, same bullpen, same park and air). With the PA fix in place
   * hits were still too narrow (dispersion 1.08 holdout); 0.30 was best of
   * 0-0.60 on fit. Hits+TB+singles+HR log loss, holdout: 4.1990 -> 4.1964.
   * `kRateSpread` is the same thing for strikeouts; the fit kept it at 0
   * (strikeouts were already at dispersion ~1.0).
   */
  rateSpread: 0.3,
  kRateSpread: 0,
};

/**
 * Expected runs allowed per batter faced implied by a starter's hit and HR
 * rates, in the model's own linear weights.
 */
function runProxy(hitRate, hrRate) {
  return RUN_VALUE_NON_HR_HIT * (hitRate - hrRate) + RUN_VALUE_HR * hrRate;
}

/**
 * Recover the opposing starter's *talent* rates from whatever the caller
 * supplied, with park (and the opponent-lineup term when available) removed.
 *
 * FIX(5) — park was being counted twice. `projectPitcher` returns
 * `adjK`/`adjH`/`adjHR` that have ALREADY been multiplied by this same park's
 * factor (`parkFactor(park,'so',0.5)`, `'hits'`/`'hr'` at 0.7) and, for K and
 * hits, by an opponent-lineup term computed against *this batter's own team*.
 * The batter then applied park a second time, giving ~1.48x the intended park
 * strength on hits/HR and ~1.60x on strikeouts, and folding the batter's own
 * team's aggregate K rate back into his individual strikeout projection
 * (BATTER-ANALYSIS.md #6 and #7).
 *
 * Resolution order, best first:
 *   1. `spRates.kRate/hRate/hrRate` — the raw shrunk talent rates
 *      `projectPitcher` already returns alongside the adjusted ones. These
 *      contain neither park nor the opponent term, so nothing is double
 *      counted. Callers should prefer passing these.
 *   2. `adjK/adjH/adjHR` with the park factor divided back out, and the
 *      opponent-lineup term divided out too when the caller passes the same
 *      `opp` aggregate it gave `projectPitcher` (as `spRates.opp`).
 *
 * Under (2) without `spRates.opp` the park de-duplication is exact but the
 * circular own-team term survives — `data/loadSlate.js` currently forwards only
 * the three `adj*` values, so removing the remaining circularity needs a
 * one-line change at that call site (pass `kRate`/`hRate`/`hrRate`, or `opp`).
 *
 * @returns {{k: number, h: number, hr: number}|null}
 */
function starterTalentRates(spRates, park, lg) {
  if (!spRates) return null;

  // Opponent-lineup damping coefficients, mirroring projectPitcher exactly.
  const opp = spRates.opp || null;
  const oppKTerm = opp?.kRate != null ? 1 + 0.4 * (opp.kRate / lg.kRate - 1) : 1;
  const oppHTerm = opp?.avg != null ? 1 + 0.35 * (opp.avg / lg.avg - 1) : 1;

  const deParked = (adj, key, weight, term) =>
    adj == null ? null : adj / (parkFactor(park, key, weight) * term);

  const k = spRates.kRate ?? deParked(spRates.adjK, 'so', 0.5, oppKTerm);
  const h = spRates.hRate ?? deParked(spRates.adjH, 'hits', 0.7, oppHTerm);
  const hr = spRates.hrRate ?? deParked(spRates.adjHR, 'hr', 0.7, 1);

  // Re-clamp to projectPitcher's own adjusted-rate bounds: dividing a clamped
  // value by a park factor can push it a hair outside the model's range.
  // Missing rates fall back to the STARTING-PITCHER baseline, so an unknown
  // starter is a neutral one (multiplier exactly 1.0) rather than a
  // league-wide average that no starter actually posts.
  return {
    k: k == null ? lg.spKRate : clamp(k, 0.05, 0.45),
    h: h == null ? lg.spHRate : clamp(h, 0.12, 0.34),
    hr: hr == null ? lg.spHrRate : clamp(hr, 0.005, 0.07),
  };
}

/**
 * Convolve two probability mass functions given as dense arrays indexed by
 * count. Used to build the H+R+RBI distribution out of its own components.
 */
function convolvePmf(a, b) {
  const out = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) {
    if (!a[i]) continue;
    for (let j = 0; j < b.length; j++) {
      if (b[j]) out[i + j] += a[i] * b[j];
    }
  }
  return out;
}

/**
 * Truncate a count distribution at the point where the residual mass can no
 * longer move the mean by more than ~1e-9, so the resulting vector's mean
 * matches the analytic mean to well inside the 1e-6 the tests assert.
 */
function densePmf(pmfAt, mean, hardCap = 512) {
  const pmf = [];
  let cumulative = 0;
  for (let k = 0; k <= hardCap; k++) {
    const p = pmfAt(k);
    pmf.push(p);
    cumulative += p;
    if (k >= mean && (1 - cumulative) * (k + 1) < 1e-11) break;
  }
  return pmf;
}

/** P(X > line) from a dense pmf, matching the *TailOver convention. */
function tailFromPmf(pmf, line) {
  let cumulative = 0;
  for (let i = 0; i <= Math.floor(line); i++) cumulative += pmf[i] || 0;
  return clamp(1 - cumulative, 0, 1);
}

/**
 * Project a batter's line and the per-market tail distributions.
 *
 * @param {object} input
 * @param {object} input.season26    current-season hitting split
 * @param {object} input.season25    prior-season hitting split
 * @param {number} input.slot        1-9 lineup position (anything else => estimate)
 * @param {boolean} input.isAway     away team bats a guaranteed 9 innings
 * @param {string} input.batSide     "L" | "R" | "S"
 * @param {string} input.pitcherHand "L" | "R" — opposing starter
 * @param {object} input.spRates     opposing starter's rates. Either the raw
 *                                   talent rates {kRate, hRate, hrRate} from
 *                                   `projectPitcher` (preferred), or the
 *                                   adjusted {adjK, adjH, adjHR} — optionally
 *                                   with the `opp` team aggregate that was fed
 *                                   to `projectPitcher`, so both the park and
 *                                   the opponent term can be divided back out.
 * @param {string} input.park        venue name
 * @param {object} input.lg          league overrides merged onto LEAGUE_AVG
 * @param {object} input.wx          weather {indoor, tempF, windMph}
 */
export function projectBatter(input) {
  const {
    season26,
    season25,
    slot,
    isAway,
    batSide,
    pitcherHand,
    spRates,
    park,
    wx,
  } = input;

  const T = { ...BATTER_TUNING, ...(input.tuning || {}) };
  const lg = { ...LEAGUE_AVG, ...(input.lg || {}) };
  const s26 = season26 || {};
  const s25 = season25 || {};

  const pa26 = s26.plateAppearances || 0;
  const pa25 = s25.plateAppearances || 0;

  // ---------------------------------------------------------------------
  // 1. Plate appearances.
  //    Known slot -> table lookup + home/away tweak. Unknown slot -> the
  //    player's own PA/game if he has >10 games (clamped 3.3-4.7), else 4.
  // ---------------------------------------------------------------------
  let pa;
  if (slot >= 1 && slot <= 9) {
    pa = PA_BY_LINEUP_SLOT[slot - 1] + (isAway ? 0.08 : -0.08);
  } else {
    const games = s26.gamesPlayed || 0;
    pa = games > 10 ? clamp(pa26 / games, 3.3, 4.7) : 4;
  }

  // Singles are not reported directly: H - 2B - 3B - HR.
  const singles26 = (s26.hits || 0) - (s26.doubles || 0) - (s26.triples || 0) - (s26.homeRuns || 0);
  const singles25 = (s25.hits || 0) - (s25.doubles || 0) - (s25.triples || 0) - (s25.homeRuns || 0);

  // ---------------------------------------------------------------------
  // 2. Shrunk per-PA rates.
  //
  //    Prior strengths scale with event noise: contact events regress lightly
  //    (60), doubles harder (80), HR harder still (100) and triples hardest
  //    (120) since a triple is close to a coin-flip artifact of park + speed.
  //
  //    NOTE(recon): hit/single/double/triple/hr/run/rbi use HARD-CODED priors
  //    (0.222, 0.14, 0.043, 0.004, 0.03, 0.12, 0.115) while k/bb read from the
  //    (possibly live-overridden) `lg`. Supplying a custom `lg` therefore
  //    moves only the K and BB priors. Preserved as-is (analysis #9).
  // ---------------------------------------------------------------------
  const rates = {
    hit:    shrunkRate(s26.hits,        pa26, s25.hits,        pa25, 0.222, 60),
    single: shrunkRate(singles26,       pa26, singles25,       pa25, 0.14,  60),
    double: shrunkRate(s26.doubles,     pa26, s25.doubles,     pa25, 0.043, 80),
    triple: shrunkRate(s26.triples,     pa26, s25.triples,     pa25, 0.004, 120),
    hr:     shrunkRate(s26.homeRuns,    pa26, s25.homeRuns,    pa25, 0.03,  T.hrPriorStrength),
    run:    shrunkRate(s26.runs,        pa26, s25.runs,        pa25, 0.12,  60),
    rbi:    shrunkRate(s26.rbi,         pa26, s25.rbi,         pa25, 0.115, 60),
    k:      shrunkRate(s26.strikeOuts,  pa26, s25.strikeOuts,  pa25, lg.kRate,  60),
    bb:     shrunkRate(s26.baseOnBalls, pa26, s25.baseOnBalls, pa25, lg.bbRate, 60),
  };

  // Stolen bases PER GAME (not per PA).
  //
  // FIX(4) — this was the one rate in the whole model that skipped shrinkage:
  // above 20 weighted games it was the raw observed ratio (21 G / 7 SB priced a
  // part-timer at 0.333 SB/game and a 25% chance to steal), below it a flat
  // 0.04 for everyone including catchers. It now goes through `shrunkRate` like
  // every other rate, in games rather than PA:
  //   - strength 30 games. `shrunkRate`'s strength is in denominator units, so
  //     30 games is ~126 PA — the same neighbourhood as the 100-120 PA used for
  //     the model's other rare events (HR 100, triples 120). The >20-game cliff
  //     disappears: playing time now moves the estimate continuously.
  //
  // FIX(8) — the PRIOR was wrong. v20 kept the model's pre-existing 0.04
  // default so the zero-playing-time answer would not move, but 0.04 is the
  // rate across all rostered players, and everyone this function projects is in
  // a starting lineup. Measured over 24,073 batter-games the right figure is
  // 0.069 (see SB_PER_GAME_PRIOR), and the 0.04 prior was dragging the whole
  // market 8.2% low — the last significant mean bias on the batter board.
  // FIX(v31) — scaled by SB_SCALE, which corrects a measured ~3.2% over-projection
  // present in both backtested seasons. Applied to the shrunk rate rather than
  // to the prior, so it corrects every hitter and not only the low-sample ones.
  const sbPerGame =
    shrunkRate(
      s26.stolenBases, s26.gamesPlayed,
      s25.stolenBases, s25.gamesPlayed,
      lg.sbPerGame ?? SB_PER_GAME_PRIOR, 30,
    ) * T.sbScale;

  // ---------------------------------------------------------------------
  // 3. Platoon multiplier.
  //
  //    1.05 with the platoon advantage (opposite hands), 0.95 without,
  //    1.02 for switch hitters (who always have the advantage but give some
  //    back for the weaker side being a trained-up one). 1.00 when either
  //    hand is unknown.
  //
  //    NOTE(recon): switch hitters get 1.02 > 1, so they ALWAYS receive the
  //    "PLATOON+" flag. Unchanged (analysis #4.3).
  // ---------------------------------------------------------------------
  let platoon = 1;
  if (batSide && pitcherHand) {
    if (batSide === 'S') platoon = 1.02;
    else if (batSide !== pitcherHand) platoon = 1.05;
    else platoon = 0.95;
  }

  // ---------------------------------------------------------------------
  // 4. Opposing-starter quality — from de-duplicated talent rates, see
  //    `starterTalentRates`. Direction: a high-K starter pushes the batter's K
  //    rate UP; a hit-suppressing starter pushes hit rate DOWN; a homer-prone
  //    starter pushes HR rate UP; a run-suppressing starter pushes runs/RBI
  //    DOWN.
  // ---------------------------------------------------------------------
  const sp = starterTalentRates(spRates, park, lg);

  let spK = 1;
  let spHit = 1;
  let spHr = 1;
  let spRunEnv = 1;
  if (sp) {
    // FIX(v22) — the denominators are the STARTING-PITCHER baselines, not the
    // league-wide ones. `sp.k/h/hr` are a starter's rates, so dividing by a
    // league-wide rate that includes relievers means an average starter does
    // not come out at 1.0, and every batter on the slate gets pushed the same
    // direction. Relievers strike out more and allow fewer hits, so the old
    // denominators made every starter look hit-prone and strikeout-poor.
    // See the measured split in model/league.js.
    spK = 1 + PITCHER_INFLUENCE * (sp.k / lg.spKRate - 1);
    spHit = 1 + PITCHER_INFLUENCE * 0.8 * (sp.h / lg.spHRate - 1);
    spHr = 1 + PITCHER_INFLUENCE * 0.8 * (sp.hr / lg.spHrRate - 1);

    // FIX(2a) — run environment created by the starter. The ratio is built
    // from the same two legs (hits, HR) at the model's own run values, and is
    // damped by the same net 0.48 those two legs already use: runs are a
    // batted-ball outcome, and passing the signal through at the bare 0.6
    // would make runs MORE pitcher-sensitive than the hits they are made of.
    spRunEnv =
      1 +
      PITCHER_INFLUENCE * 0.8 *
        (runProxy(sp.h, sp.hr) / runProxy(lg.spHRate, lg.spHrRate) - 1);
  }

  // ---------------------------------------------------------------------
  // 5. Park + weather multipliers.
  //    Hits and HR use the standard 0.7 park weight; strikeouts use the
  //    half-weight 0.5 (same convention as projectPitcher).
  // ---------------------------------------------------------------------
  const parkHits = parkFactor(park, 'hits', 0.7);
  const parkHrWeather = parkFactor(park, 'hr', 0.7) * weatherHrFactor(wx);
  const parkSo = parkFactor(park, 'so', 0.5);

  // FIX(2b) — the run environment runs/RBI/HRR were missing entirely.
  //
  //   park:    `parkFactor(park, 'runs', 0.7)`, the same 0.7 convention hits
  //            and HR already use. The `runs` column is a runs measurement, so
  //            it applies at full strength for this market.
  //   weather: `weatherHrFactor` is an HR-specific measurement being reused for
  //            a different market, so it is passed through at the model's
  //            existing runs/RBI pass-through of 0.4 (the same 0.4 as in
  //            `platoon * 0.4 + 0.6`). A 95F day is then +4.8% runs rather than
  //            the full +12% HR bump — the right order of magnitude for the HR
  //            share of scoring.
  //   pitcher: `spRunEnv` above.
  //
  // Bounds are inherited, not clamped: parkRuns lies in [0.958, 1.084],
  // runWeather in [0.952, 1.048] and spRunEnv in [0.74, 1.33] because the
  // starter's rates are themselves clamped.
  const parkRuns = parkFactor(park, 'runs', 0.7);
  const runWeather = 1 + RUN_CONTEXT_PASSTHROUGH * (weatherHrFactor(wx) - 1);
  const runContext = spRunEnv * parkRuns * runWeather;

  // ---------------------------------------------------------------------
  // 6. Adjusted per-PA probabilities.
  //
  //    FIX(6)/FIX(7) — HR and non-HR hits are now adjusted INDEPENDENTLY.
  //
  //    Before: `hitPA` was adjusted as a whole and non-HR hits were the
  //    leftover `Math.max(0.03, hitPA - hrPA)`. Because HR carries its own park
  //    column and the weather factor while `hits` does not, any HR boost
  //    subtracted itself out of the singles projection one-for-one — at Great
  //    American (hr 112, hits 100) `proj1B` fell 3.5% for no physical reason —
  //    and the 0.03 floor fabricated hits outright for low-average/high-power
  //    profiles (up to +12.8% phantom hits, and `projTB` inherited it).
  //
  //    Now the non-HR hit rate is its own quantity carrying the hits stack, HR
  //    carries the HR stack, and `hitPA` is their sum. The decomposition is an
  //    identity, no floor is needed, and an HR park adds offence instead of
  //    reshuffling it.
  // ---------------------------------------------------------------------

  // HR rate: the platoon term is AMPLIFIED. `(platoon - 1) * 1.8 + 1` turns
  // 1.05 into 1.09 and 0.95 into 0.91 — home-run rate is roughly twice as
  // platoon-sensitive as batting average. The `platoon === 1 ? 1 : ...` guard
  // keeps an unknown matchup at exactly 1 (algebraically identical, but
  // preserved verbatim).
  //
  // FIX(v31) — the CONTACT/POWER SPLIT. See the constants below.
  const hrPARaw = clamp(
    rates.hr * (platoon === 1 ? 1 : (platoon - 1) * 1.8 + 1) * spHr * parkHrWeather *
      T.powerShare * T.hrLevel,
    0.002, 0.1,
  );

  // Non-HR hit rate: platoon x starter x park. `rates.hit - rates.hr` is
  // strictly positive (HR are a subset of hits, and the hit prior contributes
  // 13.32 synthetic hits against the HR prior's 3.0), so nothing has to be
  // floored.
  //
  // FIX(v22) — the flat 0.975 haircut that used to sit on the end is gone.
  // Nothing ever justified it: it was applied here and to RBI and to no other
  // market, and no comment in the original bundle explained what it calibrated
  // for. The backtest showed it as a standing one-directional shade, exactly
  // the size of the constant — `batter_hits` came back 1.5% low and
  // `batter_singles` 2.1% low over 41,689 batter-games, and singles took it
  // worst because they are the largest share of non-HR hits.
  //
  // Note the RBI leg keeps its own 0.975 (see `projRBI`), because RBI measured
  // clean without any correction. The two haircuts were never one decision.
  //
  // FIX(v31) — `CONTACT_SHARE` corrects the over-projection that removing the
  // haircut left behind. Removing 0.975 outright was too much: it took hits
  // from -1.5% to +0.7% and the batter side has drifted further up since,
  // partly because v22.8 raised the starter hit rate that `spHit` reads. The
  // measured answer is neither 0.975 nor 1.0.
  const nonHrHitPARaw = Math.max(
    0,
    (rates.hit - rates.hr) * platoon * spHit * parkHits * T.contactShare,
  );

  // The [0.05, 0.42] clamp still applies to the TOTAL hit rate, as before. When
  // it binds, both legs are rescaled proportionally so the decomposition stays
  // exact instead of one leg absorbing the whole correction.
  const hitPAUnclamped = nonHrHitPARaw + hrPARaw;
  const hitPA = clamp(hitPAUnclamped, 0.05, 0.42);
  const clampScale = hitPAUnclamped > 0 ? hitPA / hitPAUnclamped : 1;
  const hrPA = hrPARaw * clampScale;
  const nonHrHitPA = nonHrHitPARaw * clampScale;

  // K rate: platoon INVERTS via `2 - platoon` (1.05 -> 0.95, 0.95 -> 1.05).
  // A batter with the platoon advantage strikes out less. Note this is an
  // additive reflection, not the multiplicative inverse 1/platoon.
  const kPA = clamp(rates.k * (2 - platoon) * spK * parkSo, 0.05, 0.45);

  // ---------------------------------------------------------------------
  // 7. Hit-type decomposition.
  //
  //    The 1B/2B/3B split still uses the RAW shrunk rates' shares — no park, no
  //    weather, no pitcher, no platoon (PARK_FACTORS has no doubles column, so
  //    this remains a data limitation; analysis #3.2). All three shares share
  //    one denominator, so they sum to 1 and
  //    1B + 2B + 3B + HR === hitPA identically.
  // ---------------------------------------------------------------------
  const hitTypeTotal = Math.max(0.001, rates.single + rates.double + rates.triple);
  const singleShare = rates.single / hitTypeTotal;

  const singlePA = nonHrHitPA * singleShare;
  const doublePA = nonHrHitPA * (rates.double / hitTypeTotal);
  // Triples are the residual. The old `Math.max(5e-4, ...)` floor is gone with
  // the 0.03 one: the triple share is strictly positive (the 0.004 prior can
  // never shrink to zero), so the branch is nonzero without fabricating a
  // triple, and the residual form keeps conservation exact in floating point.
  const triplePA = Math.max(0, nonHrHitPA - singlePA - doublePA);

  // ---------------------------------------------------------------------
  // 8. Counting-stat projections (all use FRACTIONAL pa).
  // ---------------------------------------------------------------------
  const projH = pa * hitPA;
  const projHR = pa * hrPA;
  const projTB = pa * (singlePA + 2 * doublePA + 3 * triplePA + 4 * hrPA);

  // Runs and RBI: shrunk rate x PA x a DAMPED platoon term
  // (`platoon * 0.4 + 0.6` passes through only 40% of the platoon edge because
  // runs/RBI depend as much on teammates as on the batter) x the run context
  // from step 5. RBI keeps the same unexplained 0.975 haircut as hits.
  const projR = pa * rates.run * (platoon * 0.4 + 0.6) * runContext * T.runLevel;
  const projRBI = pa * rates.rbi * (platoon * 0.4 + 0.6) * runContext * 0.975 * T.rbiLevel;

  // H+R+RBI is a plain sum of the three means (correct in expectation: a solo
  // HR contributes 1 + 1 + 1 = 3).
  const projHRR = projH + projR + projRBI;

  const projK = pa * kPA;
  const projSB = sbPerGame;   // per game, NOT scaled by PA
  const proj1B = pa * singlePA;

  // ---------------------------------------------------------------------
  // 9. Fractional plate appearances.
  //
  //    FIX(1) — `paTrials = Math.max(1, Math.round(pa))` used to feed every
  //    binomial market and the TB convolution. PA_BY_LINEUP_SLOT spans
  //    4.59 -> 3.46 once the home/away tweak is applied, so rounding collapsed
  //    slots 2-8 onto n = 4 (seven lineup slots returning the identical tail),
  //    handed the away leadoff man a 5th PA (+8.9% vs his own projection) and
  //    took one off the home nine-hole (-13.3%) — 3-5pp of fake edge every day
  //    in a direction fixed by lineup slot, and the displayed `proj*` (computed
  //    from fractional `pa`) disagreed with the tail that drove the verdict.
  //
  //    A batter cannot take 4.59 plate appearances; he takes 4 or 5. So the
  //    distribution is the two-point mixture over floor(pa) and ceil(pa)
  //    weighted by the fractional part, which is both the honest model of the
  //    lineup turning over and exactly mean-preserving:
  //
  //      E[X] = (1-f)*n_lo*p + f*(n_lo+1)*p = (n_lo + f)*p = pa*p
  //
  //    so every `proj*` above is precisely the mean of the tail below.
  // ---------------------------------------------------------------------
  //
  //    2026-09-16 REFIT — THE TWO-POINT MIXTURE WAS FAR TOO NARROW. tools/backtest-batters.mjs
  //    replayed 8,892 posted-lineup starter-games (Aug 10-Sep 15 2026): the
  //    table's per-slot MEAN is right to ~0.06 PA, but the real SD is 0.65-0.87
  //    PA against the mixture's <= 0.5, and 2-PA and 6-PA games — which the
  //    mixture gives probability zero — are 1-14% of games depending on slot.
  //
  //    The replacement models where plate appearances actually come from:
  //      - the TEAM sends T batters to the plate, T ~ normal(mu, teamPaSd)
  //        discretised; slot s then bats floor((T - s) / 9) + 1 times. The
  //        spread is MEASURED, not fitted: team PA per game had SD 4.64 (away)
  //        and 4.45 (home) over the same 494 games.
  //      - with probability `paLossRate` the starter is lifted (pinch hitter,
  //        injury, blowout rest) and loses one of those trips.
  //    mu is solved per call so that E[n] is exactly `pa`, keeping every
  //    `proj*` equal to its distribution's mean. `teamPaSd: 0` restores the
  //    old two-point mixture exactly.
  //
  //    PA log loss on the observed counts, fit Aug 10-31 / holdout Sep 1-15:
  //      two-point mixture          3.7049 / 4.2489
  //      this model (4.5, 0.15)     1.1120 / 1.1811
  //      per-slot empirical pmf     1.0689 (in-sample) / 1.1547   <- floor
  // ---------------------------------------------------------------------
  const paDist = (() => {
    const sd = T.teamPaSd;
    const loss = T.paLossRate;
    if (!(sd > 0)) {
      // Old two-point mixture.
      const lo = Math.max(0, Math.floor(pa));
      const f = pa - lo;
      return f > 0 ? [[lo, 1 - f], [lo + 1, f]] : [[lo, 1]];
    }
    // Unknown slot: price him as a mid-order bat around his own PA mean.
    const s = slot >= 1 && slot <= 9 ? slot : 5;
    const trips = (mu) => {
      const w = new Map();
      let total = 0;
      const lo = Math.floor(mu - 4 * sd);
      const hi = Math.ceil(mu + 4 * sd);
      for (let t = Math.max(0, lo); t <= hi; t++) {
        const wt = Math.exp(-0.5 * ((t - mu) / sd) ** 2);
        const n = Math.max(0, Math.floor((t - s) / 9) + 1);
        w.set(n, (w.get(n) || 0) + wt);
        total += wt;
      }
      // Lifted starter: one trip fewer.
      const out = new Map();
      for (const [n, wt] of w) {
        const p = wt / total;
        out.set(n, (out.get(n) || 0) + p * (1 - loss));
        const m = Math.max(0, n - 1);
        out.set(m, (out.get(m) || 0) + p * loss);
      }
      return out;
    };
    const meanOf = (d) => {
      let m = 0;
      for (const [n, p] of d) m += n * p;
      return m;
    };
    // E[n] is increasing in mu; bisect for the lineup-slot mean.
    let lo = 0;
    let hi = 9 * (pa + 2) + s;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (meanOf(trips(mid)) < pa) lo = mid;
      else hi = mid;
    }
    return [...trips((lo + hi) / 2)].filter(([, p]) => p > 1e-12).sort((a, b) => a[0] - b[0]);
  })();
  const paMax = paDist[paDist.length - 1][0];

  // Game-level spread of the per-PA probabilities (see BATTER_TUNING). Three
  // equally spaced multipliers with weights 1/4, 1/2, 1/4: mean exactly 1, so
  // every count mean is untouched; only the game-to-game variance grows.
  const spreadMix = (d) => (d > 0 ? [[1 - d, 0.25], [1, 0.5], [1 + d, 0.25]] : [[1, 1]]);
  const rateMix = spreadMix(T.rateSpread);
  const kMix = spreadMix(T.kRateSpread);

  /** Dense pmf of a binomial count mixed over the PA and rate distributions. */
  const countPmf = (p, mix) => {
    const out = new Array(paMax + 1).fill(0);
    for (const [n, wn] of paDist) {
      for (const [m, wm] of mix) {
        const q = clamp(p * m, 0, 1);
        if (!(q > 0)) {
          out[0] += wn * wm;
          continue;
        }
        if (q >= 1) {
          out[n] += wn * wm;
          continue;
        }
        for (let k = 0; k <= n; k++) out[k] += wn * wm * binomPmf(k, n, q);
      }
    }
    return out;
  };
  const hitsPmf = countPmf(hitPA, rateMix);
  const hrPmf = countPmf(hrPA, rateMix);
  const singlesPmf = countPmf(singlePA, rateMix);
  const kPmf = countPmf(kPA, kMix);

  // ---------------------------------------------------------------------
  // 10. Total-bases PMF by exact multinomial convolution.
  //
  //     Each PA is one draw from {out, 1B, 2B, 3B, HR} with base values
  //     {0,1,2,3,4}; convolving n independent draws gives the exact TB
  //     distribution. The PMF is captured at every PA count the section-9
  //     distribution weights (and each rate-spread multiplier), then mixed —
  //     the same treatment as the binomial markets, so E[TB] is exactly `projTB`.
  //
  //     `outProb` is the leftover mass, floored at 0 — if the four hit
  //     probabilities ever sum above 1 the PMF silently sums above 1 too.
  // ---------------------------------------------------------------------
  const tbPmf = (() => {
    const mixed = new Array(4 * paMax + 1).fill(0);
    const weightOf = new Map(paDist);
    for (const [m, wm] of rateMix) {
      const outcomeProbs = [singlePA * m, doublePA * m, triplePA * m, hrPA * m];
      const outProb = Math.max(0, 1 - outcomeProbs.reduce((sum, p) => sum + p, 0));

      const step = (pmf) => {
        const next = new Array(pmf.length + 4).fill(0);
        for (let tb = 0; tb < pmf.length; tb++) {
          if (pmf[tb]) {
            next[tb]     += pmf[tb] * outProb;          // out: +0 bases
            next[tb + 1] += pmf[tb] * outcomeProbs[0];  // single: +1
            next[tb + 2] += pmf[tb] * outcomeProbs[1];  // double: +2
            next[tb + 3] += pmf[tb] * outcomeProbs[2];  // triple: +3
            next[tb + 4] += pmf[tb] * outcomeProbs[3];  // homer:  +4
          }
        }
        return next;
      };

      // Walk the PA count up once, capturing the pmf at every n the PA
      // distribution puts weight on.
      let pmf = [1];
      for (let n = 0; n <= paMax; n++) {
        if (n > 0) pmf = step(pmf);
        const wn = weightOf.get(n);
        if (!wn) continue;
        for (let i = 0; i < pmf.length; i++) mixed[i] += wn * wm * pmf[i];
      }
    }
    return mixed;
  })();

  // ---------------------------------------------------------------------
  // 11. H+R+RBI: the model's own mean, with the real correlation restored.
  //
  //     FIX(3) — v20. `projHRR` is `projH + projR + projRBI`, but the shipped
  //     distribution was a fitted NB(k=2.2) whose mean did not match it, so the
  //     app could recommend both sides of the same hitter. v20 replaced it with
  //     the convolution of the model's own hits / runs / RBI marginals, whose
  //     mean is exactly `projHRR` by construction.
  //
  //     FIX(9) — that convolution assumed the three legs are INDEPENDENT, and
  //     they are emphatically not: rho ~ 0.42-0.51 pairwise (a home run is +1
  //     to all three simultaneously, and runs and RBI both ride the same team's
  //     scoring that night). The convolution therefore carried barely half the
  //     true variance, and `tools/backtest.mjs` measured the damage on 24,073
  //     batter-games — +15.3pp at the 0.5 line, -6.3pp at 3.5.
  //
  //     The repair keeps everything v20 got right and fixes only the variance:
  //
  //       mean      exactly `projHRR`, as before — still the sum of the three
  //                 components the card displays, so the self-consistency that
  //                 motivated FIX(3) is untouched;
  //       variance  the model's OWN component variances, summed as before and
  //                 then scaled by the measured `HRR_VARIANCE_INFLATION`.
  //
  //     Matching those two moments to a negative binomial gives the tail. NB is
  //     the natural family here and is already what the model uses for RBI, SB
  //     and pitcher ER; at these means it is also very close to what the
  //     inflated convolution would look like, without needing a latent-variable
  //     mixture the rest of the model has no vocabulary for.
  //
  //     Note this is NOT a return to the old hand-fitted k=2.2. The dispersion
  //     is derived per hitter from his own projected components; only the
  //     correlation correction is a shared constant, and that constant was
  //     measured rather than chosen.
  // ---------------------------------------------------------------------

  // Variance of the hits leg, read straight off its pmf (under the old
  // two-point PA mixture this equals pa*p*(1-p) + p^2 * (E[n^2] - pa^2)).
  const hitsVar = (() => {
    let m = 0;
    let m2 = 0;
    hitsPmf.forEach((p, k) => {
      m += p * k;
      m2 += p * k * k;
    });
    return m2 - m * m;
  })();
  // Poisson: variance = mean. NB(mu, k): variance = mu + mu^2 / k.
  const runsVar = projR;
  const rbiVar = projRBI + (projRBI * projRBI) / T.rbiK;

  const hrrMean = projHRR;
  const hrrVar = T.hrrVarianceInflation * (hitsVar + runsVar + rbiVar);

  const hrrTail = (() => {
    // A negative binomial needs variance strictly above the mean. For any
    // realistic hitter the inflated variance clears it comfortably (the
    // measured var/mean for this market is 2.09), but a hitter projected at
    // almost nothing could in principle not, so fall back to the exact
    // independent convolution rather than producing a degenerate k.
    if (!(hrrVar > hrrMean * 1.02) || !(hrrMean > 0)) {
      const runsPmf = densePmf((k) => poissonPmf(k, projR), projR);
      const rbiPmf = densePmf((k) => negBinomPmf(k, projRBI, T.rbiK), projRBI);
      const pmf = convolvePmf(convolvePmf(hitsPmf, runsPmf), rbiPmf);
      return (line) => tailFromPmf(pmf, line);
    }
    // ZERO-INFLATION. See HRR_STRUCTURAL_ZERO for the measurement.
    //
    // The negative binomial below has the right mean and the right variance and
    // STILL puts too little mass on a blank game, because a point mass at zero
    // is not a variance property — widening a distribution does not add the
    // spike that real batter-games have at nothing-at-all.
    //
    // Mixing in a structural zero with probability pi would drag the mean down
    // by a factor of (1 - pi), so the NB's own mean is lifted to
    // `hrrMean / (1 - pi)` to compensate. The mixture mean is then
    // (1 - pi) * hrrMean / (1 - pi) = hrrMean exactly, preserving the property
    // that every distribution's mean equals the projection printed beside it.
    // Dispersion is recomputed at the lifted mean so the variance relation is
    // the one that was measured, not one inherited from the old mean.
    const pi = T.hrrStructuralZero;
    const liftedMean = hrrMean / (1 - pi);
    const liftedVar = (hrrVar / hrrMean) * liftedMean;
    if (!(liftedVar > liftedMean * 1.02)) {
      const k = (hrrMean * hrrMean) / (hrrVar - hrrMean);
      return (line) => negBinomTailOver(line, hrrMean, k);
    }
    const k = (liftedMean * liftedMean) / (liftedVar - liftedMean);
    return (line) => {
      // P(X > line). The structural zero contributes nothing above any line at
      // or beyond 0, so the mixture tail is simply the NB tail scaled by
      // (1 - pi) for every line >= 0.
      const nbTail = negBinomTailOver(line, liftedMean, k);
      if (nbTail == null || isNaN(nbTail)) return nbTail;
      return line < 0 ? nbTail : (1 - pi) * nbTail;
    };
  })();

  // ---------------------------------------------------------------------
  // 12. Market tail distributions: each returns P(stat > line).
  //
  //     Families: binomial (mixed over the PA distribution) for hits / HR / singles /
  //     K; exact multinomial for TB; Poisson for runs; NB for RBI (k=0.85) and
  //     SB (k=1, geometric); and the convolution above for H+R+RBI. Every one
  //     of them now has mean exactly equal to the `proj*` displayed next to it.
  // ---------------------------------------------------------------------
  const dist = {
    hits:    (line) => tailFromPmf(hitsPmf, line),
    hr:      (line) => tailFromPmf(hrPmf, line),
    singles: (line) => tailFromPmf(singlesPmf, line),
    k:       (line) => tailFromPmf(kPmf, line),

    // Exact multinomial tail from the convolved PMF.
    tb: (line) => tailFromPmf(tbPmf, line),

    runs: (line) => poissonTailOver(line, projR),
    rbi:  (line) => negBinomTailOver(line, projRBI, T.rbiK),
    hrr:  hrrTail,
    sb:   (line) => negBinomTailOver(line, Math.max(0.01, projSB), T.sbK),
  };

  // ---------------------------------------------------------------------
  // 13. Flags (exact strings; note PLATOON− uses U+2212 MINUS SIGN, not a
  //     hyphen — the UI filters on these literals).
  // ---------------------------------------------------------------------
  const flags = [];
  if (pa26 < 100 && pa25 < 250) flags.push('SMALL SAMPLE');
  if (platoon > 1) flags.push('PLATOON+');
  if (platoon < 1) flags.push('PLATOON−');

  return {
    pa,
    /** [[plate appearances, probability], ...] behind every count market. */
    paDist,
    rates: {
      hitPA,
      hrPA,
      kPA,
      singlePA,
      doublePA,
      triplePA,
    },
    projH,
    projHR,
    projTB,
    projR,
    projRBI,
    projHRR,
    projK,
    projSB,
    proj1B,
    dist,
    flags,
    platoon,
  };
}

/*
 * Deliberately unchanged:
 *
 *   #5  RBI NB(k=0.85) vs runs Poisson. This was previously left alone because
 *       retuning it would have been judgement; it is now left alone because the
 *       backtest says it is RIGHT. Over 24,073 batter-games the two markets
 *       genuinely do have different shapes — runs came back var/mean 0.985
 *       (Poisson, as modelled) and RBI 1.586 (overdispersed, implying k ~ 0.78
 *       against the shipped 0.85). Calibration confirms it: runs 0.5 is off by
 *       0.3pp and RBI 0.5 by 0.6pp. The "6.8pp standing UNDER lean on RBI"
 *       reported in BATTER-ANALYSIS.md §2b was an argument from symmetry, and
 *       the data does not support it. Runs and RBI are not interchangeable:
 *       scoring a run needs teammates behind you, driving one needs runners in
 *       front, and only the latter arrives in clusters.
 *   #9  `lg` overrides reach only kRate/bbRate; `lg.hRate`/`lg.hrRate` are
 *       frozen constants that `loadSlate` never computes.
 *   #10 The 0.975 haircut on hits and RBI only.
 *   #12 `SMALL SAMPLE` uses `&&`; there is no zero-2026-data flag.
 *   #13 `windMph` is collected and never read; `weatherHrFactor` and
 *       `projectNrfi` use two different temperature models.
 *   #14 No cross-market correlation; `pa` is a point estimate for the mean
 *       (the mixture models which integer it lands on, not season variance).
 *   #15 `rates.bb` is computed and never consumed.
 */
