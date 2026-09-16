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
 * from 2026 regular-season linescores (tools/fit-game-model.mjs re-derives
 * them). The team inputs are ordinary season stats, shrunk toward league
 * average. Nothing here is fitted against betting prices.
 */

import { clamp } from '../lib/probability.js';
import { parkFactor } from '../lib/parks.js';
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
 * Runs scored in one EXTRA half-inning, which starts with a runner on second.
 * 267 away extra halves, 2026. Mean 1.21. The tail beyond 6 is sparse in the
 * sample and is smoothed geometrically rather than taken at face value.
 */
export const EXTRA_INNING_PMF = [
  0.3933, 0.2809, 0.1685, 0.0936, 0.0375, 0.015, 0.0058, 0.0026, 0.0012, 0.0006,
  0.001,
];

/**
 * Mean runs per half-inning by inning, relative to the regulation average. The
 * first time through the order and the second-inning bottom of the lineup
 * show up as a dip; the third time through (innings 4-5) as a peak.
 */
export const INNING_PROFILE = [0.454, 0.438, 0.466, 0.499, 0.526, 0.491, 0.483, 0.491, 0.468].map(
  (m) => m / 0.4794,
);

/** League runs per team per game when the tables above were measured. */
export const CALIBRATION_RPG = 4.4932;

/**
 * Home-field advantage, as a multiplier on a neutral scoring rate: the home
 * offence gets x HOME_EDGE, the away offence / HOME_EDGE.
 *
 * The four constants HOME_EDGE, WALKOFF_EXACT, SIGMA_SHARED and SIGMA_TEAM_TOTAL
 * are fitted JOINTLY by tools/fit-game-model.mjs against 2,271 completed 2026
 * games. Two league-average teams in a neutral park then reproduce:
 *
 *                        model    actual
 *     home win           52.83%   52.88%
 *     home wins by 1     16.84%   16.86%
 *     away wins by 1     11.50%   10.88%
 *     home -1.5 covers   35.98%   36.02%
 *     away -1.5 covers   35.67%   36.24%
 *     over 7.5           57.23%   57.11%
 *     over 8.5           49.66%   49.10%
 *     over 9.5           39.87%   40.11%
 *     over 10.5          33.37%   33.38%
 *     goes to extras      9.78%    8.72%   <- the one visible misfit
 *
 * The extras rate runs a point high: the model still produces slightly too
 * many level games after nine. Its effect on the totals above is already
 * inside the fit.
 */
export const HOME_EDGE = 1.036;

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
    grid = scoreHalf(grid, tiltPmf(HALF_INNING_PMF, awayHalfMeans[inning]), false);
    grid = scoreHalf(grid, tiltPmf(HALF_INNING_PMF, homeHalfMeans[inning]), true);
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
 * tools/fit-game-model.mjs, jointly with HOME_EDGE and WALKOFF_EXACT.
 */
export const SIGMA_SHARED = 0;
export const SIGMA_TEAM_TOTAL = 0.23;

/**
 * How much of that 0.23 the per-game inputs already explain.
 *
 * The league fit uses league-average teams, so its sigma absorbs every source
 * of game-to-game variation, including team quality, starters and parks — which
 * `projectGame` models explicitly. Counting that spread twice would make every
 * game look closer to a coin flip than it is. The standard deviation of the log
 * scoring rate the inputs produce across a slate is measured by
 * tools/fit-game-model.mjs --explained; only the remainder is integrated here.
 */
export const EXPLAINED_TEAM_SD = 0.12;
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
export function runsAllowedTalent(seasons, leagueRa9, priorInnings, fipConstant = 3.1) {
  const { ip, er, fipNum } = pitchingTotals(seasons);
  if (ip <= 0) return { ra9: leagueRa9, ip: 0 };
  const era = (9 * er) / ip;
  const fip = fipNum / ip + fipConstant;
  const raw = 0.5 * era + 0.5 * fip;
  return { ra9: (ip * raw + priorInnings * leagueRa9) / (ip + priorInnings), ip };
}

/**
 * Everything the game model needs, derived from the slate the app already
 * loads. Pure: no I/O.
 *
 * @param {object} input
 * @param {object} input.away / input.home  per-side context:
 *   {
 *     offense:  { runs, gamesPlayed, ops },          team season hitting
 *     homePark: string,                                team's own home venue
 *     lineupOpsRatio: number|null,                     lineup OPS / team OPS, slate-centred
 *     starter:  { s26, s25, projIP } | null,           this side's starter
 *     bullpen:  object|null,                           team relief split (season)
 *   }
 * @param {object} input.league { rpg, spRa9, rpRa9, allRa9, fipConstant }
 * @param {string} input.park   venue name
 * @param {object} [input.wx]   { indoor, tempF }
 */
