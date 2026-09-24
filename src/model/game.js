/**
 * Game model: moneyline, run line and total.
 *
 * WHAT IT PRODUCES
 *
 * A full joint distribution over the FINAL score (away runs x home runs), built
 * inning by inning, from which every team market is read exactly:
 *
 *   moneyline   P(home wins)
 *   run line    P(home margin > -spread)   e.g. home -1.5 covers on margin >= 2
 *   total       P(away + home > line), with pushes on whole-number lines
 *
 * WHY INNING BY INNING, AND NOT TWO INDEPENDENT RUN DISTRIBUTIONS
 *
 * The obvious shortcut — a negative binomial for each team's runs, multiplied
 * together — gets the three markets MLB actually trades wrong in ways that are
 * structural, not tunable:
 *
 *   - The home team skips the bottom of the ninth when it leads, so its final
 *     score is truncated exactly when it is winning.
 *   - A walk-off ends the game the moment the winning run scores, so home wins
 *     pile up at a one-run margin. Measured on 2,271 completed 2026 games, a
 *     nine-inning home win by exactly one run is 13.1% of all games; an away win
 *     by one is 8.7%. That asymmetry IS the run line.
 *   - 8.7% of games go to extras, where each half starts with a runner on
 *     second (1.21 runs per half against 0.48 in regulation), adding 2.87 runs
 *     to the total on average — a push-and-overs effect on every total.
 *
 * Simulating the game as it is played captures all three for free, and the
 * computation is exact (a convolution over a 31x31 grid), not Monte Carlo.
 *
 * WHERE EVERY NUMBER COMES FROM
 *
 * The per-half-inning run distributions and the inning profile are measured
 * from 2026 regular-season linescores; the four free constants are fitted by
 * tools/fit-game-model.mjs. The team inputs are ordinary season stats, shrunk toward league
 * average. Nothing here is fitted against betting prices.
 */

import { clamp } from '../lib/probability.js';
import { parkFactor, parkWindFactor } from '../lib/parks.js';
import { probToAmerican } from '../lib/odds.js';

/** Largest run count tracked per team; mass beyond it is lumped at the cap. */
const MAX_RUNS = 30;
const SIZE = MAX_RUNS + 1;

/**
 * Runs scored in one regulation half-inning, P(0), P(1), ... P(10+).
 * 20,436 away half-innings, innings 1-9, 2026 regular season. Mean 0.4794.
 * (Away halves only: a home ninth is not always played, and when it is played
 * it can be cut short by a walk-off, so it is not an unbiased sample.)
 */
export const HALF_INNING_PMF = [
  0.7356, 0.146, 0.0636, 0.0307, 0.0142, 0.0059, 0.0022, 0.0011, 0.0004, 0.0002,
  0.0001,
];

/**
 * The first inning has its own shape, not just its own mean: the top of the
 * order reaches base more often but strings fewer big innings together than a
 * tilted regulation distribution implies. Tilting HALF_INNING_PMF to the
 * first-inning means put P(scoreless) 1.0pt too high for the away half and
 * 2.2pts too high for the home half, which compounds to +2.5pts on NRFI. So
 * each first half is tilted from its own measured distribution (2,271 games).
 */
export const FIRST_INNING_AWAY_PMF = [
  0.7345, 0.155, 0.0647, 0.0269, 0.0119, 0.004, 0.0018, 0.0004, 0.0004, 0.0004, 0,
];
export const FIRST_INNING_HOME_PMF = [
  0.6742, 0.166, 0.0903, 0.0432, 0.0159, 0.0057, 0.0035, 0.0004, 0.0004, 0.0004, 0,
];

/**
 * Runs scored in one EXTRA half-inning, which starts with a runner on second.
 * 267 away extra halves, 2026. Mean 1.21. The tail beyond 6 is sparse in the
 * sample and is smoothed geometrically rather than taken at face value.
 */
export const EXTRA_INNING_PMF = [
  0.3933, 0.2809, 0.1685, 0.0936, 0.0375, 0.015, 0.0058, 0.0026, 0.0012, 0.0006,
  0.001,
];

/**
 * League mean runs per half-inning, innings 1-9, measured separately for each
 * side on 2026 linescores.
 *
 * Home and away are NOT one profile times a home-field constant. The bottom of
 * the first is worth 32% more than the top of it — the visiting starter is
 * throwing his first pitches in a road park to the top of the order — while the
 * home edge in innings 2-8 averages about 6%. A single multiplier put the
 * extra first-inning runs everywhere, which is why the old NRFI model sat about
 * four points too high on NRFI (actual 2026 rate: 49.5%).
 *
 *               1     2     3     4     5     6     7     8     9
 *     away    .454  .438  .466  .499  .526  .491  .483  .491  .468
 *     home    .600  .480  .516  .483  .552  .523  .471  .557  (.510)
 *
 * The home ninth is only played when home is not ahead and can end early, so
 * its raw mean is biased; it is set to the away ninth times the innings 1-8
 * home/away ratio (1.089).
 */
export const AWAY_HALF_MEANS = [0.454, 0.438, 0.466, 0.499, 0.526, 0.491, 0.483, 0.491, 0.468];
export const HOME_HALF_MEANS = [0.6, 0.48, 0.516, 0.483, 0.552, 0.523, 0.471, 0.557, 0.51];
const HOME_EXTRA_RATIO = 1.089;

