// Fit the constants `PITCHER_FIT` carries, on the study's FIT split only.
//
//   node tools/pitcher-port-fit.mjs --cache .work/cache --out .work/portfit.json
//
// Why these are fitted here rather than lifted out of `.work/model.json`: the
// study's coefficients are attached to the study's own design matrix, and two
// of its opponent columns are not the columns the board has. Its `oppH` is hits
// per PLATE APPEARANCE over a pooled nine; `lineupOpponent` hands
// `projectPitcher` an `avg`, which is hits per AT BAT, and the two differ by
// exactly the walk rate — so a coefficient carried across would be reading a
// slightly different number than the one it was fitted on. Its opponent rates
// are also recency-weighted and pooled per batter, where the board's are the
// season to date. Fitting the four exponents against the quantities the board
// actually passes costs one Poisson regression and removes the question.
//
// The hyperparameters (tauRate, tauWork, offDays, sK, sBB, sH, sHR) are NOT
// re-searched here. They are the study's, reproduced by
// `node tools/pitcher-edge.mjs --stage fit` on this machine, and re-searching
// them against a second scoring rule would be a second bite at the same split.
//
// FIT is 2025 entire plus 2026 through 2026-08-09. Nothing later is read.

import fs from 'node:fs';
import path from 'node:path';
import { loadRaw, buildStarts, argOf } from './pitcher-data.mjs';
import { boardInput } from './pitcher-board.mjs';
import { poissonFit } from './pitcher-model2.mjs';
import { projectPitcher, PITCHER_FIT } from '../src/model/pitcher.js';
import { SPLIT, INNER, SCORE_LINES, scoreOutcomes, splitOf } from './pitcher-edge.mjs';
import { projectPitcherV1 } from './pitcher-model-v1.mjs';

const CACHE = argOf('cache', path.resolve('.work/cache'));
const OUT = argOf('out', path.resolve('.work/portfit.json'));
const L = (x) => Math.log(Math.max(1e-9, x));

/** Calibration that is the identity, so a run returns its RAW projections. */
const IDENTITY_CAL = Object.fromEntries(['k', 'outs', 'hits', 'bb', 'er'].map((m) => [m, [0, 1, 1]]));

const raw = await loadRaw({ cacheDir: CACHE, seasons: [2025, 2026], through: SPLIT.HOLD_END });
const starts = buildStarts(raw);
const lgCache = new Map();

const fitIdx = [];
for (let i = 0; i < starts.length; i++) if (splitOf(starts[i]) === 'fit') fitIdx.push(i);
const inner = (i) => starts[i].season < 2026 || starts[i].date <= INNER.A_END;
console.log(`FIT ${fitIdx.length} starts (inner-A ${fitIdx.filter(inner).length}, inner-B ${fitIdx.filter((i) => !inner(i)).length})`);

const inputs = new Map();
for (const i of fitIdx) inputs.set(i, boardInput(raw, starts[i], lgCache));

// ── 1. opponent exponents ───────────────────────────────────────────────────
//
// For each rate, `log E[stat] = log(bf) + log(rate with the legacy opponent
// factor divided back out) + a.log(oppK/lgK) + b.log(oppBB/lgBB)
// + c.log(oppAvg/lgAvg)`. The intercept is fitted and then thrown away: level
// belongs to the calibration step below, and leaving it in would have these
// three exponents carrying it.
function fitOpponent(usable, base = PITCHER_FIT) {
  const legacy = {
    k: (o, lg) => 1 + 0.4 * (o.kRate / lg.kRate - 1),
    bb: (o, lg) => 1 + 0.3 * (o.bbRate / lg.bbRate - 1),
    h: (o, lg) => 1 + 0.35 * (o.avg / lg.avg - 1),
    hr: () => 1,
  };
  const statOf = { k: 'k', bb: 'bb', h: 'hits', hr: 'hr' };
  const adjOf = { k: 'adjK', bb: 'adjBB', h: 'adjH', hr: 'adjHR' };
  const out = {};
  for (const m of ['k', 'bb', 'h', 'hr']) {
    const X = [], y = [], off = [];
    for (const i of usable) {
      const s = starts[i];
      const input = inputs.get(i);
      const lg = { ...input.lg };
      const o = input.opp;
      if (!o || o.kRate == null || o.bbRate == null || o.avg == null) continue;
      if (!(s.actual.bf > 0)) continue;
      const p = projectPitcher({ ...input, fit: { ...base, opp: null, cal: IDENTITY_CAL } });
      const rate = p.rates[adjOf[m]] / legacy[m](o, lg);
      X.push([1, L(o.kRate / lg.kRate), L(o.bbRate / lg.bbRate), L(o.avg / lg.avg)]);
      y.push(s.actual[statOf[m]]);
      off.push(L(s.actual.bf * rate));
    }
    const beta = poissonFit(X, y, X.map(() => 1), off, { ridge: 1e-5 });
    out[m] = { k: +beta[1].toFixed(4), bb: +beta[2].toFixed(4), h: +beta[3].toFixed(4) };
    console.log(`opp ${m.padEnd(3)} n=${y.length}  int=${beta[0].toFixed(4)}  oppK=${beta[1].toFixed(3)} oppBB=${beta[2].toFixed(3)} oppAvg=${beta[3].toFixed(3)}`);
  }
  return out;
}

