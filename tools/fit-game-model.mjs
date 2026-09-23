// Fit the four free constants in src/model/game.js — HOME_ADJUST, WALKOFF_EXACT,
// SIGMA_SHARED and SIGMA_TEAM — against league scoring measured from completed
// games. Usage:
//
//   node tools/fit-game-model.mjs [season-schedule.json]
//
// With a schedule file (statsapi /api/v1/schedule?sportId=1&gameType=R&
// startDate=..&endDate=..&hydrate=linescore) the targets are re-measured from
// it; otherwise the 2026 figures below are used.
//
// These are league-level fits on league-average teams. The sigmas therefore
// absorb ALL game-to-game variation, including the part the per-game inputs
// explain (team quality, starters, parks). projectGame keeps only the residual
// part — see SIGMA_TEAM_TOTAL / EXPLAINED_TEAM_SD in game.js.
import fs from 'node:fs';
import {
  uncertainScoreGrid, summarizeGrid, totalProbs, spreadProbs, firstInningScoreless,
  AWAY_HALF_MEANS, HOME_HALF_MEANS, EXTRA_INNING_PMF,
} from '../src/model/game.js';

export function measure(file) {
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  const g = [];
  for (const d of s.dates) for (const x of d.games) {
    const ls = x.linescore;
    if (x.status?.codedGameState !== 'F' || !ls?.teams || (ls.scheduledInnings || 9) !== 9) continue;
    const first = ls.innings?.[0];
    g.push({ a: ls.teams.away.runs, h: ls.teams.home.runs, inn: ls.innings?.length || 0,
      nrfi: first && first.away?.runs === 0 && first.home?.runs === 0 ? 1 : 0 });
  }
  return targetsFrom(g);
}

/**
 * The same league rates, measured from any list of {a, h, inn, nrfi} games.
 * tools/fit-game-v2.mjs calls this with the FIT window only, so the four
 * constants can be refitted without validate or holdout in them.
 */
export function targetsFrom(g) {
  const m = (f) => g.reduce((s, r) => s + f(r), 0) / g.length;
  const mt = m((r) => r.a + r.h);
  return {
    n: g.length,
    nrfi: m((r) => r.nrfi),
    homeWin: m((r) => (r.h > r.a ? 1 : 0)), extras: m((r) => (r.inn > 9 ? 1 : 0)),
    homeBy1: m((r) => (r.h - r.a === 1 ? 1 : 0)), awayBy1: m((r) => (r.a - r.h === 1 ? 1 : 0)),
    homeCover15: m((r) => (r.h - r.a >= 2 ? 1 : 0)), awayCover15: m((r) => (r.a - r.h >= 2 ? 1 : 0)),
    over75: m((r) => (r.a + r.h > 7.5 ? 1 : 0)), over85: m((r) => (r.a + r.h > 8.5 ? 1 : 0)),
    over95: m((r) => (r.a + r.h > 9.5 ? 1 : 0)), over105: m((r) => (r.a + r.h > 10.5 ? 1 : 0)),
    meanAway: m((r) => r.a), meanHome: m((r) => r.h),
    totalVarMean: m((r) => (r.a + r.h - mt) ** 2) / mt,
  };
}

export const TARGET_2026_FULL = {
  n: 2271, nrfi: 0.4954, homeWin: 0.5288, homeBy1: 0.1686, awayBy1: 0.1088, extras: 0.0872, homeCover15: 0.3602, awayCover15: 0.3624,
  over75: 0.5711, over85: 0.4910, over95: 0.4011, over105: 0.3338,
  meanAway: 4.456, meanHome: 4.530, totalVarMean: 2.2905,
};

const extraBase = EXTRA_INNING_PMF.reduce((s, p, k) => s + p * k, 0);

