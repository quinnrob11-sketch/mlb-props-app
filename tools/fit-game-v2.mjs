// Fit the improved game model on the FIT window, and score it on VALIDATE.
//
//   node tools/fit-game-v2.mjs --features .backtest-cache/features_2025.json \
//     --features .backtest-cache/features_2026.json --out .backtest-cache/params-v2.json
//
// Two stages, because they need different amounts of compute:
//
//   1. The expected runs for each side are a product of terms (offence,
//      starter, bullpen, park, weather, umpire, rest). Their coefficients are
//      fitted by Poisson maximum likelihood on the runs each team actually
//      scored — about 7,600 team-games in the FIT window. This costs no
//      convolution at all, so a coordinate search over thirty parameters is
//      seconds, not hours.
//   2. The four structural constants (HOME_ADJUST, WALKOFF_EXACT and the two
//      sigmas) are refitted by tools/fit-game-model.mjs against the league
//      rates measured on the FIT window ONLY — not the whole 2026 season the
//      shipped constants used, which would put validate and holdout inside
//      the fit. `EXPLAINED_TEAM_SD` is then measured as the spread of the
//      model's own projections, which is what it is defined to be.
//
// No price appears anywhere in this file.

import fs from 'node:fs';
import path from 'node:path';
import { argv } from './backtest-common.mjs';
import { targetsFrom, fitConstants } from './fit-game-model.mjs';
import {
  DEFAULT_PARAMS, buildLeagueContext, scoringInputs, expectedRuns, projectGameV2,
  projectGameV1FromRow,
} from './game-model-v2.mjs';

const has = (name) => process.argv.includes(`--${name}`);
const featureFiles = process.argv
  .map((a, i) => (a === '--features' ? process.argv[i + 1] : null))
  .filter(Boolean);
const OUT = argv('out', path.resolve('.backtest-cache/params-v2.json'));
const FIT_END = argv('fit-end', '2026-08-09');
const VAL_START = argv('val-start', '2026-08-10');
const VAL_END = argv('val-end', '2026-09-01');
const SWEEPS = Number(argv('sweeps', 3));
const CONFIG = argv('config', 'all');
const log = (s) => process.stderr.write(`${s}\n`);

const rows = [];
for (const f of featureFiles) rows.push(...JSON.parse(fs.readFileSync(f, 'utf8')).rows);
rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
log(`${rows.length} games loaded from ${featureFiles.length} files`);

const ctxByDate = buildLeagueContext(rows);

// Nine-inning, completed games only, and only once both teams have a season
// line worth reading. The first two weeks of a season are almost pure prior.
const usable = rows.filter(
  (r) => r.actual.scheduledInnings === 9
    && r.away.off?.gamesPlayed >= 10 && r.home.off?.gamesPlayed >= 10,
);
const FIT = usable.filter((r) => r.date <= FIT_END);
const VAL = usable.filter((r) => r.date >= VAL_START && r.date <= VAL_END);
const HOLD = usable.filter((r) => r.date > VAL_END);
log(`fit ${FIT.length}  validate ${VAL.length}  holdout ${HOLD.length} (holdout is NOT scored here)`);

// ── stage 1: the expected-runs regression ──────────────────────────────────

/** Poisson deviance of the runs each side actually scored. Lower is better. */
function poissonLoss(games, P) {
  let l = 0;
  let n = 0;
  for (const r of games) {
    const ctx = ctxByDate.get(r.date);
    const s = scoringInputs(r, ctx, P);
    const mA = s.awayHalfMeans.reduce((x, y) => x + y, 0);
    const mH = s.homeHalfMeans.reduce((x, y) => x + y, 0);
    l += mA - r.actual.away * Math.log(Math.max(1e-6, mA));
    l += mH - r.actual.home * Math.log(Math.max(1e-6, mH));
    n += 2;
  }
  return l / n;
}

/**
 * The search. Each parameter is swept over its own candidate list, keeping the
 * best; three passes are enough for the loss to stop moving in the fourth
 * decimal. Grid search rather than a gradient because several terms are
 * clamped, so the loss is not smooth.
 */