// ── 2. calibration, per market ──────────────────────────────────────────────
//
// Regress what happened on the RAW projection over the same rows. The anchor is
// the fit-window mean projection, so the slope puts back exactly the spread the
// outcomes carry without moving the level; the level factor then sets the mean
// to the mean that happened. Both are measured, neither is chosen.
const MARKET_ACTUAL = { k: 'k', outs: 'outs', hits: 'hits', bb: 'bb', er: 'er' };
const PROJ_OF = { k: 'projK', outs: 'projOuts', hits: 'projH', bb: 'projBB', er: 'projER' };

const progressOf = (s) => (Date.parse(`${s.date}T00:00:00Z`) - Date.parse(`${s.season}-03-20T00:00:00Z`)) / 864e5 / 100;

function fitCalibration(usable, opp, base = PITCHER_FIT) {
  const cal = {};
  const progress = { ref: 0 };
  const raws = new Map();
  for (const i of usable) {
    raws.set(i, projectPitcher({ ...inputs.get(i), fit: { ...base, opp, cal: IDENTITY_CAL, progress: null } }));
  }
  progress.ref = +(usable.reduce((a, i) => a + progressOf(starts[i]), 0) / usable.length).toFixed(4);
  for (const m of Object.keys(MARKET_ACTUAL)) {
    const x = [], y = [];
    for (const i of usable) { x.push(raws.get(i)[PROJ_OF[m]]); y.push(starts[i].actual[MARKET_ACTUAL[m]]); }
    const n = x.length;
    const mx = x.reduce((a, b) => a + b, 0) / n;
    const my = y.reduce((a, b) => a + b, 0) / n;
    let sxy = 0, sxx = 0;
    for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; }
    const slope = Math.max(0.5, Math.min(2.5, sxy / Math.max(1e-9, sxx)));
    // Level and season drift together, on the spread-corrected projection:
    // E[y] = shrunk * exp(a + c * (progress - ref)). `a` is the level the flat
    // calibration would have found and `c` is what April and September differ
    // by; fitting them jointly keeps the level from absorbing the drift.
    const shrunk = x.map((v) => Math.max(1e-3, mx + slope * (v - mx)));
    const X = [], off = [];
    usable.forEach((i, j) => { X.push([1, progressOf(starts[i]) - progress.ref]); off.push(Math.log(shrunk[j])); });
    const beta = poissonFit(X, y, X.map(() => 1), off, { ridge: 1e-6 });
    cal[m] = [+mx.toFixed(4), +slope.toFixed(4), +Math.exp(beta[0]).toFixed(4)];
    progress[m] = +beta[1].toFixed(4);
    console.log(`cal ${m.padEnd(5)} anchor ${mx.toFixed(3)} slope ${slope.toFixed(3)} level ${Math.exp(beta[0]).toFixed(4)} drift ${beta[1].toFixed(4)}/100d  (proj ${mx.toFixed(2)} vs actual ${my.toFixed(2)})`);
  }
  return { cal, progress };
}

// ── inner split: fit on A, score on B, so the port can be checked before the
//    holdout is touched at all. ───────────────────────────────────────────────
const A = fitIdx.filter(inner);
const B = fitIdx.filter((i) => !inner(i));
const score = (idx, project) => scoreOutcomes(starts, idx, project);
const v1 = (i) => projectPitcherV1(inputs.get(i));
const v1team = (i) => projectPitcherV1(boardInput(raw, starts[i], lgCache, { teamOpp: true }));

/** Fit the coefficients on inner-A at these hyperparameters, score on inner-B. */
function evaluate(H, quiet = true) {
  const log = console.log;
  if (quiet) console.log = () => {};
  const { oppDrop, ...hyper } = H;
  const base = { ...PITCHER_FIT, ...hyper };
  const o = { ...fitOpponent(A, base), ...(oppDrop || {}) };
  const { cal: c, progress: pr } = fitCalibration(A, o, base);
  const F = { ...base, opp: o, cal: c, progress: pr };
  const sc = score(B, (i) => projectPitcher({ ...inputs.get(i), fit: F }));
  console.log = log;
  return { sc, F };
}