/** League runs per team per game when the tables above were measured. */
export const CALIBRATION_RPG = 4.4932;

/**
 * Small correction on the measured home scoring rates. The measured home means
 * already contain home-field advantage; this only absorbs what the simulation's
 * structure (skipped ninth, walk-offs) does to them. Near 1 by construction.
 *
 * The four constants HOME_ADJUST, WALKOFF_EXACT, SIGMA_SHARED and SIGMA_TEAM_TOTAL
 * are fitted JOINTLY by tools/fit-game-model.mjs against 2,271 completed 2026
 * games. Two league-average teams in a neutral park then reproduce:
 *
 *                        model    actual
 *     no run in the 1st  50.12%   49.54%
 *     home win           52.94%   52.88%
 *     home wins by 1     16.90%   16.86%
 *     away wins by 1     11.50%   10.88%
 *     home -1.5 covers   36.04%   36.02%
 *     away -1.5 covers   35.55%   36.24%
 *     over 7.5           57.23%   57.11%
 *     over 8.5           49.65%   49.10%
 *     over 9.5           39.83%   40.11%
 *     over 10.5          33.34%   33.38%
 *     goes to extras      9.80%    8.72%   <- the one visible misfit
 *
 * The extras rate runs a point high: the model still produces slightly too
 * many level games after nine. Its effect on the totals above is already
 * inside the fit.
 */
export const HOME_ADJUST = 0.988;

/**
 * Share of walk-offs that stop at exactly the winning run. The rest are home
 * runs and bases-clearing hits, where every run counts. It is 0.50 rather than
 * the ~0.9 seen in extra innings because a regulation walk-off is far more often
 * a home run with men on than an extra-inning one, which starts with the winning
 * run already in scoring position.
 */
export const WALKOFF_EXACT = 0.5;

/**
 * Exponentially tilt a run distribution to a new mean.
 *
 * p'(k) is proportional to p(k) * t^k. This is the same move a Poisson process
 * makes when its rate changes: a better offence scores in more innings AND
 * scores more when it does, rather than only one or the other. `t` is found by
 * bisection on log t, which is monotone in the mean.
 */
export function tiltPmf(base, targetMean) {
  const mean = (pmf) => pmf.reduce((s, p, k) => s + p * k, 0);
  const tilt = (logT) => {
    const t = Math.exp(logT);
    const raw = base.map((p, k) => p * t ** k);
    const total = raw.reduce((a, b) => a + b, 0);
    return raw.map((p) => p / total);
  };
  const target = clamp(targetMean, 0.05, 4);
  let lo = -6;
  let hi = 6;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (mean(tilt(mid)) < target) lo = mid;
    else hi = mid;
  }
  return tilt((lo + hi) / 2);
}

const idx = (a, h) => a * SIZE + h;

/** Add `pmf` runs to the away (axis 0) or home (axis 1) score of every state. */
function scoreHalf(grid, pmf, homeBats) {
  const next = new Float64Array(SIZE * SIZE);
  for (let a = 0; a < SIZE; a++) {
    for (let h = 0; h < SIZE; h++) {
      const p = grid[idx(a, h)];
      if (!p) continue;
      for (let x = 0; x < pmf.length; x++) {
        if (homeBats) next[idx(a, Math.min(MAX_RUNS, h + x))] += p * pmf[x];
        else next[idx(Math.min(MAX_RUNS, a + x), h)] += p * pmf[x];
      }
    }
  }
  return next;
}

/**
 * The home half of an inning that can end the game: ninth or later, home team
 * not ahead. Scoring past the away total is a walk-off; `WALKOFF_EXACT` of
 * those stop at a one-run margin.
 *
 * Returns the finished-game mass (added to `final`) and the still-tied mass.
 */
function walkoffHalf(grid, pmf, final, walkoffExact = WALKOFF_EXACT) {
  const tied = new Float64Array(SIZE * SIZE);
  for (let a = 0; a < SIZE; a++) {
    for (let h = 0; h < SIZE; h++) {
      const p = grid[idx(a, h)];
      if (!p) continue;
      if (h > a) {
        // Home already leads after the top half: the bottom is not played.
        final[idx(a, h)] += p;
        continue;
      }
      for (let x = 0; x < pmf.length; x++) {
        const q = p * pmf[x];
        const scored = Math.min(MAX_RUNS, h + x);
        if (scored < a) final[idx(a, scored)] += q;
        else if (scored === a) tied[idx(a, scored)] += q;
        else {
          const oneRun = Math.min(MAX_RUNS, a + 1);
          final[idx(a, oneRun)] += q * walkoffExact;
          final[idx(a, scored)] += q * (1 - walkoffExact);
        }
      }
    }
  }
  return tied;
}

/**
 * Exact final-score distribution.
 *
 * @param {object} input
 * @param {number[]} input.awayHalfMeans  expected away runs, innings 1-9
 * @param {number[]} input.homeHalfMeans  expected home runs, innings 1-9
 * @param {number}   input.awayExtraMean  expected away runs per extra inning
 * @param {number}   input.homeExtraMean  expected home runs per extra inning
 * @returns {Float64Array} P(away = a, home = h) at index a*31 + h
 */