export function projectGame({ away, home, league, park, wx }) {
  const env = parkFactor(park, 'runs', 0.7) * weatherFactor(wx);

  const offenseIndex = (side) => {
    const o = side.offense;
    if (!o?.gamesPlayed || o.runs == null) return { value: 1, parts: {} };
    const raw = o.runs / o.gamesPlayed / ownPark(side) / league.rpg;
    const shrunk = (o.gamesPlayed * raw + 25) / (o.gamesPlayed + 25);
    // Tonight's nine against the team's season line. Runs scale with roughly
    // the square of OPS, damped here to 1.7 and clamped to +-10% because a
    // projected lineup is a guess. `lineupOpsRatio` arrives already centred
    // across the slate (see loadSlate), because nine regulars always out-hit a
    // season line that includes the bench.
    const lineup = side.lineupOpsRatio ? clamp(side.lineupOpsRatio ** 1.7, 0.9, 1.1) : 1;
    return { value: shrunk * lineup, parts: { season: shrunk, lineup } };
  };

  // Half of a team's games are in its own park, and its season lines carry that
  // park in both directions: Rockies hitters look better and Rockies pitchers
  // look worse than they are. Both are neutralised with the same factor, so the
  // park is counted once — for tonight's venue, through `env`.
  const ownPark = (side) => 0.5 + 0.5 * parkFactor(side.homePark, 'runs', 0.7);

  const pitchingIndex = (side) => {
    const starter = side.starter
      ? runsAllowedTalent(
          [
            { stat: side.starter.s26, weight: 1 },
            { stat: side.starter.s25, weight: 0.6 },
          ],
          league.spRa9,
          60,
          league.fipConstant,
        )
      : { ra9: league.spRa9, ip: 0 };
    const bullpen = side.bullpen
      ? runsAllowedTalent([{ stat: side.bullpen, weight: 1 }], league.rpRa9, 120, league.fipConstant)
      : { ra9: league.rpRa9, ip: 0 };
    const park = ownPark(side);
    return {
      starter: clamp(starter.ra9 / park / league.allRa9, 0.55, 1.7),
      bullpen: clamp(bullpen.ra9 / park / league.allRa9, 0.7, 1.4),
      starterRa9: starter.ra9,
      bullpenRa9: bullpen.ra9,
      // No probable, or a probable with no workload estimate: assume an
      // average-length start rather than a bullpen game. Flagged below.
      projIP: clamp(side.starter?.projIP ?? 5.2, 1, 9),
    };
  };

  const off = { away: offenseIndex(away), home: offenseIndex(home) };
  const pit = { away: pitchingIndex(away), home: pitchingIndex(home) };

  // Neutral half-inning rate. The measured 0.4794 is an AWAY rate, so the away
  // penalty is taken back out; the league's current scoring level scales it.
  const perHalf = (league.rpg / CALIBRATION_RPG) * 0.4794 * HOME_EDGE;

  const halfMeans = (batting, fielding, homeAdv) =>
    INNING_PROFILE.map((profile, i) => {
      const starterShare = clamp(fielding.projIP - i, 0, 1);
      const pitching = starterShare * fielding.starter + (1 - starterShare) * fielding.bullpen;
      return perHalf * profile * batting.value * pitching * env * homeAdv;
    });

  const awayHalfMeans = halfMeans(off.away, pit.home, 1 / HOME_EDGE);
  const homeHalfMeans = halfMeans(off.home, pit.away, HOME_EDGE);
  const extraBase = EXTRA_INNING_PMF.reduce((s, p, k) => s + p * k, 0);
  const scoring = {
    awayHalfMeans,
    homeHalfMeans,
    // EXTRA_INNING_PMF was also measured on away halves, so away is taken as
    // measured and home carries the full home-to-away ratio.
    awayExtraMean: extraBase * off.away.value * pit.home.bullpen * env,
    homeExtraMean: extraBase * off.home.value * pit.away.bullpen * env * HOME_EDGE ** 2,
  };
  const grid = uncertainScoreGrid(scoring);
  const summary = summarizeGrid(grid);

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
 * Temperature on run scoring: about +2.5% per 10F above 72, clamped. Weaker
 * than the batter home-run term because most runs are not fly balls. Wind is
 * not used — the forecast has speed but not direction relative to the field,
 * and wind blowing in is worth the opposite of wind blowing out.
 */
export function weatherFactor(wx) {
  if (!wx || wx.indoor || wx.tempF == null) return 1;
  return clamp(1 + 0.0025 * (wx.tempF - 72), 0.94, 1.06);
}
