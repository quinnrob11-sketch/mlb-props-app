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
 *     worse on Aug 16-31. Left at 0.95; strikeouts now run ~1.5% low.
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
   * v37 retired the two market-fitted trims: `kLevel` 0.95 -> 1.0 and `hLevel`
   * 0.97 -> 1.0, on `docs/ACCURACY.md`'s measurement that they cost 2.6 and
   * 2.0 points of calibration against outcomes over two seasons. This branch
   * keeps both at 1.0 and does not touch them again. They are the baseline
   * every number in docs/PITCHER-PORT.md is measured against.
   *
   * `kLevel` is now also INERT: `PITCHER_FIT.cal.k` carries its own level,
   * fitted against outcomes, and supersedes it. The constant still matters on
   * the fallback path a caller reaches with `fit: { cal: null }`, which is why
   * it is 1.0 rather than deleted. `hLevel` is NOT inert — hits allowed keeps
   * v36's anchor and slope deliberately (see `PITCHER_FIT.cal`), so its level
   * is still this constant, and 1.0 is what the audit measured as right.
   *
   * `outsLevel` stays at 0.98, as v37 left it, for the reason the audit gave:
   * removing it re-centres the level and leaves a SHAPE error a level cannot
   * reach. That error is fixed where it actually lives, in `budgetSpread`
   * below — and with that fixed, `PITCHER_FIT.cal.outs` supersedes this
   * constant too.
   */
  kLevel: 1.0,
  bbLevel: 1.0,
  outsLevel: 0.98,
  hLevel: 1.0,
  /** Batters-faced spread of the three-point strikeout mixture. */
  bfSpread: 5,
  /**
   * Pitch-budget spread of the three-point outs mixture.
   *
   * REFIT(v36.2, 18 -> 12). `docs/ACCURACY.md` measured the outs distribution
   * as too wide at BOTH ends over 9,019 starts — 11.5 outs quoted at 83.7%
   * against 86.6% observed, 20.5 at 16.0% against 11.2% — and said in terms
   * that this is a shape error a level factor cannot reach. It is this
   * constant. Swept on the fit window by calibration error over the full outs
   * ladder, with the rest of the port in place (990 fit-tail starts, and the
   * 7,422 before them in brackets):
   *
   *     spread    10     12     14     16     18
   *     ECE     1.06   0.76   0.78   1.08   1.51
   *            (0.56) (0.73) (1.24) (1.85) (2.50)
   *     log loss 0.4856 0.4844 0.4837 0.4835 0.4838
   *
   * 12 is the only value near the minimum on both windows. Log loss is flat
   * across the whole range (0.002) and mildly prefers 16, which is what a
   * proper score does when a distribution is a little wide in the tails and
   * right in the middle; the calibration curve is the thing that was wrong and
   * it is unambiguous. Measured the same way, the outs ladder's calibration
   * error goes 3.49 -> 0.73 on the larger window.
   */
  budgetSpread: 12,
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
  /**
   * The three ported terms of v36.2, each switchable. Setting any of them to
   * false restores the v36 behaviour of that term exactly, which is what
   * `test/pitcher.test.js` pins and what `tools/pitcher-port.mjs` measures each
   * one's contribution with. They are switches, not tuning: nothing here was
   * chosen by trying both.
   */
  /**
   * Decayed two-season rates from `input.rateLog` (needs that input).
   *
   * OFF, and measured. This is the study's headline rate change — two seasons
   * under a fitted 400-day decay with a fitted offseason gap, pooled at 150 /
   * 80 / 1,200 batters faced instead of a flat 70 — and ported into this
   * pipeline it is worth **nothing**. On the 990 fit-tail starts the
   * coefficients never saw, with it and without it:
   *
   *                    strikeouts  outs    hits    walks   ER     total ll
   *     with decay       0.1548   0.1661  0.1848  0.1568  0.1820  0.50875
   *     without          0.1549   0.1662  0.1845  0.1568  0.1821  0.50873
   *
   * The reason is visible in the sweep that chose the strengths: asked for the
   * best pooling strength for strikeouts in THIS structure, the fit window
   * answers 70 — `shrunkRate`'s own default. v36's two assumed constants, the
   * 0.6 on last season and the 70 batters faced of prior, turn out to be about
   * where the data wants them for a projection built this way. What made the
   * study's version of this term pay was the rest of its rate model, not the
   * decay.
   *
   * It is kept, fitted and tested rather than deleted, because it is the only
   * term here that would cost `loadSlate` a new input (the pitcher's prior
   * season game log), and the next person to propose that fetch should be able
   * to read what it was worth. Turning it on needs `input.rateLog`; without
   * that input it is inert whatever this says.
   */
  rateDecay: false,
  /** Recency-weighted workload from the dated game log (needs those dates). */
  workDecay: true,
  /** Strikeouts binomial in the batters the outs PMF implies. */
  depthK: true,
};