const SEARCH = {
  offPriorGames: [5, 10, 15, 20, 25, 35, 50, 70, 100, 140, 200],
  offPriorSeasonGames: [0, 10, 20, 30, 45, 60, 80, 120, 162],
  offExp: [0.6, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.8],
  lineupExp: [0, 0.5, 0.8, 1.2, 1.7, 2.2, 3.0, 4.0],
  lineupClamp: [0.05, 0.1, 0.15, 0.2, 0.3],
  spKPriorBF: [0, 10, 20, 40, 80, 150, 250, 400, 600, 900],
  spBbPriorBF: [0, 10, 30, 60, 100, 200, 400, 700, 1200],
  spHrPriorBF: [100, 200, 500, 900, 1500, 2500, 4000],
  spEraPriorIP: [5, 10, 20, 40, 60, 90, 140, 220],
  spPriorSeasonWeight: [0, 0.2, 0.4, 0.6, 0.8, 1.0, 1.3],
  spEraWeight: [0, 0.2, 0.35, 0.5, 0.65, 0.8, 1.0],
  spExp: [0.6, 0.8, 1.0, 1.2, 1.4, 1.7, 2.0],
  spRestCoef: [-0.03, -0.02, -0.01, 0, 0.01, 0.02, 0.03],
  bpPriorIP: [10, 30, 60, 120, 200, 350],
  bpRestedWeight: [0, 0.25, 0.5, 0.75, 1.0],
  bpFatigueCoef: [-0.02, -0.01, -0.005, 0, 0.005, 0.01, 0.02],
  parkExp: [0.4, 0.55, 0.7, 0.85, 1.0, 1.15, 1.3, 1.5, 1.8],
  tempCoef: [0, 0.001, 0.0025, 0.004, 0.006, 0.008],
  windCoef: [0, 0.001, 0.002, 0.004, 0.006, 0.009, 0.013],
  umpExp: [0, 0.25, 0.5, 0.75, 1.0, 1.5],
  umpPriorGames: [30, 60, 100, 200, 400],
  restCoef: [-0.08, -0.04, -0.02, -0.01, 0, 0.01, 0.02, 0.04, 0.08],
  cityCoef: [-0.08, -0.05, -0.03, -0.015, 0, 0.015, 0.03, 0.05, 0.08],
  defExp: [0, 0.5, 1.0, 1.5, 2.0],
  defPriorBF: [500, 1500, 3000, 6000],
  tzCoef: [-0.02, -0.015, -0.007, 0, 0.007, 0.015, 0.02],
  denseCoef: [-0.02, -0.015, -0.007, 0, 0.007, 0.015, 0.02],
};

/**
 * The first inning gets its own fit: it is one ninth of the runs, so the
 * game-level likelihood has almost no opinion about who bats in it or how much
 * of a starter's edge is already visible the first time through the order.
 * That is the whole question `KXMLBRFI` asks.
 */
const FIRST_SEARCH = {
  top4Exp: [-1.0, -0.5, 0, 0.5, 1.0, 1.7, 2.5, 3.5, 5.0],
  spFirstInningExp: [0, 0.3, 0.6, 1.0, 1.4, 1.8, 2.4],
  firstInningAdjust: [0.94, 0.97, 1.0, 1.03, 1.06],
};

/** Poisson deviance of the runs actually scored in the FIRST inning. */
function firstInningLoss(games, P) {
  let l = 0;
  let n = 0;
  for (const r of games) {
    if (r.actual.firstRuns == null || r.actual.firstAway == null) continue;
    const ctx = ctxByDate.get(r.date);
    const s = scoringInputs(r, ctx, P);
    const yA = r.actual.firstAway;
    const yH = r.actual.firstRuns - r.actual.firstAway;
    l += s.awayHalfMeans[0] - yA * Math.log(Math.max(1e-6, s.awayHalfMeans[0]));
    l += s.homeHalfMeans[0] - yH * Math.log(Math.max(1e-6, s.homeHalfMeans[0]));
    n += 2;
  }
  return l / n;
}