export function finalScoreGrid({
  awayHalfMeans,
  homeHalfMeans,
  awayExtraMean,
  homeExtraMean,
  walkoffExact = WALKOFF_EXACT,
  onRegulationEnd,
}) {
  let grid = new Float64Array(SIZE * SIZE);
  grid[0] = 1;
  const final = new Float64Array(SIZE * SIZE);

  for (let inning = 0; inning < 8; inning++) {
    const awayBase = inning === 0 ? FIRST_INNING_AWAY_PMF : HALF_INNING_PMF;
    const homeBase = inning === 0 ? FIRST_INNING_HOME_PMF : HALF_INNING_PMF;
    grid = scoreHalf(grid, tiltPmf(awayBase, awayHalfMeans[inning]), false);
    grid = scoreHalf(grid, tiltPmf(homeBase, homeHalfMeans[inning]), true);
  }
  grid = scoreHalf(grid, tiltPmf(HALF_INNING_PMF, awayHalfMeans[8]), false);
  grid = walkoffHalf(grid, tiltPmf(HALF_INNING_PMF, homeHalfMeans[8]), final, walkoffExact);
  if (onRegulationEnd) onRegulationEnd(grid.reduce((a, b) => a + b, 0));

  // Extras. Every surviving state is a tie. Twelve extra innings leaves well
  // under 1e-6 of mass unresolved; that remainder is split at the extra-inning
  // win rates as one-run games so no probability is dropped.
  const awayExtra = tiltPmf(EXTRA_INNING_PMF, awayExtraMean);
  const homeExtra = tiltPmf(EXTRA_INNING_PMF, homeExtraMean);
  for (let extra = 0; extra < 12; extra++) {
    grid = scoreHalf(grid, awayExtra, false);
    // A top half that fails to break the tie still has to be matched: the
    // walk-off pass handles leads, ties and deficits alike.
    grid = walkoffHalf(grid, homeExtra, final, walkoffExact);
  }
  for (let s = 0; s < MAX_RUNS; s++) {
    const p = grid[idx(s, s)];
    if (!p) continue;
    final[idx(s + 1, s)] += p * 0.5;
    final[idx(s, s + 1)] += p * 0.5;
  }
  return final;
}

/**
 * Scoring the model cannot see coming.
 *
 * Every input above is a season-level estimate, but a single game carries its
 * own shocks: wind blowing out, a tight zone, a starter with nothing. Some of
 * that is SHARED by both offences (conditions, umpire) and some belongs to one
 * side (tonight's starter). Ignoring it made the distribution too narrow in a
 * way the league data shows plainly — with fixed rates the model sent 10.3% of
 * games to extras against 8.7% observed and put 37.6% over 9.5 against 40.1%,
 * which is exactly the signature of missing variance: too many close games, too
 * few blowouts and slugfests.
 *
 * Both are modelled as mean-one lognormal multipliers and integrated exactly
 * with three-point Gauss-Hermite quadrature per factor (27 grids per game,
 * about 30ms). Their sizes are fitted to the league scoring data in
 * tools/fit-game-model.mjs, jointly with HOME_ADJUST and WALKOFF_EXACT.
 */
export const SIGMA_SHARED = 0;
export const SIGMA_TEAM_TOTAL = 0.24;

/**
 * How much of that 0.23 the per-game inputs already explain.
 *
 * The league fit uses league-average teams, so its sigma absorbs every source
 * of game-to-game variation, including team quality, starters and parks — which
 * `projectGame` models explicitly. Counting that spread twice would make every
 * game look closer to a coin flip than it is. The standard deviation of the log
 * projected team runs across a slate measured 0.116 (2026-09-16, 30 sides) and
 * 0.121 (2026-09-17, 18 sides) — `node tools/run-slate.mjs <date> --json` —
 * so only the remainder is integrated here.
 *
 * MEASURED AGAIN (v37, the ported inputs). The richer inputs below separate
 * teams more than the old ones did, so they explain more of the spread: the
 * standard deviation of the log projected team runs over the 7,810 team-games
 * of the FIT window is 0.1310 (`tools/fit-game-v2.mjs` reports it, and the
 * number is in docs/GAME-EDGE-SEARCH.md). Leaving this at 0.12 while the model
 * got sharper would have integrated a tenth of the spread twice.
 *
 * `SIGMA_TEAM_TOTAL` is NOT changed with it. The study refitted the four
 * structural constants on its FIT window alone, deliberately, so that the
 * holdout could not appear in them; the shipped 0.24 is fitted on the whole
 * 2026 season, which is more data for the season the board actually serves,
 * and it is what test/gameFit.test.js pins to the measured league rates.
 */
export const EXPLAINED_TEAM_SD = 0.131;
export const SIGMA_TEAM = Math.sqrt(SIGMA_TEAM_TOTAL ** 2 - EXPLAINED_TEAM_SD ** 2);

const GAUSS_HERMITE_3 = [
  [-Math.sqrt(3), 1 / 6],
  [0, 2 / 3],
  [Math.sqrt(3), 1 / 6],
];