/**
 * The terms ported from `docs/PITCHER-EDGE-SEARCH.md`, and the constants they
 * were fitted with. Full reproduction, and what each one was worth on the
 * holdout, in `docs/PITCHER-PORT.md`.
 *
 * Every value here was fitted on the study's FIT split — 2025 plus 2026 through
 * **2026-08-09** — and nothing was chosen on the validation or holdout windows.
 * The five hyperparameters at the top are the study's own, re-fitted from
 * scratch here (`node tools/pitcher-edge.mjs --stage fit`) and reproduced to
 * the value: 400-day decay on the rates, 20 on depth, a 60-day offseason, and
 * pooling at 150 / 80 / 1,200 / 200 batters faced. The coefficients below them
 * are fitted against THESE inputs rather than lifted from the study's own
 * design matrix (`tools/pitcher-port-fit.mjs`), because the board's opponent
 * numbers are not the study's: `avg` is per at-bat where the study's was per
 * plate appearance, and a coefficient does not survive a change of denominator.
 *
 * Three things the study measured are deliberately NOT here:
 *
 *   - **The home-plate umpire.** 0.00001 of log loss in the ablation, with the
 *     wrong sign on its coefficient. That is zero, and it would cost a fetch.
 *   - **Temperature.** It measured WORSE than nothing for pitchers — removing
 *     it improved the fit-tail score. `projectPitcher` never had a temperature
 *     term, so there was nothing to delete; it does not gain one. (Temperature
 *     earns its place in `projectBatter`'s `weatherHrFactor` and in the game
 *     model, which is where it stays.)
 *   - **Lineup handedness as a composition term.** Worth 0.0001, all of it in
 *     walks, and `loadSlate` already applies a stronger per-pitcher platoon
 *     adjustment from his own splits (`model/platoon.js`) against a posted
 *     card. A blanket composition coefficient on top would count it twice.
 */