function sweepOver(P0, search, lossFn) {
  const P = { ...P0 };
  let best = lossFn(FIT, P);
  for (let sweep = 0; sweep < SWEEPS; sweep++) {
    for (const [key, candidates] of Object.entries(search)) {
      let bestVal = P[key];
      for (const v of candidates) {
        if (v === P[key]) continue;
        const l = lossFn(FIT, { ...P, [key]: v });
        if (l < best - 1e-9) { best = l; bestVal = v; }
      }
      P[key] = bestVal;
    }
    log(`  sweep ${sweep + 1}: loss ${best.toFixed(6)}`);
  }
  return { P, loss: best };
}

/**
 * Which terms a configuration is allowed to use. Anything not free stays at
 * `DEFAULT_PARAMS`, which is the shipped model's behaviour, so `v1refit` is
 * genuinely "the same inputs, constants refitted on FIT" and nothing else.
 */
const GROUPS = {
  offence: ['offPriorGames', 'offPriorSeasonGames', 'offExp'],
  park: ['parkExp'],
  starter: ['spKPriorBF', 'spBbPriorBF', 'spHrPriorBF', 'spEraPriorIP', 'spPriorSeasonWeight', 'spEraWeight', 'spExp', 'spRestCoef'],
  bullpen: ['bpPriorIP', 'bpRestedWeight', 'bpFatigueCoef'],
  lineup: ['lineupExp', 'lineupClamp'],
  weather: ['tempCoef', 'windCoef'],
  umpire: ['umpExp', 'umpPriorGames'],
  defence: ['defExp', 'defPriorBF'],
  rest: ['restCoef', 'cityCoef', 'tzCoef', 'denseCoef'],
};
const FIRST_GROUP = ['top4Exp', 'spFirstInningExp', 'firstInningAdjust'];

const CONFIGS = {
  // The control: the shipped inputs, with only the four structural constants
  // refitted on FIT. Any gain a richer configuration shows is measured
  // against this, not against the shipped constants that saw the holdout.
  v1refit: [],
  // The terms with a mechanism and a clear likelihood gain.
  core: ['offence', 'park', 'starter', 'lineup', 'weather'],
  // `core` without the weather terms. The feature table's weather is what was
  // RECORDED at first pitch, not the forecast that existed at the decision
  // time, so `core`'s weather term is the optimistic case; this is the
  // pessimistic one, and both are carried to the holdout.
  coreNoWx: ['offence', 'park', 'starter', 'lineup'],
  coreRest: ['offence', 'park', 'starter', 'lineup', 'weather', 'rest'],
  all: Object.keys(GROUPS),
};

const freeKeys = new Set();
for (const g of CONFIGS[CONFIG] ?? []) for (const k of GROUPS[g]) freeKeys.add(k);
const searchFor = (map) => Object.fromEntries(Object.entries(map).filter(([k]) => freeKeys.has(k)));
const firstSearch = CONFIG === 'v1refit' ? {} : FIRST_SEARCH;
log(`config ${CONFIG}: ${freeKeys.size} free mean parameters`);

const fitMeans = (P0) => sweepOver(P0, searchFor(SEARCH), poissonLoss);
const fitFirst = (P0) => sweepOver(P0, firstSearch, firstInningLoss);

log('stage 1: expected-runs regression on FIT');
let { P, loss: fitLoss } = fitMeans(DEFAULT_PARAMS);
log('stage 1b: the first inning, on first-inning runs');
let firstLoss;
({ P, loss: firstLoss } = fitFirst(P));

// ── stage 2: the structural constants, on FIT only ─────────────────────────
log('stage 2: league constants on the FIT window');
const fitTargets = targetsFrom(FIT.map((r) => ({
  a: r.actual.away, h: r.actual.home, inn: r.actual.innings,
  nrfi: r.actual.firstRuns === 0 ? 1 : 0,
})));
const constants = fitConstants(fitTargets);
P = { ...P, homeAdjust: constants.he, walkoffExact: constants.wo, sigmaShared: constants.sg, sigmaTeamTotal: constants.st };