export function uncertainScoreGrid(input, options = {}) {
  const sigmaShared = options.sigmaShared ?? SIGMA_SHARED;
  const sigmaTeam = options.sigmaTeam ?? SIGMA_TEAM;
  const nodes = (sigma) => (sigma > 0 ? GAUSS_HERMITE_3 : [[0, 1]]);
  const factor = (sigma, z) => Math.exp(sigma * z - (sigma * sigma) / 2);

  const out = new Float64Array(SIZE * SIZE);
  let tied = 0;
  for (const [zg, wg] of nodes(sigmaShared)) {
    for (const [za, wa] of nodes(sigmaTeam)) {
      for (const [zh, wh] of nodes(sigmaTeam)) {
        const w = wg * wa * wh;
        const mAway = factor(sigmaShared, zg) * factor(sigmaTeam, za);
        const mHome = factor(sigmaShared, zg) * factor(sigmaTeam, zh);
        const grid = finalScoreGrid({
          ...input,
          awayHalfMeans: input.awayHalfMeans.map((m) => m * mAway),
          homeHalfMeans: input.homeHalfMeans.map((m) => m * mHome),
          awayExtraMean: input.awayExtraMean * mAway,
          homeExtraMean: input.homeExtraMean * mHome,
          onRegulationEnd: (t) => {
            tied += w * t;
          },
        });
        for (let i = 0; i < out.length; i++) out[i] += w * grid[i];
      }
    }
  }
  if (input.onRegulationEnd) input.onRegulationEnd(tied);
  return out;
}

/**
 * P(no run in the first inning), integrated over the same game-level
 * uncertainty as `uncertainScoreGrid`. Each half is that side's measured
 * first-inning distribution tilted to the game's inning-one mean.
 *
 * Checked against 2026: two league-average teams give 49.4% against 49.5%
 * actual (tools/fit-game-model.mjs reports it).
 */
export function firstInningScoreless(input, options = {}) {
  const sigmaShared = options.sigmaShared ?? SIGMA_SHARED;
  const sigmaTeam = options.sigmaTeam ?? SIGMA_TEAM;
  const nodes = (sigma) => (sigma > 0 ? GAUSS_HERMITE_3 : [[0, 1]]);
  const factor = (sigma, z) => Math.exp(sigma * z - (sigma * sigma) / 2);
  let p = 0;
  for (const [zg, wg] of nodes(sigmaShared)) {
    for (const [za, wa] of nodes(sigmaTeam)) {
      for (const [zh, wh] of nodes(sigmaTeam)) {
        const shared = factor(sigmaShared, zg);
        const away = tiltPmf(FIRST_INNING_AWAY_PMF, input.awayHalfMeans[0] * shared * factor(sigmaTeam, za))[0];
        const home = tiltPmf(FIRST_INNING_HOME_PMF, input.homeHalfMeans[0] * shared * factor(sigmaTeam, zh))[0];
        p += wg * wa * wh * away * home;
      }
    }
  }
  return p;
}

/** Summaries of a final-score grid. */
export function summarizeGrid(grid) {
  let pHome = 0;
  let meanAway = 0;
  let meanHome = 0;
  const margin = new Map(); // home - away -> probability
  const total = new Float64Array(2 * SIZE);
  for (let a = 0; a < SIZE; a++) {
    for (let h = 0; h < SIZE; h++) {
      const p = grid[idx(a, h)];
      if (!p) continue;
      if (h > a) pHome += p;
      meanAway += p * a;
      meanHome += p * h;
      margin.set(h - a, (margin.get(h - a) || 0) + p);
      total[a + h] += p;
    }
  }
  return { pHome, meanAway, meanHome, margin, total };
}

/**
 * P(over), P(under), P(push) for a game total.
 */
export function totalProbs(summary, line) {
  let over = 0;
  let push = 0;
  summary.total.forEach((p, t) => {
    if (t > line) over += p;
    else if (t === line) push += p;
  });
  return { over, under: 1 - over - push, push };
}

/**
 * Probabilities for the HOME side of a run line. `homeSpread` is the home
 * team's handicap as books quote it: -1.5 means home must win by 2+.
 */
export function spreadProbs(summary, homeSpread) {
  let cover = 0;
  let push = 0;
  for (const [m, p] of summary.margin) {
    const adjusted = m + homeSpread;
    if (adjusted > 0) cover += p;
    else if (adjusted === 0) push += p;
  }
  return { home: cover, away: 1 - cover - push, push };
}

/**
 * Probability, excluding pushes, that the first-named side wins. The edge
 * engine prices a two-way market, so a push is removed from both sides rather
 * than counted as a loss.
 */
export const noPush = ({ over, under, home, away }) => {
  const a = over ?? home;
  const b = under ?? away;
  return a + b > 0 ? a / (a + b) : null;
};

// ── team strength inputs ────────────────────────────────────────────────────

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

/** "123.1" innings -> 123.333. */
const innings = (ip) => {
  if (ip == null) return 0;
  const [whole, frac] = String(ip).split('.');
  return (parseInt(whole, 10) || 0) + (frac ? (parseInt(frac, 10) || 0) / 3 : 0);
};

/**
 * Totals for a list of weighted season lines: innings, earned runs and the FIP
 * numerator (13 HR + 3 (BB + HBP) - 2 K).
 */
function pitchingTotals(seasons) {
  let ip = 0;
  let er = 0;
  let fipNum = 0;
  for (const { stat, weight } of seasons) {
    if (!stat) continue;
    const i = innings(stat.inningsPitched) * weight;
    if (i <= 0) continue;
    ip += i;
    er += (stat.earnedRuns ?? 0) * weight;
    fipNum +=
      (13 * (stat.homeRuns || 0) + 3 * ((stat.baseOnBalls || 0) + (stat.hitByPitch || 0)) -
        2 * (stat.strikeOuts || 0)) *
      weight;
  }
  return { ip, er, fipNum };
}