export const PITCHER_FIT = {
  /** Decay constant in days for the per-BF rates (half-life 277 days). */
  tauRate: 400,
  /** Decay constant in days for workload depth (half-life 14 days). */
  tauWork: 20,
  /**
   * Effective length of the offseason gap, in days. The real gap between the
   * last 2025 start and the first 2026 one is 179; fitted, it is worth 60, so
   * a September 2025 start is not treated as half a year stale.
   */
  offDays: 60,
  /**
   * Partial-pooling strength per rate, in batters faced. The ordering is the
   * finding, not the numbers: a starter's strikeout rate is worth something
   * after a couple of hundred batters and his HIT rate essentially never is,
   * which is why hits allowed regresses almost the whole way to the starter
   * league average. The shipped model pooled all four at 70 (HR at 120).
   */
  sK: 150,
  sBB: 80,
  sH: 1200,
  sHR: 200,
  /**
   * Opponent exponents, fitted. Each adjusted rate is multiplied by
   * `(oppK/lgK)^a * (oppBB/lgBB)^b * (oppAvg/lgAvg)^c`, which is the same shape
   * as the shipped `1 + damping * (ratio - 1)` to first order — with the
   * damping measured rather than assumed, and with the cross-terms the shipped
   * model set to zero.
   *
   * The headline is `k.k`: the shipped model passed 40% of the opponent's
   * deviation in strikeout rate through to the pitcher, and the fit says the
   * pass-through is close to whole. Against a lineup striking out 10% more
   * than league average that is the difference between +4% and +11% on his
   * projected strikeout rate.
   *
   * ONLY strikeouts take a fitted exponent. The regression's exposure is the
   * start's realised batters faced, and realised depth is a collider for the
   * damage markets: among starts that lasted 24 batters, the pitcher facing
   * the better lineup was having a good night, so his opponent's average
   * predicts fewer hits than it should. Strikeouts are the market where depth
   * and the rate are near-orthogonal (K/outs is flat at 0.31 across depths),
   * which is why the exponent survives there and is not trusted elsewhere.
   * Walks, hits and home runs keep v36's damping; measured on the fit tail,
   * their fitted exponents are worth nothing either way.
   *
   * Fitted by tools/pitcher-port-fit.mjs on 8,352 FIT starts.
   */
  opp: {
    k: { k: 0.5552, bb: 0.0124, h: 0.0165 },
    bb: null,
    h: null,
    hr: null,
  },
  /**
   * Per-market calibration `[anchor, slope, level]`, refitted against OUTCOMES
   * on the FIT split with the rest of the port in place.
   *
   * These supersede `kLevel`, `bbLevel`, `hLevel` and `outsLevel` — the level
   * factor is folded in, so those four constants are inert whenever this object
   * is present. That is the point of them: `docs/ACCURACY.md` measured the v36
   * trims against two seasons of box scores and found `kLevel` 0.95 and
   * `hLevel` 0.97 to be the whole of the strikeout and hits-allowed
   * miscalibration — every over reading 2.6 and 2.0 points low. They were
   * fitted against PRICES. The levels here (1.0115 and 0.9879) are fitted
   * against what happened.
   */
  cal: {
    // OUTS ONLY, and the other four are deliberately absent.
    //
    // Once v37 set `kLevel` and `hLevel` to 1.0, v36's own anchors and slopes
    // were already close to right everywhere except depth. Refitting them
    // freely makes them worse, because the regression slope that minimises
    // squared error is not the slope that calibrates a ladder: fitted freely,
    // hits came back at 0.752 against v36's 0.89, which flattens the
    // projection and leaves every rung reading low. v36's own comment says its
    // 0.89 was chosen deliberately less aggressive than either season's fit,
    // and it was right.
    //
    // Measured on the fit window, calibration error per market:
    //
    //                     v37    with this market refitted
    //     strikeouts     0.90         0.90
    //     outs           1.97         0.78
    //     hits allowed   0.38         0.93
    //     walks          0.94         1.29
    //     earned runs    1.13         1.17
    //
    // Only depth wants a new curve, and it wants one badly — which is what the
    // workload change below did to it. Refitting strikeouts on top of v37's
    // level actually costs calibration (0.50 -> 0.90); the honest reading is
    // that v37's two-constant change already collected what was there, and
    // that the port's strikeout contribution is in the RANKING (correlation
    // 0.442 -> 0.447), not in the level.
    outs: [15.5074, 0.8756, 0.9952],
  },
  /**
   * ROLE (v38). The one thing the depth model did not know: whether tonight's
   * starter is a starter.
   *
   * `cal.outs` above shrinks every start's projected depth toward a single
   * anchor, 15.5 outs, as though starts came from one population. They come
   * from two. Over the FIT split, 298 of 8,405 starts were made by a pitcher
   * whose last three appearances had all been one- or two-inning relief
   * outings. Those starts averaged **5.44 outs**. The other 8,107 averaged
   * 15.81. Fitting one straight line through both flattens the shrink from
   * 0.688 to 0.879 — and that flattened shrink is then applied to the 8,107
   * real starters, who are consequently under-shrunk at both ends:
   *
   *     raw outs     8.1   11.2   13.3   14.6   15.5   16.5   17.4   18.6
   *     actual      10.1   13.7   14.3   14.8   15.4   16.2   16.9   17.9
   *     v37 ships    9.0   11.7   13.5   14.6   15.5   16.3   17.1   18.1
   *
   * — a 2.0-out under-projection at the bottom and a 0.3-out over-projection
   * at the top, from one line doing the work of two.
   *
   * So the fix is not a bullpen-game distribution. The distribution was never
   * the problem: measured inside buckets of the model's own projection, the
   * hook PMF's sd is 3.2-3.7 against a realised rmse of 3.5-4.3, which is
   * right. The problem is one anchor for two populations, and the fix is two
   * anchors — the SAME shrink-to-mean the model already uses, fitted once per
   * population.
   *
   * `window` / `openerOuts` are the read: the longest outing among his last
   * `window` appearances, RELIEF INCLUDED. At or below `openerOuts` he is not
   * currently a starter. The threshold was swept 3..9 on the fit split; 6 is
   * where the two fitted lines separate most cleanly (at 3 the relief class is
   * too small to fit, from 7 up it starts swallowing real short starts).
   *
   * `pass` is how much of the depth change the counting stats carry. Strikeouts,
   * hits, walks and earned runs are all `projBF x a rate`, and the role read
   * moved `projBF`, not the rate — so a start that is now projected 15% deeper
   * should be projected 15% more of each, which is `pass: 1`. Each is a
   * switch measured per market in docs/OPENER-FIX.md, not a free coefficient.
   *
   * ALL OF THIS NEEDS `input.appearanceLog`, the pitcher's every appearance
   * this season with relief outings left in. `src/data/loadSlate.js` already
   * fetches exactly that log and throws the relief rows away to build
   * `gameLog`; it now keeps a copy. **Without that input this whole term is
   * inert and the model is byte-for-byte v37** — `test/pitcher.test.js` pins
   * it.
   */
  role: {
    /** Appearances read back from tonight, relief included. */
    window: 3,
    /** Longest outing in that window, in outs, at or below which he is a reliever. */
    openerOuts: 6,
    /**
     * `[anchor, slope, level]` on projected outs, replacing `cal.outs` for a
     * start the log says is a relief outing. Fitted on the FIT split, 298
     * starts, with the slope held at 1: a class that size supports a level and
     * not a slope, and fitted freely it comes back at 1.008 anyway.
     */
    opener: [6, 1, 0.8978],
    /**
     * The same, for a start the log says is a real start. Same anchor as
     * `cal.outs` — only the shrink changes, and it changes because the relief
     * starts are no longer in the regression that fits it.
     */
    starter: [15.5, 0.688, 1.0047],
    /**
     * And again, for a pitcher with NO appearance at all this season — a debut,
     * a call-up, a return from the injured list. 455 of them on the fit split,
     * and the finding is the slope: **0.19**. His projection is built entirely
     * from last season and a league prior, and against what actually happened
     * that carries almost no information — the honest projection is close to
     * the class's own mean of 14.6 outs whatever last year says. Left on the
     * starter line he is over-projected by 0.85 outs.
     *
     * Set to null to put debuts back on the starter line.
     */
    debut: [15.5, 0.1852, 0.9469],
    /** Pass-through of the depth change to the counting stats. */
    pass: { k: 1, hits: 1, bb: 1, er: 1 },
  },
  progress: {
    ref: 0.8862,
    outs: -0.0257,
    // Strikeouts, hits, walks and earned runs have no drift shipped. The hits
    // and walks ones are real and fitted (-0.0282 and -0.0545 per 100 days,
    // replicated in both seasons), but those markets keep v36's curve and half
    // a correction is worse than none — walks got measurably worse with it,
    // 0.94 -> 1.29, because 2026's walk rate jumped in August against the
    // trend. Strikeouts have no season trend at all: 2025 ran 4.81 in April
    // and 4.88 in September, 2026 ran 4.69 and 4.60.
  },
};