// EXPLAINED_TEAM_SD is the spread of the model's own per-side projections: the
// part of the game-to-game variation the inputs already account for, which
// must not be integrated over a second time.
const logRuns = [];
for (const r of FIT) {
  const e = expectedRuns(r, ctxByDate.get(r.date), P);
  logRuns.push(Math.log(e.away), Math.log(e.home));
}
const mu = logRuns.reduce((a, b) => a + b, 0) / logRuns.length;
P.explainedTeamSd = Math.sqrt(logRuns.reduce((a, b) => a + (b - mu) ** 2, 0) / logRuns.length);
log(`  explainedTeamSd ${P.explainedTeamSd.toFixed(4)} (shipped 0.12)`);

// One more pass with the new structure in place.
log('stage 1 again, with the refitted constants');
({ P, loss: fitLoss } = fitMeans(P));
({ P, loss: firstLoss } = fitFirst(P));

// ── scoring ────────────────────────────────────────────────────────────────
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const logLoss = (p, y) => -(y ? Math.log(Math.max(1e-9, p)) : Math.log(Math.max(1e-9, 1 - p)));

/** Outcome-only scoring: no price is involved. */
export function scoreSet(games, params, project = projectGameV2) {
  const out = [];
  for (const r of games) {
    const m = project(r, ctxByDate.get(r.date), params);
    out.push({
      pHome: m.pHome,
      homeWin: r.actual.home > r.actual.away ? 1 : 0,
      over85: m.total(8.5).over,
      over85y: r.actual.away + r.actual.home > 8.5 ? 1 : 0,
      cover: m.spread(-1.5).home,
      covery: r.actual.home - r.actual.away >= 2 ? 1 : 0,
      nrfi: m.nrfi.nrfiProb,
      nrfiy: r.actual.firstRuns === 0 ? 1 : 0,
      hasNrfi: r.actual.firstRuns != null && !m.flags.includes('NO PROBABLE'),
      projTotal: m.projTotal,
      actualTotal: r.actual.away + r.actual.home,
      projMargin: m.projHome - m.projAway,
      actualMargin: r.actual.home - r.actual.away,
    });
  }
  const nr = out.filter((x) => x.hasNrfi);
  const pair = (p, y, list = out) => ({
    n: list.length,
    pred: mean(list.map((x) => x[p])),
    actual: mean(list.map((x) => x[y])),
    brier: mean(list.map((x) => (x[p] - x[y]) ** 2)),
    logLoss: mean(list.map((x) => logLoss(x[p], x[y]))),
  });
  return {
    n: out.length,
    homeWin: pair('pHome', 'homeWin'),
    over85: pair('over85', 'over85y'),
    homeCover15: pair('cover', 'covery'),
    nrfi: nr.length ? pair('nrfi', 'nrfiy', nr) : null,
    nrfiSpreadPts: nr.length
      ? { min: 100 * Math.min(...nr.map((x) => x.nrfi)), max: 100 * Math.max(...nr.map((x) => x.nrfi)),
          sd: 100 * Math.sqrt(mean(nr.map((x) => (x.nrfi - mean(nr.map((z) => z.nrfi))) ** 2))) }
      : null,
    totalMae: mean(out.map((x) => Math.abs(x.projTotal - x.actualTotal))),
    marginMae: mean(out.map((x) => Math.abs(x.projMargin - x.actualMargin))),
    pHomeSpreadPts: { min: 100 * Math.min(...out.map((x) => x.pHome)), max: 100 * Math.max(...out.map((x) => x.pHome)) },
  };
}

const report = {
  builtAt: new Date().toISOString(),
  config: CONFIG,
  configTerms: CONFIGS[CONFIG],
  windows: { fitEnd: FIT_END, valStart: VAL_START, valEnd: VAL_END },
  counts: { fit: FIT.length, validate: VAL.length, holdout: HOLD.length },
  fitPoissonLoss: fitLoss,
  fitFirstInningLoss: firstLoss,
  baselinePoissonLoss: poissonLoss(FIT, DEFAULT_PARAMS),
  baselineFirstInningLoss: firstInningLoss(FIT, DEFAULT_PARAMS),
  params: P,
  fitTargets,
  constants: { he: constants.he, wo: constants.wo, sg: constants.sg, st: constants.st, loss: constants.l },
};