/**
 * League run-prevention baselines from team starter/reliever split lines.
 *
 * The FIP constant is solved so that league FIP equals league ERA, which is
 * what the constant is for; a hard-coded 3.1 drifts with the run environment.
 *
 * @param {object[]} spSplits  team starter lines
 * @param {object[]} rpSplits  team reliever lines
 */
export function leagueRunPrevention(spSplits, rpSplits) {
  const all = pitchingTotals([...spSplits, ...rpSplits].map((stat) => ({ stat, weight: 1 })));
  if (all.ip <= 0) return null;
  const fipConstant = (9 * all.er) / all.ip - all.fipNum / all.ip;
  const role = (splits) => {
    const t = pitchingTotals(splits.map((stat) => ({ stat, weight: 1 })));
    return t.ip > 0 ? 0.5 * ((9 * t.er) / t.ip) + 0.5 * (t.fipNum / t.ip + fipConstant) : null;
  };
  return {
    fipConstant,
    spRa9: role(spSplits),
    rpRa9: role(rpSplits),
    allRa9: (9 * all.er) / all.ip,
  };
}

/**
 * Runs-allowed quality of a group of innings (a starter, or a bullpen): half
 * ERA, half FIP, shrunk toward the league figure for the same role by innings.
 *
 * FIP is (13 HR + 3 BB - 2 K) / IP, already per inning — an early draft of
 * this function multiplied it by 9, which put ordinary starters at 10-12 runs
 * per nine and every total on the board into double digits.
 *
 * @param {Array<{stat: object, weight: number}>} seasons  weighted season lines
 * @param {number} leagueRa9  league ERA/FIP blend for the same role
 * @param {number} priorInnings  innings of league-average performance added
 * @param {number} fipConstant  from leagueRunPrevention
 * @returns {{ra9: number, ip: number}}
 */
export function runsAllowedTalent(seasons, leagueRa9, priorInnings, fipConstant = 3.1, park = 1) {
  const { ip, er, fipNum } = pitchingTotals(seasons);
  if (ip <= 0) return { ra9: leagueRa9, ip: 0 };
  const era = (9 * er) / ip;
  const fip = fipNum / ip + fipConstant;
  // The pitcher's own line carries his home park; the league prior does not.
  // Neutralise before blending so only the observed part is adjusted.
  const raw = (0.5 * era + 0.5 * fip) / park;
  return { ra9: (ip * raw + priorInnings * leagueRa9) / (ip + priorInnings), ip };
}

/**
 * The fitted per-game input coefficients: the `core` configuration of
 * docs/GAME-EDGE-SEARCH.md, ported here in v37.
 *
 * Every number is a Poisson maximum-likelihood fit to the runs each team
 * actually scored, over the 7,810 team-games of that study's FIT window (all
 * of 2025 plus 2026 through 08-09). No price appears anywhere in the fit, and
 * neither the validation window nor the holdout does. Reproduce with
 *
 *   node tools/fit-game-v2.mjs --config core \
 *     --features .backtest-cache/features_2025.json \
 *     --features .backtest-cache/features_2026.json \
 *     --out .backtest-cache/params-core.json
 *
 * Measured on the untouched holdout (2026-09-02..09-22, 5,649 Kalshi markets
 * in 273 games), paired on identical markets, these inputs forecast better
 * than the ones they replace by 0.0025 of Brier pooled [-0.0045, -0.0005],
 * 0.0036 on totals and 0.0052 on the first inning. They do NOT beat the
 * exchange price — see docs/GAME-PORT.md — so `MARKET_WEIGHT` and
 * `PLAY_RULES.gameLinesInformationOnly` are deliberately untouched. This is a
 * better displayed number, not a reason to bet.
 *
 * Two entries are zero on purpose and are not dead code:
 *
 *   - `top4Exp` 0. The first inning was fitted on first-inning runs alone
 *     (7,062 half-innings). The exponent on the top four's OPS came out at
 *     zero and the exponent on the starter's quality at 1.4: the first inning
 *     is more about the arm than an average inning is, and no more about the
 *     bats. The term is kept at its measured weight so the next person can see
 *     it was tried rather than forgotten.
 *   - `defExp`, `umpExp`, bullpen availability and rest/travel are absent
 *     entirely. Each was built, fitted on two seasons and measured; none
 *     earned its place. The table in docs/GAME-EDGE-SEARCH.md says what each
 *     was worth.
 */
export const GAME_INPUTS = {
  // ── team offence ──────────────────────────────────────────────────────────
  offPriorGames: 70, // games of league-average prior (was a flat 25)
  offPriorSeasonGames: 30, // games of LAST season's line, at its own league level
  offExp: 0.9,
  // ── the posted card ───────────────────────────────────────────────────────
  lineupExp: 1.7, // runs ~ OPS^1.7, unchanged
  top4Exp: 0, // the top four, in the first inning only — measured at zero
  lineupClamp: 0.05, // +-5% (was +-10%)
  firstInningAdjust: 1.03,
  // ── the starting pitcher, regressed component by component ────────────────
  spKPriorBF: 10, // strikeouts are taken almost at face value
  spBbPriorBF: 400,
  spHrPriorBF: 4000, // home runs are regressed almost to nothing
  spEraPriorIP: 60,
  spPriorSeasonWeight: 0.6,
  spEraWeight: 0.5, // ERA half against the component (FIP-style) half
  spExp: 1,
  spLo: 0.55,
  spHi: 1.7,
  spFirstInningExp: 1.4, // how much of his edge is already showing in inning one
  spRestCoef: 0.02, // per day of rest away from five
  // ── bullpen (unchanged from v36) ──────────────────────────────────────────
  bpPriorIP: 120,
  bpLo: 0.7,
  bpHi: 1.4,
  // ── environment ───────────────────────────────────────────────────────────
  parkExp: 1.5, // the park wants to be STRONGER, not damped to 0.7
  tempCoef: 0.004, // per degree F above 72 (was 0.0025)
  windCoef: 0.004, // per mph, signed by direction
};