const REAL_OFFSEASON_DAYS = 179;

/**
 * Recency-weighted, partially pooled per-batter-faced rates over BOTH seasons.
 *
 * Replaces `shrunkRate`'s flat "this season plus 0.6 of last season". One
 * exponential decay over a compressed calendar does the same job continuously:
 * within a season it is real days, and the offseason counts for `offDays`
 * instead of its real 179. The implied weight on a 2025-07-01 start seen from
 * 2026-08-01 comes out at 0.50 — close to the 0.6 the flat blend uses — while
 * a 2026-06-01 start gets 0.86 and an April 2026 start much less. A flat blend
 * cannot express that; it gives every 2025 appearance the same 0.6 whether it
 * was thrown in April or September, and every 2026 appearance a 1.
 *
 * Returns null when there is nothing usable to decay, so the caller falls
 * straight back to `shrunkRate`.
 *
 * @param {Array}  rateLog  `{date, season, bf, k, bb, h, hr, hbp}` per appearance
 * @param {string} asOf     the start's own date; nothing on or after it counts
 * @param {number} season   the start's season
 * @param {number} tau      decay constant in days
 * @param {number} offDays  effective offseason length in days
 */
export function decayedRateTotals(rateLog, asOf, season, tau, offDays) {
  if (!Array.isArray(rateLog) || !rateLog.length || !asOf || !(tau > 0)) return null;
  const now = Date.parse(`${asOf}T00:00:00Z`);
  if (!Number.isFinite(now)) return null;
  const totals = { bf: 0, k: 0, bb: 0, h: 0, hr: 0, hbp: 0 };
  let seen = 0;
  for (const g of rateLog) {
    const at = Date.parse(`${g.date}T00:00:00Z`);
    if (!Number.isFinite(at) || at >= now) continue;
    const gapSeasons = (season || 0) - (g.season || 0);
    // Compressed calendar: real days within a season, `offDays` across each
    // offseason. Floored at zero so a mis-stamped season cannot invent weight.
    const age = Math.max(0, (now - at) / 864e5 - gapSeasons * (REAL_OFFSEASON_DAYS - offDays));
    const w = Math.exp(-age / tau);
    const bf = g.bf || 0;
    if (bf <= 0) continue;
    totals.bf += w * bf;
    totals.k += w * (g.k || 0);
    totals.bb += w * (g.bb || 0);
    totals.h += w * (g.h || 0);
    totals.hr += w * (g.hr || 0);
    totals.hbp += w * (g.hbp || 0);
    seen++;
  }
  return seen && totals.bf > 0 ? totals : null;
}