export function run(he, wo, sg, st) {
  let extras = 0;
  const scoring = {
    awayHalfMeans: AWAY_HALF_MEANS, homeHalfMeans: HOME_HALF_MEANS.map((m) => m * he),
    awayExtraMean: extraBase, homeExtraMean: extraBase * 1.089 * he,
    walkoffExact: wo, onRegulationEnd: (t) => { extras = t; },
  };
  const grid = uncertainScoreGrid(scoring, { sigmaShared: sg, sigmaTeam: st });
  const nrfi = firstInningScoreless(scoring, { sigmaShared: sg, sigmaTeam: st });
  const s = summarizeGrid(grid);
  const mt = s.meanAway + s.meanHome;
  let v = 0;
  s.total.forEach((p, t) => { v += p * (t - mt) ** 2; });
  return {
    nrfi,
    homeWin: s.pHome, extras, homeBy1: s.margin.get(1) || 0, awayBy1: s.margin.get(-1) || 0, homeCover15: spreadProbs(s, -1.5).home,
    awayCover15: spreadProbs(s, 1.5).away,
    over75: totalProbs(s, 7.5).over, over85: totalProbs(s, 8.5).over,
    over95: totalProbs(s, 9.5).over, over105: totalProbs(s, 10.5).over,
    meanAway: s.meanAway, meanHome: s.meanHome, totalVarMean: v / mt,
  };
}

// Probability targets weighted by their binomial precision; means and the
// variance ratio scaled to comparable size.
export function loss(r, TARGET) {
  let l = 0;
  for (const k of ['nrfi', 'homeWin', 'homeBy1', 'awayBy1', 'extras', 'homeCover15', 'awayCover15', 'over75', 'over85', 'over95', 'over105']) {
    const p = TARGET[k];
    l += (r[k] - p) ** 2 / (p * (1 - p) / TARGET.n);
  }
  l += (r.meanAway - TARGET.meanAway) ** 2 / (0.05 ** 2);
  l += (r.meanHome - TARGET.meanHome) ** 2 / (0.05 ** 2);
  l += (r.totalVarMean - TARGET.totalVarMean) ** 2 / (0.1 ** 2);
  return l;
}

/** Coarse grid then a local refinement, exactly as the CLI has always done. */
export function fitConstants(TARGET) {
  let best = null;
  const consider = (he, wo, sg, st) => {
    const r = run(he, wo, sg, st);
    const l = loss(r, TARGET);
    if (!best || l < best.l) best = { l, he, wo, sg, st, r };
  };
  for (const sg of [0, 0.05, 0.1, 0.15, 0.2])
    for (const st of [0, 0.1, 0.15, 0.2, 0.25, 0.3])
      for (const he of [0.96, 0.98, 1.0, 1.02, 1.04])
        for (const wo of [0.3, 0.45, 0.6, 0.75, 0.9]) consider(he, wo, sg, st);
  const c = { ...best };
  for (let sg = Math.max(0, c.sg - 0.04); sg <= c.sg + 0.04; sg += 0.02)
    for (let st = Math.max(0, c.st - 0.04); st <= c.st + 0.04; st += 0.02)
      for (let he = c.he - 0.008; he <= c.he + 0.008; he += 0.004)
        for (let wo = Math.max(0.1, c.wo - 0.1); wo <= Math.min(1, c.wo + 0.1); wo += 0.05) consider(he, wo, sg, st);
  return best;
}

if (process.argv[1] && process.argv[1].endsWith('fit-game-model.mjs')) {
  const TARGET = process.argv[2] ? measure(process.argv[2]) : TARGET_2026_FULL;
  const best = fitConstants(TARGET);
  console.log(`games ${TARGET.n}`);
  console.log(`HOME_ADJUST ${best.he.toFixed(3)}  WALKOFF_EXACT ${best.wo.toFixed(2)}  ` +
    `SIGMA_SHARED ${best.sg.toFixed(2)}  SIGMA_TEAM ${best.st.toFixed(2)}  loss ${best.l.toFixed(1)}`);
  for (const k of Object.keys(best.r)) {
    console.log(`  ${k.padEnd(13)} model ${best.r[k].toFixed(4)}   actual ${TARGET[k].toFixed(4)}`);
  }
}