/**
 * Which way the wind plays. MLB reports it as free text — "8 mph, Out To LF",
 * "4 mph, In From CF", "11 mph, L To R" — so out of the park is +1, in from it
 * -1, and anything across the field, calm or unknown is 0.
 *
 * A forecast that carries speed but no direction therefore contributes
 * nothing, which is exactly right: wind blowing in is worth the opposite of
 * wind blowing out, so an unsigned speed is not weak information, it is none.
 */
export function windSign(dir) {
  const d = String(dir || '').toLowerCase();
  if (d.startsWith('out')) return 1;
  if (d.startsWith('in')) return -1;
  return 0;
}

/**
 * A pitcher's rate components from a statsapi season line. Returns null when
 * the payload has no batters faced, which is the signal to fall back to the
 * older whole-line regression.
 */
function rateLine(stat) {
  if (!stat) return null;
  const ip = innings(stat.inningsPitched);
  const bf = num(stat.battersFaced);
  if (!(ip > 0) || !(bf > 0)) return null;
  return {
    ip,
    bf,
    er: stat.earnedRuns || 0,
    hr: stat.homeRuns || 0,
    bb: (stat.baseOnBalls || 0) + (stat.hitByPitch || 0),
    k: stat.strikeOuts || 0,
  };
}

/** Does `league` carry the per-batter-faced starter rates the new fit needs? */
const hasStarterRates = (league) =>
  league?.spKRate > 0 && league?.spBbRate > 0 && league?.spHrRate > 0 && league?.spBfPerIp > 0;

/**
 * The starter's runs allowed per nine, regressed COMPONENT BY COMPONENT.
 *
 * Strikeouts settle down long before home runs do. The older treatment shrank
 * the finished ERA/FIP blend as one lump with 60 innings of league average,
 * which over-trusts a hot home-run rate and under-trusts a real strikeout
 * rate; the fit put 10 batters faced of prior on strikeouts and 4,000 on home
 * runs, which is roughly what the sabermetrics would predict.
 *
 * Returns null when the inputs are not there, so the caller can fall back.
 */
function starterComponentRa9(starter, league, park) {
  if (!starter || !hasStarterRates(league)) return null;
  const cur = rateLine(starter.s26);
  if (!cur) return null;
  const prior = rateLine(starter.s25);
  const w = GAME_INPUTS.spPriorSeasonWeight;
  const sum = (f) => cur[f] + (prior ? w * prior[f] : 0);
  const bf = sum('bf');
  const ip = sum('ip');
  const reg = (count, priorBf, leagueRate) => (count + priorBf * leagueRate) / (bf + priorBf);
  const kRate = reg(sum('k'), GAME_INPUTS.spKPriorBF, league.spKRate);
  const bbRate = reg(sum('bb'), GAME_INPUTS.spBbPriorBF, league.spBbRate);
  const hrRate = reg(sum('hr'), GAME_INPUTS.spHrPriorBF, league.spHrRate);
  // Rates per batter faced back to a per-inning FIP, through the league's own
  // batters per inning so the units match the constant.
  const fip = (13 * hrRate + 3 * bbRate - 2 * kRate) * league.spBfPerIp + league.fipConstant;
  const eraRaw = (9 * sum('er')) / ip;
  const era = (ip * eraRaw + GAME_INPUTS.spEraPriorIP * league.spRa9) / (ip + GAME_INPUTS.spEraPriorIP);
  // The pitcher's own line carries his home park; the league prior does not.
  let ra9 = (GAME_INPUTS.spEraWeight * era + (1 - GAME_INPUTS.spEraWeight) * fip) / park;
  if (GAME_INPUTS.spRestCoef && starter.restDays != null) {
    ra9 *= 1 + GAME_INPUTS.spRestCoef * (clamp(starter.restDays, 3, 9) - 5);
  }
  return ra9;
}