/** Partial pooling: a weighted rate pulled toward `prior` by `strength` trials. */
const pooledRate = (num, den, prior, strength) =>
  (num + strength * prior) / (den + strength);

export function projectPitcher(input) {
  const T = { ...PITCHER_TUNING, ...(input.tuning || {}) };
  const F = { ...PITCHER_FIT, ...(input.fit || {}) };
  const {
    season26,
    season25,
    gameLog = [],
    opp,
    park,
    /**
     * Every appearance of BOTH seasons, relief included, with the counting
     * stats a per-BF rate needs: `{date, season, bf, k, bb, h, hr, hbp}`.
     * Optional — without it the two rate terms below fall back to exactly the
     * v36 `shrunkRate` blend.
     */
    rateLog,
    /**
     * Every appearance this season, RELIEF INCLUDED, as `{date, outs}` (extra
     * fields ignored). This is the input that tells the model whether tonight's
     * starter is a starter; see `PITCHER_FIT.role`. Optional, and without it
     * every role term below is inert.
     */
    appearanceLog,
    /** The slate date, 'YYYY-MM-DD'. Required for `rateLog` to be read. */
    date,
    /** The slate season. Defaults to the year in `date`. */
    season,
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
  //    PORTED(v36.2) — `shrunkRate`'s two constants, the 0.6 on last season and
  //    the 70 batters faced of prior, were both assumed. Fitted (see
  //    `PITCHER_FIT`) they are a 400-day exponential decay over a compressed
  //    calendar and a pooling strength that differs by an order of magnitude
  //    between rates: 150 BF for strikeouts, 80 for walks, 1,200 for hits.
  //
  //    This needs `rateLog`, which is the pitcher's own per-appearance log for
  //    both seasons. Without it — or without a slate date to measure ages from
  //    — every one of the four rates is the v36 `shrunkRate` value, unchanged.
  const decayed = T.rateDecay
    ? decayedRateTotals(rateLog, date, season ?? Number(String(date || '').slice(0, 4)), F.tauRate, F.offDays)
    : null;
  const kRate  = decayed
    ? pooledRate(decayed.k,  decayed.bf, lg.spKRate,  F.sK)
    : shrunkRate(s26.strikeOuts,  bf26, s25.strikeOuts,  bf25, lg.spKRate);
  const bbRate = decayed
    ? pooledRate(decayed.bb, decayed.bf, lg.spBbRate, F.sBB)
    : shrunkRate(s26.baseOnBalls, bf26, s25.baseOnBalls, bf25, lg.spBbRate);
  const hRate  = decayed
    ? pooledRate(decayed.h,  decayed.bf, lg.spHRate,  F.sH)
    : shrunkRate(s26.hits,        bf26, s25.hits,        bf25, lg.spHRate);
  const hrRate = decayed
    ? pooledRate(decayed.hr, decayed.bf, lg.spHrRate, F.sHR)
    : shrunkRate(s26.homeRuns,    bf26, s25.homeRuns,    bf25, lg.spHrRate, 120);

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

  // PORTED(v36.2) — the opponent factor, fitted.
  //
  // The three damping coefficients above (0.40 / 0.30 / 0.35) were the model's
  // only statement about how much of a lineup's deviation reaches the arm, and
  // none of them was measured. `F.opp` replaces them with exponents fitted on
  // the study's FIT split against these exact board quantities, and adds the
  // cross-terms the shipped model set to zero — a lineup that strikes out a lot
  // also gets fewer hits, and that is one fact about the lineup, not two.
  //
  // `ratio ** a` and `1 + a * (ratio - 1)` agree to first order, so with the
  // shipped coefficients this is the shipped adjustment; what changes is the
  // coefficients. Without `F.opp` — or with a missing `opp`, where every ratio
  // is 1 and the whole factor collapses to 1 — the v36 damping is used as-is.
  const oppFactor = (legacy, coef) => {
    if (!coef) return legacy;
    return (
      (oppK / lg.kRate) ** coef.k *
      (oppBB / lg.bbRate) ** coef.bb *
      (oppAvg / lg.avg) ** coef.h
    );
  };

  const adjK = clamp(
    kRate * oppFactor(1 + 0.4 * (oppK / lg.kRate - 1), F.opp?.k) *
      parkFactor(park, 'so', 0.5) * K_CONTACT_SPLIT * plK * homeKFactor,
    0.05, 0.45,
  );
  const adjBB = clamp(
    bbRate * oppFactor(1 + 0.3 * (oppBB / lg.bbRate - 1), F.opp?.bb) * plBB,
    0.02, 0.18,
  );
  const adjH = clamp(
    hRate * oppFactor(1 + 0.35 * (oppAvg / lg.avg - 1), F.opp?.h) *
      parkFactor(park, 'hits', 0.7) * (2 - K_CONTACT_SPLIT) * plH,
    0.12, 0.34,
  );
  const adjHR = clamp(
    hrRate * oppFactor(1, F.opp?.hr) * parkFactor(park, 'hr', 0.7) * plHR,
    0.005, 0.07,
  );

  // ---------------------------------------------------------------------
  // 3. Pitch-count budget — how deep the manager will let him go.
  // ---------------------------------------------------------------------
  // PORTED(v36.2) — "the last three starts", weighted by when they happened.
  //
  // `recentStarts: 3` was a window with a hard edge: the third-last start
  // counted fully and the fourth-last not at all, whether they were four days
  // apart or four weeks. Depth is the fastest-moving thing this model tracks —
  // the fitted decay constant is **20 days** against 400 for the rates — so the
  // edge was in the wrong place twice over. A starter three weeks back from the
  // IL was being read off outings from before it; a starter who threw 105, 102
  // and 98 pitches in the last fortnight was given the same evidence as one who
  // threw them across two months.
  //
  // Every logged start now counts, at `exp(-age / tauWork)`, over the same
  // compressed calendar the rates use. The effective sample is about 4.5 starts
  // for a healthy rotation arm, so this is not a wider window — it is the same
  // amount of evidence, ordered.
  //
  // Needs a date on the log entries and a slate date. Without either, the v36
  // flat mean of the last `recentStarts` is used, unchanged.
  const workPairs = (() => {
    if (!T.workDecay || !(F.tauWork > 0) || !date || !gameLog.length) return null;
    const now = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(now)) return null;
    const asOfSeason = season ?? Number(String(date).slice(0, 4));
    const out = [];
    for (const g of gameLog) {
      const at = Date.parse(`${g.date}T00:00:00Z`);
      if (!Number.isFinite(at) || at >= now) continue;
      const gapSeasons = asOfSeason - Number(String(g.date).slice(0, 4));
      const age = Math.max(0, (now - at) / 864e5 - gapSeasons * (REAL_OFFSEASON_DAYS - F.offDays));
      out.push({ g, w: Math.exp(-age / F.tauWork) });
    }
    return out.length ? out : null;
  })();

  const recent = workPairs || gameLog.slice(-T.recentStarts).map((g) => ({ g, w: 1 }));

  // Median pitch count over those starts, used only as a yardstick.
  const medianPitches = (() => {
    const sorted = recent.map(({ g }) => g.pitches || 0).sort((a, b) => a - b);
    return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  })();

  // Keep only "real" starts: >= 60% of the median pitch count. This drops
  // rain-shortened / ejected / opener outings so they don't drag the budget
  // DOWN artificially.
  const fullPairs = recent.filter(({ g }) => (g.pitches || 0) >= 0.6 * medianPitches);
  const fullOutings = fullPairs.map(({ g }) => g);
  const fullWeight = fullPairs.reduce((sum, { w }) => sum + w, 0);

  const recentPitchAvg = fullWeight > 0
    ? fullPairs.reduce((sum, { g, w }) => sum + w * (g.pitches || 0), 0) / fullWeight
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

  // PORTED(v36.2) — the anchor/slope pairs above were fitted against the v36
  // rates. The ported rates are pooled and decayed differently, so they spread
  // differently, and a slope fitted for the old spread would put back the wrong
  // amount. `F.cal` carries `[anchor, slope, level]` per market, refitted on
  // the study's FIT split with the whole ported pipeline in place — the level
  // factors are folded in, which is why passing `F.cal` also supersedes
  // `kLevel` / `bbLevel` / `hLevel` / `outsLevel`. Without `F.cal` every market
  // uses the v36 constants above, unchanged.
  const calOf = (market, anchor, slope, level) => {
    const c = F.cal?.[market];
    return c ? [c[0], c[1], c.length > 2 ? c[2] : 1] : [anchor, slope, level];
  };
  // Days into the season, in hundreds — the same clock the study's `progress`
  // term uses. Null whenever the caller did not say what day it is, which
  // switches the drift term off rather than guessing a date.
  const progress = (() => {
    if (!F.progress || !date) return null;
    const yr = season ?? Number(String(date).slice(0, 4));
    const days = (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${yr}-03-20T00:00:00Z`)) / 864e5;
    return Number.isFinite(days) ? days / 100 : null;
  })();
  const driftFor = (market) =>
    progress != null && F.progress?.[market] != null
      ? Math.exp(F.progress[market] * (progress - (F.progress.ref ?? 0)))
      : 1;
  const calibrated = (value, floor, market, anchor, slope, level) => {
    const [a, s, l] = calOf(market, anchor, slope, level);
    return Math.max(floor, shrinkToMean(value, a, s) * l * driftFor(market));
  };

  const projOutsCal = calibrated(projOuts, 3, 'outs', 15.5, 0.89, T.outsLevel);

  // ---------------------------------------------------------------------
  // 5a. ROLE (v38) — is tonight's starter a starter?
  //
  // `PITCHER_FIT.role` carries the whole argument. In one line: `cal.outs`
  // above is one shrink-to-mean fitted through two populations, and this
  // splits it into the two it was always trying to be. The read is his own
  // recent usage, relief outings included, which is the one thing that tells a
  // bullpen game from a rookie on a short leash BEFORE first pitch.
  //
  // Everything here is gated on `input.appearanceLog`. Without it `role` is
  // null, `depthShift` is exactly 1, and every projection below is the v37
  // number to the last bit.
  // ---------------------------------------------------------------------
  const role = (() => {
    if (!F.role || !Array.isArray(appearanceLog) || !date) return null;
    const before = [];
    let dated = 0;
    for (const a of appearanceLog) {
      if (!a || !a.date) continue;
      dated++;
      if (a.date < date) before.push(a);
    }
    // A log with nothing datable in it is a log the model cannot read, and an
    // unreadable input is a missing input: fall straight back to `cal.outs`.
    if (appearanceLog.length && !dated) return null;
    // An EMPTY log is a different thing, and not a missing one: it says he has
    // not pitched at all this season, which is a real thing to know and its
    // own population. So is a log whose every entry is tonight or later.
    if (!before.length) return F.role.debut ? 'debut' : 'starter';
    before.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    // Not named `window`: this file is bundled for the browser.
    const lookback = Math.max(1, Math.round(F.role.window ?? 3));
    let longest = -1;
    for (const a of before.slice(-lookback)) {
      const outs = Number(a.outs);
      if (Number.isFinite(outs) && outs > longest) longest = outs;
    }
    // Every entry unreadable: treat the log as absent rather than guess.
    if (longest < 0) return null;
    return longest <= (F.role.openerOuts ?? 6) ? 'opener' : 'starter';
  })();

  const roleCal = role ? F.role[role] : null;
  const projOutsAdj = roleCal
    ? Math.max(3, shrinkToMean(projOuts, roleCal[0], roleCal[1]) * (roleCal[2] ?? 1) * driftFor('outs'))
    : projOutsCal;

  /**
   * What the role read did to projected depth, as a ratio. Exactly 1 whenever
   * the role read did not fire, which is what makes every line below a no-op
   * without `input.appearanceLog`.
   *
   * Batters faced ride depth, and every counting stat is `projBF x a rate`.
   * The role read moved the depth, not the rate, so the counting stats move
   * with it: `pass` is 1 per market and is a switch, not a fitted coefficient.
   */
  const depthShift = projOutsCal > 0 && Number.isFinite(projOutsAdj)
    ? projOutsAdj / projOutsCal
    : 1;
  const carry = (value, market) => {
    const pass = F.role?.pass?.[market];
    return pass ? value * depthShift ** pass : value;
  };

  const projHAdj = carry(calibrated(projH, 0.2, 'hits', 4.88, 0.89, T.hLevel), 'hits');
  const projKAdj = carry(calibrated(projK, 0.2, 'k', 4.78, 0.96, K_LEVEL), 'k');
  const projERAdj = carry(calibrated(projER, 0.2, 'er', 2.44, 0.78, 1), 'er');
  const projBBAdj = carry(calibrated(projBB, 0.1, 'bb', 1.72, 0.75, BB_LEVEL), 'bb');

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
  // 5c. PORTED(v36.2) — strikeouts are drawn from the same night the outs are.
  //
  // `dist.k` has always been a binomial in batters faced with the trial count
  // smeared +-`bfSpread` to admit that batters faced is uncertain. That
  // three-point mixture was an invented spread bolted onto a quantity the model
  // already knows the distribution of: how deep he goes. Step 5b builds a full
  // PMF over outs, fitted and calibrated against 2,624 real starts, and batters
  // faced is just outs divided by the out rate. Smearing +-5 batters on top
  // both duplicated that uncertainty and got its SHAPE wrong — the outs
  // distribution is sharply left-skewed and clustered on inning boundaries,
  // and a symmetric three-point mixture is neither.
  //
  // So depth is drawn once and strikeouts are binomial in the batters that
  // depth implies, which is the study's "one realisation of depth drives every
  // market" for the one market it measured a gain in. The trial count is now
  // whatever the hook model says, and P(K) is re-derived against the mixture's
  // own mean so the printed projection is still exactly the mean of the tail.
  //
  // `tuning: { depthK: false }` restores the v36 three-point mixture exactly.
  const kByDepth = (() => {
    if (!T.depthK) return null;
    const outRate = clamp(outRatePerBF, 0.55, 0.85);
    const trials = [];
    let meanBf = 0;
    for (let o = 0; o < outsPmf.length; o++) {
      const w = outsPmf[o];
      if (w < 1e-9) continue;
      const n = Math.max(1, Math.round(o / outRate));
      trials.push([n, w]);
      meanBf += w * n;
    }
    return meanBf > 0 ? { trials, meanBf } : null;
  })();

  // ---------------------------------------------------------------------
  // 6. Market tail distributions: each returns P(stat > line).
  // ---------------------------------------------------------------------
  const dist = {
    // Strikeouts: binomial in BF. Because BF itself is uncertain, this is a
    // 3-point equal-weight mixture over BF-3 / BF / BF+3, which fattens both
    // tails relative to a single binomial. The per-BF K probability is
    // re-derived from projK/bfTrials and re-clamped 0.02-0.60.
    k: (line) => {
      if (kByDepth) {
        const p = clamp(projKAdj / kByDepth.meanBf, 0.02, 0.6);
        let sum = 0;
        for (const [n, w] of kByDepth.trials) sum += w * binomTailOver(line, n, p);
        return clamp(sum, 0, 1);
      }
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