if (!has('no-score')) {
  log('scoring FIT and VALIDATE (this runs the convolution on every game)');
  const v1 = (r, ctx) => projectGameV1FromRow(r, ctx);
  report.scores = {
    fit: scoreSet(FIT, P), validate: scoreSet(VAL, P),
    fitV1: scoreSet(FIT, P, v1), validateV1: scoreSet(VAL, P, v1),
  };

  // Ablations: one term at a time returned to what the shipped model does,
  // refit-free, so the number says what the TERM is worth, not what a refit is.
  const ABLATE = {
    priorSeasonOffence: { offPriorSeasonGames: 0 },
    componentStarter: { spKPriorBF: 60, spBbPriorBF: 60, spHrPriorBF: 60, spEraWeight: 0.5 },
    bullpenAvailability: { bpRestedWeight: 0, bpFatigueCoef: 0 },
    lineup: { lineupExp: 0 },
    firstInningTopOfOrder: { spFirstInningExp: 1, top4Exp: DEFAULT_PARAMS.lineupExp, firstInningAdjust: 1 },
    restAndTravel: { restCoef: 0, cityCoef: 0, tzCoef: 0, denseCoef: 0 },
    wind: { windCoef: 0 },
    umpire: { umpExp: 0 },
    defence: { defExp: 0 },
    temperature: { tempCoef: 0 },
  };
  report.ablations = {};
  for (const [name, override] of Object.entries(ABLATE)) {
    const Q = { ...P, ...override };
    report.ablations[name] = {
      fitPoissonLoss: poissonLoss(FIT, Q),
      validate: scoreSet(VAL, Q),
    };
    log(`  ablation ${name}: fit loss ${report.ablations[name].fitPoissonLoss.toFixed(6)}`);
  }
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
log(`wrote ${OUT}`);

const f = (x, d = 4) => (x == null ? '—' : x.toFixed(d));
console.log(`\nfit games ${FIT.length}, validate ${VAL.length}`);
console.log(`poisson loss on FIT: baseline(v1 defaults) ${f(report.baselinePoissonLoss, 6)} -> fitted ${f(fitLoss, 6)}`);
console.log('\nfitted parameters:');
for (const [k, v] of Object.entries(P)) {
  if (DEFAULT_PARAMS[k] !== v) console.log(`  ${k.padEnd(22)} ${String(v).padEnd(10)} (default ${DEFAULT_PARAMS[k]})`);
}
if (report.scores) {
  for (const [which, s] of Object.entries(report.scores)) {
    console.log(`\n=== ${which} (n=${s.n}) ===`);
    for (const k of ['homeWin', 'over85', 'homeCover15', 'nrfi']) {
      const o = s[k];
      if (o) console.log(`  ${k.padEnd(12)} pred ${(100 * o.pred).toFixed(2)}%  actual ${(100 * o.actual).toFixed(2)}%  brier ${f(o.brier)}  ll ${f(o.logLoss)}  (n=${o.n})`);
    }
    console.log(`  pHome spans ${s.pHomeSpreadPts.min.toFixed(1)}-${s.pHomeSpreadPts.max.toFixed(1)}%, NRFI spans ${s.nrfiSpreadPts ? `${s.nrfiSpreadPts.min.toFixed(1)}-${s.nrfiSpreadPts.max.toFixed(1)}% (sd ${s.nrfiSpreadPts.sd.toFixed(2)}pts)` : '—'}`);
    console.log(`  total MAE ${f(s.totalMae, 3)}  margin MAE ${f(s.marginMae, 3)}`);
  }
  console.log('\n=== ablations (validate Brier; + means the term helps) ===');
  const base = report.scores.validate;
  for (const [name, a] of Object.entries(report.ablations)) {
    const d = (k) => `${k} ${((a.validate[k].brier - base[k].brier) * 10000 >= 0 ? '+' : '')}${((a.validate[k].brier - base[k].brier) * 10000).toFixed(1)}`;
    console.log(`  ${name.padEnd(22)} fitLoss ${((a.fitPoissonLoss - fitLoss) * 1e6).toFixed(0).padStart(6)}e-6   ${d('homeWin')}  ${d('over85')}  ${d('homeCover15')}`);
  }
}