/**
 * Everything the game model needs, derived from the slate the app already
 * loads. Pure: no I/O.
 *
 * EVERY new field is optional and every one of them degrades to the v36
 * behaviour on its own, because the board must survive a card that is not
 * posted and a forecast that does not carry direction:
 *
 *   `offensePrior` / `league.priorSeasonRpg` missing  -> last season counts as
 *        league average at the same weight, which is what a missing prior
 *        means; the team is still regressed by the full 100 games.
 *   `lineupTop4OpsRatio` missing                      -> 1 (and the fitted
 *        exponent on it is 0 anyway).
 *   `lineupOpsRatio` missing                          -> 1, as before.
 *   `starter.s26.battersFaced` or the league per-BF
 *        rates missing                                -> the v36 whole-line
 *        ERA/FIP regression, `runsAllowedTalent`.
 *   `starter.restDays` missing                        -> no rest term.
 *   `wx.windDir` missing or across the field          -> no wind term, which
 *        is the v36 behaviour exactly, and no park-specific wind term either.
 *   a venue with no row in `PARK_WIND`                -> no park-specific wind
 *        term. Only Wrigley has one; see src/lib/parks.js.
 *   `wx.tempF` missing                                -> no temperature term.
 *
 * @param {object} input
 * @param {object} input.away / input.home  per-side context:
 *   {
 *     offense:  { runs, gamesPlayed, ops },            team season hitting
 *     offensePrior: { runs, gamesPlayed } | null,      last season's, optional
 *     homePark: string,                                team's own home venue
 *     lineupOpsRatio: number|null,                     lineup OPS / team OPS, slate-centred
 *     lineupTop4OpsRatio: number|null,                 the same for the top four
 *     starter:  { s26, s25, projIP, restDays } | null, this side's starter
 *     bullpen:  object|null,                           team relief split (season)
 *   }
 * @param {object} input.league
 *   { rpg, spRa9, rpRa9, allRa9, fipConstant,
 *     spKRate?, spBbRate?, spHrRate?, spBfPerIp?, priorSeasonRpg? }
 * @param {string} input.park   venue name
 * @param {object} [input.wx]   { indoor, tempF, windMph, windDir }
 */
export function projectGame({ away, home, league, park, wx }) {
  const P = GAME_INPUTS;
  // Park, weather, and — for the one park that has earned one — the park's own
  // answer to the wind. `parkWindFactor` is 1 for every other venue and for
  // every game whose wind is calm, across the field, indoors or unreported, so
  // this line is the v37 line unchanged except at Wrigley with a reading.
  const env = parkFactor(park, 'runs', P.parkExp)
    * weatherFactor(wx)
    * parkWindFactor(park, wx && !wx.indoor ? windSign(wx.windDir) : 0);

  // Half of a team's games are in its own park, and its season lines carry that
  // park in both directions: Rockies hitters look better and Rockies pitchers
  // look worse than they are. Both are neutralised with the same factor, so the
  // park is counted once — for tonight's venue, through `env`.
  const ownPark = (side) => 0.5 + 0.5 * parkFactor(side.homePark, 'runs', P.parkExp);

  /**
   * Tonight's card against the team's season line. Both ratios arrive already
   * centred across the slate (see loadSlate): nine regulars always out-hit a
   * season line that carries the bench, so the raw ratio has a LEVEL in it,
   * and a level is not information.
   */
  const lineupFactor = (ratio, exp) =>
    ratio ? clamp(ratio ** exp, 1 - P.lineupClamp, 1 + P.lineupClamp) : 1;

  /**
   * Team offence: this season's park-neutral runs per game, LAST season's at
   * its own league level, and a league-average prior, each weighted by how
   * many games it is worth. In April last season is nearly all that is known;
   * in September it is a footnote, and the weights do that on their own.
   */
  const offenseIndex = (side) => {
    const o = side.offense;
    if (!o?.gamesPlayed || o.runs == null) return { value: 1, parts: {} };
    const ownParkFactor = ownPark(side);
    const raw = o.runs / o.gamesPlayed / ownParkFactor / league.rpg;
    let weighted = o.gamesPlayed * raw;
    let den = o.gamesPlayed;
    if (P.offPriorSeasonGames > 0) {
      const prior = side.offensePrior;
      // Last year is expressed against LAST year's league by dividing by its
      // own runs per game; using this year's would import last year's run
      // environment along with the team's share of it.
      const usable = prior?.gamesPlayed > 0 && prior.runs != null && league.priorSeasonRpg > 0;
      const weight = usable
        ? Math.min(P.offPriorSeasonGames, prior.gamesPlayed)
        : P.offPriorSeasonGames;
      weighted += weight * (usable
        ? prior.runs / prior.gamesPlayed / ownParkFactor / league.priorSeasonRpg
        : 1);
      den += weight;
    }
    weighted += P.offPriorGames;
    den += P.offPriorGames;
    const shrunk = (weighted / den) ** P.offExp;
    const lineup = lineupFactor(side.lineupOpsRatio, P.lineupExp);
    // The first inning is batted by the top of the order, not by the nine.
    const top4 = lineupFactor(side.lineupTop4OpsRatio ?? side.lineupOpsRatio, P.top4Exp);
    return {
      value: shrunk * lineup,
      first: shrunk * top4 * P.firstInningAdjust,
      parts: { season: shrunk, lineup, top4 },
    };
  };

  const pitchingIndex = (side) => {
    const ownParkFactor = ownPark(side);
    const component = starterComponentRa9(side.starter, league, ownParkFactor);
    const starter = component != null
      ? { ra9: component, ip: innings(side.starter.s26?.inningsPitched) }
      : side.starter
        ? runsAllowedTalent(
            [
              { stat: side.starter.s26, weight: 1 },
              { stat: side.starter.s25, weight: 0.6 },
            ],
            league.spRa9,
            60,
            league.fipConstant,
            ownParkFactor,
          )
        : { ra9: league.spRa9, ip: 0 };
    const bullpen = side.bullpen
      ? runsAllowedTalent([{ stat: side.bullpen, weight: 1 }], league.rpRa9, P.bpPriorIP, league.fipConstant, ownParkFactor)
      : { ra9: league.rpRa9, ip: 0 };
    return {
      starter: clamp((starter.ra9 / league.allRa9) ** P.spExp, P.spLo, P.spHi),
      bullpen: clamp(bullpen.ra9 / league.allRa9, P.bpLo, P.bpHi),
      starterRa9: starter.ra9,
      bullpenRa9: bullpen.ra9,
      // No probable, or a probable with no workload estimate: assume an
      // average-length start rather than a bullpen game. Flagged below.
      projIP: clamp(side.starter?.projIP ?? 5.2, 1, 9),
    };
  };

  const off = { away: offenseIndex(away), home: offenseIndex(home) };
  const pit = { away: pitchingIndex(away), home: pitchingIndex(home) };

  // The measured league rates, scaled to this season's scoring level.
  const level = league.rpg / CALIBRATION_RPG;

  const halfMeans = (base, batting, fielding) =>
    base.map((leagueMean, i) => {
      const starterShare = clamp(fielding.projIP - i, 0, 1);
      // The first inning is the starter's best: he has not been seen yet.
      // `spFirstInningExp` says how much of his edge is already showing, and
      // it fitted at 1.4 — more than an average inning, not less.
      const sp = i === 0 ? fielding.starter ** P.spFirstInningExp : fielding.starter;
      const pitching = starterShare * sp + (1 - starterShare) * fielding.bullpen;
      const offence = i === 0 ? (batting.first ?? batting.value) : batting.value;
      return leagueMean * level * offence * pitching * env;
    });

  const awayHalfMeans = halfMeans(AWAY_HALF_MEANS, off.away, pit.home);
  const homeHalfMeans = halfMeans(HOME_HALF_MEANS, off.home, pit.away).map((m) => m * HOME_ADJUST);
  const extraBase = EXTRA_INNING_PMF.reduce((s, p, k) => s + p * k, 0);
  const scoring = {
    awayHalfMeans,
    homeHalfMeans,
    // EXTRA_INNING_PMF was also measured on away halves, so away is taken as
    // measured and home carries the full home-to-away ratio.
    awayExtraMean: extraBase * off.away.value * pit.home.bullpen * env,
    homeExtraMean: extraBase * off.home.value * pit.away.bullpen * env * HOME_EXTRA_RATIO * HOME_ADJUST,
  };
  const grid = uncertainScoreGrid(scoring);
  const summary = summarizeGrid(grid);
  const nrfiProb = firstInningScoreless(scoring);

  const flags = [];
  if (!away.starter || !home.starter) flags.push('NO PROBABLE');
  if (!away.offense?.gamesPlayed || !home.offense?.gamesPlayed) flags.push('NO TEAM STATS');

  return {
    pHome: summary.pHome,
    pAway: 1 - summary.pHome,
    projAway: summary.meanAway,
    projHome: summary.meanHome,
    projTotal: summary.meanAway + summary.meanHome,
    fairHomeOdds: probToAmerican(summary.pHome),
    fairAwayOdds: probToAmerican(1 - summary.pHome),
    total: (line) => totalProbs(summary, line),
    spread: (homeSpread) => spreadProbs(summary, homeSpread),
    // The number where the model's over and under are closest to 50/50.
    fairTotal: medianLine(summary),
    // First inning, from the same inning-one scoring rates and the same
    // uncertainty as the full game, so NRFI can never contradict the total.
    nrfi: {
      nrfiProb,
      yrfiProb: 1 - nrfiProb,
      fairNrfiOdds: probToAmerican(nrfiProb),
      fairYrfiOdds: probToAmerican(1 - nrfiProb),
    },
    inputs: {
      env,
      offense: { away: off.away, home: off.home },
      pitching: { away: pit.away, home: pit.home },
    },
    flags,
  };
}