// The pooling strengths and the two decay constants, each scored on the market
// it governs — the study's own protocol (`GRID` in tools/pitcher-edge.mjs),
// because a strength that wrecks hits must not be able to buy its way back
// with a crumb somewhere else. One coordinate pass, on FIT only.
const GRID = {
  sK: [[70, 150, 250, 400, 700], 'k'],
  sBB: [[70, 80, 150, 250, 400], 'bb'],
  sH: [[70, 150, 400, 700, 1200], 'hits'],
  sHR: [[120, 200, 500, 1000], 'er'],
  tauRate: [[150, 250, 400, 800, 1e6], 'total'],
  tauWork: [[10, 20, 35, 60, 120], 'outs'],
};
const costOf = (sc, target) => (target === 'total' ? sc.total : sc[target].ll);
let H = {};
let cur = evaluate(H);
console.log(`
--- hyperparameters on inner-B (${B.length} starts): a diagnostic, NOT a search ---`);
console.log('The shipped values are the study’s own, reproduced by `pitcher-edge.mjs --stage fit`.');
console.log('This table is printed so the port cannot quietly sit somewhere the fit window hates.');
console.log(`study's values: ${JSON.stringify({ tauRate: PITCHER_FIT.tauRate, tauWork: PITCHER_FIT.tauWork, offDays: PITCHER_FIT.offDays, sK: PITCHER_FIT.sK, sBB: PITCHER_FIT.sBB, sH: PITCHER_FIT.sH, sHR: PITCHER_FIT.sHR })}`);
console.log(`start  total ll ${cur.sc.total.toFixed(5)}`);
for (const [key, [values, target]] of Object.entries(GRID)) {
  const cells = [];
  for (const v of values) {
    if (v === PITCHER_FIT[key]) { cells.push(`${v}=${costOf(cur.sc, target).toFixed(5)}*`); continue; }
    cells.push(`${v}=${costOf(evaluate({ ...H, [key]: v }).sc, target).toFixed(5)}`);
  }
  console.log(`${key.padEnd(8)} (${target}) ${cells.join('  ')}`);
}

// Which rates take the fitted opponent exponents: STRIKEOUTS ONLY.
//
// This is not a free choice, it is a known hazard. The Poisson fit above uses
// the start's REALISED batters faced as its exposure, and realised depth is a
// collider: a start where the opponent hit is a start that ended early, so
// within a slice of equal batters faced the opponent's batting average
// predicts FEWER hits than it should. The study hit the same wall from the
// other side and routed hits, walks and earned runs around it
// (docs/PITCHER-EDGE-SEARCH.md, "The one finding that changed the design").
// Strikeouts are the market where depth and the rate are near-orthogonal —
// K/outs is flat at 0.31 across every depth — and it is the one market the
// study measured a holdout gain in.
//
// It is also measured, and it makes no difference either way for the other
// three. Carrying all four fitted exponents scores 0.1549 / 0.1665 / 0.1846 /
// 0.1568 / 0.1820 on inner-B against 0.1549 / 0.1666 / 0.1846 / 0.1568 /
// 0.1820 with the strikeout one alone. A term worth nothing does not ship.
const SHIP_OPP = ['k'];
const oppDrop = Object.fromEntries(['k', 'bb', 'h', 'hr'].filter((m) => !SHIP_OPP.includes(m)).map((m) => [m, null]));
H = { oppDrop };
cur = evaluate(H);
console.log(`opponent exponents shipped for: ${SHIP_OPP.join(', ')}   total ll ${cur.sc.total.toFixed(5)}`);

console.log('\n--- fitted on inner-A ---');
const HYPER = { ...PITCHER_FIT };
const oppA = { ...fitOpponent(A, HYPER), ...oppDrop };
const { cal: calA, progress: progA } = fitCalibration(A, oppA, HYPER);
const innerFit = { ...HYPER, opp: oppA, cal: calA, progress: progA };
const ported = (i) => projectPitcher({ ...inputs.get(i), fit: innerFit });

console.log(`\n=== outcomes, inner-B (${B.length} starts): coefficients fitted on the ${A.length} before it ===`);
const sPort = score(B, ported);
const sV1 = score(B, v1);
const sV1t = score(B, v1team);
for (const m of Object.keys(SCORE_LINES)) {
  console.log(
    `${m.padEnd(5)} ported brier ${sPort[m].brier.toFixed(4)} ll ${sPort[m].ll.toFixed(4)} mean ${sPort[m].projMean.toFixed(2)} vs ${sPort[m].actMean.toFixed(2)}` +
    `   v36(board) ${sV1[m].brier.toFixed(4)} ll ${sV1[m].ll.toFixed(4)} mean ${sV1[m].projMean.toFixed(2)}` +
    `   v36(team opp) ${sV1t[m].brier.toFixed(4)} ll ${sV1t[m].ll.toFixed(4)}`,
  );
}
console.log(`total ll ported ${sPort.total.toFixed(5)}  v36(board) ${sV1.total.toFixed(5)}  v36(team opp) ${sV1t.total.toFixed(5)}`);

// ── ship: refit on the whole of FIT ─────────────────────────────────────────
console.log('\n--- refitted on the whole of FIT (what ships) ---');
const opp = { ...fitOpponent(fitIdx, HYPER), ...oppDrop };
const { cal, progress } = fitCalibration(fitIdx, opp, HYPER);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({
  split: { fit: `.. ${SPLIT.FIT_END}`, starts: fitIdx.length },
  hyper: H,
  inner: { opp: oppA, cal: calA, progress: progA, innerB: { ported: sPort, v36board: sV1, v36teamOpp: sV1t } },
  opp, cal, progress,
}, null, 1));
console.log(`\nwrote ${OUT}`);
console.log('opp:', JSON.stringify(opp));
console.log('cal:', JSON.stringify(cal));
console.log('progress:', JSON.stringify(progress));
