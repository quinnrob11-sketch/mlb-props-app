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
 */

import {
  clamp,
  binomPmf,
  binomTailOver,
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
  return {
    k: k == null ? lg.kRate : clamp(k, 0.05, 0.45),
    h: h == null ? lg.hRate : clamp(h, 0.12, 0.34),
    hr: hr == null ? lg.hrRate : clamp(hr, 0.005, 0.07),
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
    hr:     shrunkRate(s26.homeRuns,    pa26, s25.homeRuns,    pa25, 0.03,  100),
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
  //   - prior 0.04 SB/game, the model's own pre-existing default, so the
  //     zero-playing-time answer is unchanged;
  //   - strength 30 games. `shrunkRate`'s strength is in denominator units, so
  //     30 games is ~126 PA — the same neighbourhood as the 100-120 PA used for
  //     the model's other rare events (HR 100, triples 120), and it carries the
  //     same prior *event* mass (30 x 0.04 = 1.2 steals) that 100 PA x 0.03
  //     carries for home runs. The >20-game cliff disappears: playing time now
  //     moves the estimate continuously.
  const sbPerGame = shrunkRate(
    s26.stolenBases, s26.gamesPlayed,
    s25.stolenBases, s25.gamesPlayed,
    0.04, 30,
  );

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
    spK = 1 + PITCHER_INFLUENCE * (sp.k / lg.kRate - 1);
    spHit = 1 + PITCHER_INFLUENCE * 0.8 * (sp.h / lg.hRate - 1);
    spHr = 1 + PITCHER_INFLUENCE * 0.8 * (sp.hr / lg.hrRate - 1);

    // FIX(2a) — run environment created by the starter. The ratio is built
    // from the same two legs (hits, HR) at the model's own run values, and is
    // damped by the same net 0.48 those two legs already use: runs are a
    // batted-ball outcome, and passing the signal through at the bare 0.6
    // would make runs MORE pitcher-sensitive than the hits they are made of.
    spRunEnv =
      1 +
      PITCHER_INFLUENCE * 0.8 *
        (runProxy(sp.h, sp.hr) / runProxy(lg.hRate, lg.hrRate) - 1);
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
  const hrPARaw = clamp(
    rates.hr * (platoon === 1 ? 1 : (platoon - 1) * 1.8 + 1) * spHr * parkHrWeather,
    0.002, 0.1,
  );

  // Non-HR hit rate: platoon x starter x park, then the same flat 0.975
  // haircut the hit rate has always carried. `rates.hit - rates.hr` is strictly
  // positive (HR are a subset of hits, and the hit prior contributes 13.32
  // synthetic hits against the HR prior's 3.0), so nothing has to be floored.
  const nonHrHitPARaw = Math.max(
    0,
    (rates.hit - rates.hr) * platoon * spHit * parkHits * 0.975,
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
  const projR = pa * rates.run * (platoon * 0.4 + 0.6) * runContext;
  const projRBI = pa * rates.rbi * (platoon * 0.4 + 0.6) * runContext * 0.975;

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
  //    (n = 0 is safe: binomTailOver returns 0 for zero trials, which is the
  //    correct P(X > line >= 0).)
  // ---------------------------------------------------------------------
  const paFloor = Math.max(0, Math.floor(pa));
  const paCeil = Math.max(0, Math.ceil(pa));
  const paFrac = pa - paFloor;

  /** Blend a per-trial-count quantity over floor(pa) / ceil(pa). */
  const mixOverPa = (fn) =>
    paFrac <= 0 ? fn(paFloor) : (1 - paFrac) * fn(paFloor) + paFrac * fn(paCeil);

  // ---------------------------------------------------------------------
  // 10. Total-bases PMF by exact multinomial convolution.
  //
  //     Each PA is one draw from {out, 1B, 2B, 3B, HR} with base values
  //     {0,1,2,3,4}; convolving n independent draws gives the exact TB
  //     distribution. The PMF is captured at floor(pa) draws and again at
  //     ceil(pa), then mixed — same fractional-PA treatment as the binomial
  //     markets, so E[TB] is exactly `projTB`.
  //
  //     `outProb` is the leftover mass, floored at 0 — if the four hit
  //     probabilities ever sum above 1 the PMF silently sums above 1 too.
  // ---------------------------------------------------------------------
  const tbPmf = (() => {
    const outcomeProbs = [singlePA, doublePA, triplePA, hrPA];
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

    let pmf = [1];
    for (let i = 0; i < paFloor; i++) pmf = step(pmf);
    if (paFrac <= 0) return pmf;

    const pmfCeil = step(pmf);
    const mixed = new Array(pmfCeil.length).fill(0);
    for (let i = 0; i < pmfCeil.length; i++) {
      mixed[i] = (1 - paFrac) * (pmf[i] || 0) + paFrac * pmfCeil[i];
    }
    return mixed;
  })();

  // ---------------------------------------------------------------------
  // 11. H+R+RBI as the convolution of its own components.
  //
  //     FIX(3) — `projHRR` is defined as `projH + projR + projRBI`, but the
  //     distribution was a fitted NB(k=2.2) whose mean did not even match
  //     (`round(pa)` in the hits leg pulled the implied mean to 2.035 against a
  //     reported 2.114) and which disagreed with the convolution of the model's
  //     own marginals by up to 9.7pp — the app could recommend both sides of
  //     the same hitter. The self-consistent object is the convolution of
  //     `dist.hits`, `dist.runs` and `dist.rbi`, which is what this is: same
  //     binomial mixture, same Poisson(projR), same NB(projRBI, 0.85). Its mean
  //     is therefore exactly projH + projR + projRBI = projHRR.
  //
  //     Independence is assumed, as it is everywhere else in the model. The
  //     three legs are in truth positively correlated (analysis #4.5), so this
  //     understates the tails — but it is the model's own standing assumption
  //     rather than a fourth, unrelated dispersion constant.
  // ---------------------------------------------------------------------
  const hrrPmf = (() => {
    const hitsPmf = new Array(paCeil + 1)
      .fill(0)
      .map((_, k) => mixOverPa((n) => binomPmf(k, n, hitPA)));
    const runsPmf = densePmf((k) => poissonPmf(k, projR), projR);
    const rbiPmf = densePmf((k) => negBinomPmf(k, projRBI, 0.85), projRBI);
    return convolvePmf(convolvePmf(hitsPmf, runsPmf), rbiPmf);
  })();

  // ---------------------------------------------------------------------
  // 12. Market tail distributions: each returns P(stat > line).
  //
  //     Families: binomial (mixed over floor/ceil PA) for hits / HR / singles /
  //     K; exact multinomial for TB; Poisson for runs; NB for RBI (k=0.85) and
  //     SB (k=1, geometric); and the convolution above for H+R+RBI. Every one
  //     of them now has mean exactly equal to the `proj*` displayed next to it.
  // ---------------------------------------------------------------------
  const dist = {
    hits:    (line) => mixOverPa((n) => binomTailOver(line, n, hitPA)),
    hr:      (line) => mixOverPa((n) => binomTailOver(line, n, hrPA)),
    singles: (line) => mixOverPa((n) => binomTailOver(line, n, singlePA)),
    k:       (line) => mixOverPa((n) => binomTailOver(line, n, kPA)),

    // Exact multinomial tail from the convolved PMF.
    tb: (line) => tailFromPmf(tbPmf, line),

    runs: (line) => poissonTailOver(line, projR),
    rbi:  (line) => negBinomTailOver(line, projRBI, 0.85),
    hrr:  (line) => tailFromPmf(hrrPmf, line),
    sb:   (line) => negBinomTailOver(line, Math.max(0.01, projSB), 1),
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
 * Deliberately unchanged (out of the brief; all still live defects):
 *
 *   #5  RBI NB(k=0.85) vs runs Poisson for two near-identical real
 *       distributions — retuning the RBI dispersion would move a live market
 *       on judgement alone, and `dist.hrr` now inherits whatever `dist.rbi`
 *       says rather than contradicting it.
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