/** Half-point line nearest an even-money total. */
function medianLine(summary) {
  let best = 8.5;
  let bestGap = Infinity;
  for (let line = 4.5; line <= 16.5; line += 1) {
    const gap = Math.abs(totalProbs(summary, line).over - 0.5);
    if (gap < bestGap) {
      best = line;
      bestGap = gap;
    }
  }
  return best;
}

/**
 * Temperature and wind on run scoring.
 *
 * Temperature is about +4% per 10F above 72, clamped — refitted from the
 * 0.0025 this used to carry, and the single largest term in the whole
 * per-game fit (16.2 nats).
 *
 * Wind is now used, which the note here used to say it could not be. The
 * reason it could not was real and has not gone away: an unsigned speed is
 * worthless, because blowing in is worth the opposite of blowing out. What
 * changed is that the slate now carries a DIRECTION when MLB publishes one
 * ("8 mph, Out To LF"), so the speed can be signed. When it cannot be —
 * a forecast with speed only, a wind across the field, a park with no
 * reading — `windSign` is 0 and this returns exactly what v36 returned.
 *
 * @param {object} [wx] { indoor, tempF, windMph, windDir }
 */
export function weatherFactor(wx) {
  if (!wx || wx.indoor) return 1;
  let factor = 1;
  if (wx.tempF != null) {
    factor *= clamp(1 + GAME_INPUTS.tempCoef * (wx.tempF - 72), 0.94, 1.06);
  }
  const sign = windSign(wx.windDir);
  if (sign && wx.windMph != null) {
    factor *= clamp(1 + GAME_INPUTS.windCoef * sign * wx.windMph, 0.9, 1.1);
  }
  return factor;
}
